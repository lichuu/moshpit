import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LOGIN_LIMIT, LOGIN_WINDOW_MS, MAX_LIVE_SESSIONS, MAX_PASSWORD_BYTES, SESSION_MS } from "./auth.mjs";
import {
  createBrowserBoundary,
  createIdentitySecurity,
  MAX_PASSWORD_FILE_BYTES,
  PASSWORD_OWNER,
} from "./security.mjs";

const LOGIN = "you@example.com";
const PASSWORD = "file-held-secret";
const START = 1_800_000_000_000;
const ORIGIN = "https://workstation.example.ts.net";
const AUTHORITY = "workstation.example.ts.net";
const root = () => process.getuid?.() === 0;

function clock(start = START) {
  const time = { value: start };
  return { now: () => time.value, advance: (ms) => (time.value += ms), set: (ms) => (time.value = ms) };
}

async function temporaryDir(t, label = "identity") {
  const dir = await mkdtemp(path.join(os.tmpdir(), `moshpit-${label}-`));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function passwordFile(t, contents = `${PASSWORD}\n`, { mode = 0o600, name = "password" } = {}) {
  const file = path.join(await temporaryDir(t, "identity-file"), name);
  await writeFile(file, contents, { mode });
  await chmod(file, mode);
  return file;
}

/** Serve's forwarded request, as the boundary reads it: raw header pairs only. */
function request(pairs = [], { method = "POST", url = "/api/login" } = {}) {
  return { method, url, rawHeaders: pairs.flatMap(([name, value]) => [name, value]) };
}

const serve = (login = LOGIN, extra = []) => request([["tailscale-user-login", login], ...extra]);
const bearer = (token, extra = []) => request([["authorization", `Bearer ${token}`], ...extra]);

async function identity(env, time = clock()) {
  const security = await createIdentitySecurity({ env, now: time.now });
  return { security, time };
}

const passwordEnv = (file) =>
  createIdentitySecurity({
    env: { MOSHPIT_AUTH_MODE: "password", MOSHPIT_PASSWORD_FILE: file },
    now: clock().now,
  });

async function passwordMode(t) {
  return identity({ MOSHPIT_AUTH_MODE: "password", MOSHPIT_PASSWORD_FILE: await passwordFile(t) });
}

async function combinedMode(t) {
  return identity({
    MOSHPIT_AUTH_MODE: "tailscale+password",
    MOSHPIT_TRUSTED_USER: LOGIN,
    MOSHPIT_PASSWORD_FILE: await passwordFile(t),
  });
}

/** A candidate a careless client might send instead of the file's exact bytes. */
const nearby = (password) => (password.trim() === password ? `${password} ` : password.trim());

test("each explicit mode states its own policy, owner and required factors", async (t) => {
  const file = await passwordFile(t);
  const tailscale = await createIdentitySecurity({
    env: { MOSHPIT_AUTH_MODE: "tailscale", MOSHPIT_TRUSTED_USER: ` ${LOGIN} ` },
  });
  assert.deepEqual(tailscale.policy, { kind: "tailscale", login: LOGIN });
  assert.equal(tailscale.owner, LOGIN);
  assert.deepEqual(tailscale.authInfo(), { protocol: 2, requiredFactors: ["tailscale"] });

  const password = await createIdentitySecurity({
    env: { MOSHPIT_AUTH_MODE: "password", MOSHPIT_PASSWORD_FILE: file },
  });
  assert.deepEqual(password.policy, { kind: "password" });
  assert.equal(password.owner, PASSWORD_OWNER);
  assert.deepEqual(password.authInfo(), { protocol: 2, requiredFactors: ["password"] });

  const combined = await createIdentitySecurity({
    env: { MOSHPIT_AUTH_MODE: "tailscale+password", MOSHPIT_TRUSTED_USER: LOGIN, MOSHPIT_PASSWORD_FILE: file },
  });
  assert.deepEqual(combined.policy, { kind: "tailscale+password", login: LOGIN });
  assert.equal(combined.owner, LOGIN);
  assert.deepEqual(combined.authInfo(), { protocol: 2, requiredFactors: ["tailscale", "password"] });

  // Discovery says what to prove, never who or where.
  for (const security of [tailscale, password, combined]) {
    const info = security.authInfo();
    assert.deepEqual(Object.keys(info), ["protocol", "requiredFactors"]);
    assert.equal(JSON.stringify(info).includes(LOGIN), false);
    assert.equal(JSON.stringify(info).includes(PASSWORD), false);
    info.requiredFactors.push("device");
    assert.equal(security.authInfo().requiredFactors.includes("device"), false);
  }
  assert.equal(Object.isFrozen(tailscale.policy), true);
});

test("requesterLogin echoes only the caller's own single Serve login", async (t) => {
  const tailscale = await createIdentitySecurity({ env: { MOSHPIT_AUTH_MODE: "tailscale", MOSHPIT_TRUSTED_USER: LOGIN } });
  assert.equal(tailscale.requesterLogin(serve()), LOGIN);
  assert.equal(tailscale.requesterLogin(serve(" someone@example.com ")), "someone@example.com");
  assert.equal(tailscale.requesterLogin(request()), null, "no header says nothing, not the owner");
  assert.equal(tailscale.requesterLogin(request([["tailscale-user-login", LOGIN], ["tailscale-user-login", "x@example.com"]])), null);
  assert.equal(tailscale.requesterLogin(serve("")), null);
  assert.equal(tailscale.requesterLogin(serve("a".repeat(257))), null);
  assert.equal(tailscale.requesterLogin(serve("bad\u0007login")), null);
  const password = await createIdentitySecurity({ env: { MOSHPIT_AUTH_MODE: "password", MOSHPIT_PASSWORD_FILE: await passwordFile(t) } });
  assert.equal(password.requesterLogin(serve()), null, "password mode never reads the Serve header");
});

test("a missing or inexact mode stops startup", async (t) => {
  const file = await passwordFile(t);
  await assert.rejects(() => createIdentitySecurity({ env: {} }), { message: /MOSHPIT_AUTH_MODE is required/ });
  for (const mode of ["", " password ", "Password", "tailscale ", "password+tailscale", "both", "tailscale,password"])
    await assert.rejects(
      () => createIdentitySecurity({ env: { MOSHPIT_AUTH_MODE: mode, MOSHPIT_PASSWORD_FILE: file } }),
      { message: /must be exactly tailscale, password or tailscale\+password/ },
    );
  await assert.rejects(() => createIdentitySecurity({ env: { MOSHPIT_AUTH_MODE: "password" } }), {
    message: /MOSHPIT_PASSWORD_FILE is required in password mode/,
  });
});

test("identity settings that the mode does not use stop startup", async (t) => {
  const file = await passwordFile(t);
  const base = { MOSHPIT_AUTH_MODE: "tailscale", MOSHPIT_TRUSTED_USER: LOGIN };

  for (const trusted of [undefined, "", "   "])
    await assert.rejects(
      () => createIdentitySecurity({ env: { MOSHPIT_AUTH_MODE: "tailscale", MOSHPIT_TRUSTED_USER: trusted } }),
      { message: /MOSHPIT_TRUSTED_USER is required in tailscale mode/ },
    );
  for (const trusted of ["x".repeat(257), `${LOGIN}\nsomeone@example.com`])
    await assert.rejects(
      () => createIdentitySecurity({ env: { MOSHPIT_AUTH_MODE: "tailscale", MOSHPIT_TRUSTED_USER: trusted } }),
      { message: /MOSHPIT_TRUSTED_USER must be one printable login/ },
    );

  // An empty declaration is as ambiguous as a filled one: both are refused.
  for (const value of ["", LOGIN])
    await assert.rejects(
      () =>
        createIdentitySecurity({
          env: { MOSHPIT_AUTH_MODE: "password", MOSHPIT_PASSWORD_FILE: file, MOSHPIT_TRUSTED_USER: value },
        }),
      { message: /MOSHPIT_TRUSTED_USER has no meaning in password mode/ },
    );
  for (const value of ["", file])
    await assert.rejects(() => createIdentitySecurity({ env: { ...base, MOSHPIT_PASSWORD_FILE: value } }), {
      message: /MOSHPIT_PASSWORD_FILE has no meaning in tailscale mode/,
    });
});

test("the legacy password variable is refused in every explicit mode", async (t) => {
  const file = await passwordFile(t);
  const modes = [
    { MOSHPIT_AUTH_MODE: "tailscale", MOSHPIT_TRUSTED_USER: LOGIN },
    { MOSHPIT_AUTH_MODE: "password", MOSHPIT_PASSWORD_FILE: file },
    { MOSHPIT_AUTH_MODE: "tailscale+password", MOSHPIT_TRUSTED_USER: LOGIN, MOSHPIT_PASSWORD_FILE: file },
  ];
  for (const env of modes) {
    for (const legacy of ["", "   ", "shell-held-secret"]) {
      await assert.rejects(() => createIdentitySecurity({ env: { ...env, MOSHPIT_PASSWORD: legacy } }), (error) => {
        assert.match(error.message, /MOSHPIT_PASSWORD is no longer read/);
        assert.equal(error.message.includes("shell-held-secret"), false);
        return true;
      });
    }
  }
});

test("a password file that is not a private regular file is refused, unchanged", async (t) => {
  const missing = path.join(await temporaryDir(t, "identity-missing"), "password");
  await assert.rejects(() => passwordEnv(missing), { message: /does not exist/ });

  const directory = await temporaryDir(t, "identity-directory");
  await assert.rejects(() => passwordEnv(directory), { message: /is not a regular file/ });

  const socketDir = await temporaryDir(t, "identity-socket");
  const server = createServer();
  t.after(() => new Promise((resolve) => server.close(resolve)));
  server.listen(path.join(socketDir, "password"));
  await once(server, "listening");
  await assert.rejects(() => passwordEnv(path.join(socketDir, "password")), { message: /is not a regular file/ });

  const target = await passwordFile(t, `${PASSWORD}\n`, { name: "real" });
  const link = path.join(path.dirname(target), "linked");
  await symlink(target, link);
  await assert.rejects(() => passwordEnv(link), { message: /is a symbolic link/ });
  assert.equal(await readFile(target, "utf8"), `${PASSWORD}\n`);
  assert.equal((await stat(target)).mode & 0o777, 0o600);

  for (const mode of [0o644, 0o640, 0o604, 0o606]) {
    const file = await passwordFile(t, `${PASSWORD}\n`, { mode });
    const before = await stat(file);
    await assert.rejects(() => passwordEnv(file), (error) => {
      assert.match(error.message, /is readable beyond its owner/);
      assert.equal(error.message.includes(PASSWORD), false);
      return true;
    });
    const after = await stat(file);
    assert.equal(after.mode & 0o777, mode);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(await readFile(file, "utf8"), `${PASSWORD}\n`);
  }
});

test("a password file owned by another user is refused", { skip: root() }, async () => {
  const foreign = "/etc/passwd";
  const before = await stat(foreign);
  assert.notEqual(before.uid, process.getuid());
  await assert.rejects(() => passwordEnv(foreign), { message: /belongs to another user/ });
  const after = await stat(foreign);
  assert.equal(after.mode, before.mode);
  assert.equal(after.mtimeMs, before.mtimeMs);
});

test("a password file that holds no usable single-line secret is refused", async (t) => {
  for (const [contents, reason] of [
    ["", /is empty/],
    ["\n", /holds no password/],
    ["\r\n", /holds no password/],
    ["two\nlines\n", /must hold one line/],
    ["nul\0byte\n", /must hold one line/],
    ["carriage\rreturn\n", /must hold one line/],
    ["x".repeat(MAX_PASSWORD_FILE_BYTES + 1), new RegExp(`is larger than ${MAX_PASSWORD_FILE_BYTES} bytes`)],
    ["x".repeat(MAX_PASSWORD_BYTES + 1), new RegExp(`holds more than ${MAX_PASSWORD_BYTES} bytes`)],
  ]) {
    const file = await passwordFile(t, contents);
    await assert.rejects(() => passwordEnv(file), { message: reason });
    assert.equal(await readFile(file, "utf8"), contents);
  }

  const invalid = await passwordFile(t, Buffer.from([0x70, 0x77, 0xff, 0xfe, 0x0a]));
  await assert.rejects(() => passwordEnv(invalid), { message: /is not valid UTF-8/ });
});

test("one trailing newline ends the password and nothing else is trimmed", async (t) => {
  for (const [contents, password] of [
    [`${PASSWORD}\n`, PASSWORD],
    [`${PASSWORD}\r\n`, PASSWORD],
    [PASSWORD, PASSWORD],
    ["  spaced  \n", "  spaced  "],
    ["\ttabbed\t", "\ttabbed\t"],
    ["üñïçøde pass\n", "üñïçøde pass"],
  ]) {
    const security = await passwordEnv(await passwordFile(t, contents));
    assert.equal((await security.login(request(), password)).owner, PASSWORD_OWNER);
    await assert.rejects(() => security.login(request(), nearby(password)), { code: "password_required" });
  }
});

test("the password is read once, with no watcher on the file", async (t) => {
  const file = await passwordFile(t);
  const { security } = await identity({ MOSHPIT_AUTH_MODE: "password", MOSHPIT_PASSWORD_FILE: file });
  await writeFile(file, "rotated-secret\n", { mode: 0o600 });

  assert.equal((await security.login(request(), PASSWORD)).authSessionId.length, 22);
  await assert.rejects(() => security.login(request(), "rotated-secret"), { code: "password_required" });
});

test("tailscale mode accepts exactly one configured Serve login and nothing else", async () => {
  const { security } = await identity({ MOSHPIT_AUTH_MODE: "tailscale", MOSHPIT_TRUSTED_USER: LOGIN });

  assert.deepEqual(await security.requireIdentity(serve()), {
    owner: LOGIN,
    authSessionId: null,
    authExpiresAt: null,
  });

  const refused = [
    request(),
    serve("someone@example.com"),
    serve(`${LOGIN}.`),
    serve(LOGIN.toUpperCase()),
    serve(""),
    request([
      ["tailscale-user-login", LOGIN],
      ["tailscale-user-login", "someone@example.com"],
    ]),
    request([["tailscale-user-login", `${LOGIN}, ${LOGIN}`]]),
    request([["tailscale-user-name", LOGIN]]),
    request([["x-forwarded-user", LOGIN]]),
  ];
  for (const req of refused)
    await assert.rejects(() => security.requireIdentity(req), { status: 401, code: "identity_required" });

  await assert.rejects(() => security.login(serve(), "anything"), { status: 404, code: "login_unsupported" });
  await assert.rejects(() => security.logout(serve()), { status: 404, code: "logout_unsupported" });
});

test("password mode proves a session only through one Authorization Bearer header", async (t) => {
  const { security } = await passwordMode(t);
  const opened = await security.login(request(), PASSWORD);
  assert.deepEqual(Object.keys(opened).sort(), ["authExpiresAt", "authSessionId", "owner", "token"]);
  assert.equal(opened.owner, PASSWORD_OWNER);
  assert.equal(opened.authExpiresAt, START + SESSION_MS);

  const expected = { owner: PASSWORD_OWNER, authSessionId: opened.authSessionId, authExpiresAt: opened.authExpiresAt };
  assert.deepEqual(await security.requireIdentity(bearer(opened.token)), expected);
  assert.deepEqual(await security.requireIdentity(request([["authorization", `bearer ${opened.token}`]])), expected);

  const spoofed = [
    request([], { method: "GET", url: "/api/snapshot" }),
    request([["cookie", `moshpit=${opened.token}`]]),
    request([["cookie", `moshpit=${opened.token}`]], { method: "GET", url: `/api/snapshot?token=${opened.token}` }),
    request([], { method: "GET", url: `/api/snapshot?token=${opened.token}` }),
    request([["x-moshpit-device", `${"0".repeat(36)}.${"A".repeat(43)}`]]),
    bearer(opened.authSessionId),
    request([["authorization", opened.token]]),
    request([["authorization", `Basic ${opened.token}`]]),
    request([["authorization", "Bearer"]]),
    request([["authorization", `Bearer ${opened.token} extra`]]),
    request([["authorization", `Bearer ${opened.token}`.padEnd(200, "x")]]),
    request([
      ["authorization", `Bearer ${opened.token}`],
      ["authorization", `Bearer ${opened.token}`],
    ]),
    request([["authorization", `Bearer ${opened.token}, Bearer ${opened.token}`]]),
    request([["tailscale-user-login", LOGIN]]),
  ];
  for (const req of spoofed)
    await assert.rejects(() => security.requireIdentity(req), { status: 401, code: "password_required" });
});

test("combined mode checks the Serve login before it spends an attempt or verifies a password", async (t) => {
  const { security, time } = await combinedMode(t);

  for (let attempt = 0; attempt < LOGIN_LIMIT * 2; attempt++)
    await assert.rejects(() => security.login(serve("someone@example.com"), PASSWORD), {
      status: 401,
      code: "identity_required",
    });
  for (let attempt = 0; attempt < LOGIN_LIMIT; attempt++)
    await assert.rejects(() => security.login(serve(), "wrong"), { status: 401, code: "password_required" });
  await assert.rejects(() => security.login(serve(), PASSWORD), (error) => {
    assert.equal(error.status, 429);
    assert.equal(error.code, "rate_limited");
    assert.equal(error.retryAfter, LOGIN_WINDOW_MS / 1000);
    assert.equal(error.message.includes(PASSWORD), false);
    return true;
  });

  time.advance(LOGIN_WINDOW_MS);
  const opened = await security.login(serve(), PASSWORD);
  assert.equal(opened.owner, LOGIN);
  assert.deepEqual(await security.requireIdentity(serve(LOGIN, [["authorization", `Bearer ${opened.token}`]])), {
    owner: LOGIN,
    authSessionId: opened.authSessionId,
    authExpiresAt: opened.authExpiresAt,
  });
  await assert.rejects(() => security.requireIdentity(bearer(opened.token)), { code: "identity_required" });
  await assert.rejects(() => security.requireIdentity(serve()), { code: "password_required" });
});

test("forwarding headers neither partition nor bypass the attempt budget", async (t) => {
  const { security } = await passwordMode(t);
  for (let attempt = 0; attempt < LOGIN_LIMIT; attempt++)
    await assert.rejects(
      () =>
        security.login(
          request([
            ["x-forwarded-for", `10.0.0.${attempt}`],
            ["x-real-ip", `10.0.0.${attempt}`],
          ]),
          "wrong",
        ),
      { code: "password_required" },
    );
  await assert.rejects(
    () => security.login(request([["x-forwarded-for", "10.0.0.250"]]), PASSWORD),
    { status: 429, code: "rate_limited" },
  );
});

test("a ticket identity rechecks the referenced session without a bearer header", async (t) => {
  const { security, time } = await passwordMode(t);
  const opened = await security.login(request(), PASSWORD);
  const ticket = { owner: opened.owner, authSessionId: opened.authSessionId };

  // A WebSocket upgrade carries no Authorization header; the ticket's session
  // reference is what has to still be live.
  const upgrade = request([["origin", ORIGIN]], { method: "GET", url: "/pty?ticket=opaque" });
  assert.deepEqual(await security.requireActiveTicketOwner(upgrade, ticket), {
    owner: PASSWORD_OWNER,
    authSessionId: opened.authSessionId,
    authExpiresAt: opened.authExpiresAt,
  });

  for (const wrong of [undefined, null, {}, { owner: "someone@example.com", authSessionId: opened.authSessionId }])
    await assert.rejects(() => security.requireActiveTicketOwner(upgrade, wrong), {
      status: 401,
      code: "identity_required",
    });
  for (const missing of [null, undefined, "", opened.token, "A".repeat(22)])
    await assert.rejects(
      () => security.requireActiveTicketOwner(upgrade, { owner: PASSWORD_OWNER, authSessionId: missing }),
      { status: 401, code: "password_required" },
    );

  time.set(opened.authExpiresAt);
  await assert.rejects(() => security.requireActiveTicketOwner(upgrade, ticket), { code: "password_required" });
});

test("logout invalidates the session it names and leaves the others alone", async (t) => {
  const { security, time } = await passwordMode(t);
  const first = await security.login(request(), PASSWORD);
  const second = await security.login(request(), PASSWORD);

  assert.deepEqual(await security.logout(bearer(first.token)), {
    owner: PASSWORD_OWNER,
    authSessionId: first.authSessionId,
  });
  await assert.rejects(() => security.requireIdentity(bearer(first.token)), { code: "password_required" });
  await assert.rejects(() => security.logout(bearer(first.token)), { code: "password_required" });
  await assert.rejects(
    () =>
      security.requireActiveTicketOwner(request(), { owner: PASSWORD_OWNER, authSessionId: first.authSessionId }),
    { code: "password_required" },
  );
  assert.equal((await security.requireIdentity(bearer(second.token))).authSessionId, second.authSessionId);

  time.set(second.authExpiresAt - 1);
  assert.equal((await security.requireIdentity(bearer(second.token))).authExpiresAt, second.authExpiresAt);
  time.advance(1);
  await assert.rejects(() => security.requireIdentity(bearer(second.token)), { code: "password_required" });
});

test("a combined-mode ticket recheck needs the Serve identity again", async (t) => {
  const { security } = await combinedMode(t);
  const opened = await security.login(serve(), PASSWORD);
  const ticket = { owner: LOGIN, authSessionId: opened.authSessionId };
  const upgrade = (login) =>
    request([...(login === null ? [] : [["tailscale-user-login", login]]), ["origin", ORIGIN]], {
      method: "GET",
      url: "/pty?ticket=opaque",
    });

  assert.deepEqual(await security.requireActiveTicketOwner(upgrade(LOGIN), ticket), {
    owner: LOGIN,
    authSessionId: opened.authSessionId,
    authExpiresAt: opened.authExpiresAt,
  });
  for (const login of [null, "", "someone@example.com"])
    await assert.rejects(() => security.requireActiveTicketOwner(upgrade(login), ticket), {
      code: "identity_required",
    });
  await assert.rejects(
    () => security.requireActiveTicketOwner(upgrade(LOGIN), { owner: LOGIN, authSessionId: null }),
    { code: "password_required" },
  );
});

test("a restarted policy accepts no session the previous process issued", async (t) => {
  const file = await passwordFile(t);
  const env = { MOSHPIT_AUTH_MODE: "password", MOSHPIT_PASSWORD_FILE: file };
  const time = clock();
  const before = await createIdentitySecurity({ env, now: time.now });
  const opened = await before.login(request(), PASSWORD);

  const after = await createIdentitySecurity({ env, now: time.now });
  await assert.rejects(() => after.requireIdentity(bearer(opened.token)), { code: "password_required" });
  await assert.rejects(
    () => after.requireActiveTicketOwner(request(), { owner: PASSWORD_OWNER, authSessionId: opened.authSessionId }),
    { code: "password_required" },
  );
  assert.equal((await after.login(request(), PASSWORD)).owner, PASSWORD_OWNER);
});

test("mixed-case raw header names authenticate in combined mode, and cased duplicates still reject", async (t) => {
  const { security } = await combinedMode(t);
  const opened = await security.login(serve(), PASSWORD);
  assert.deepEqual(
    await security.requireIdentity(
      request([["Tailscale-User-Login", LOGIN], ["Authorization", `Bearer ${opened.token}`]]),
    ),
    { owner: LOGIN, authSessionId: opened.authSessionId, authExpiresAt: opened.authExpiresAt },
  );
  await assert.rejects(
    () =>
      security.requireIdentity(
        request([
          ["tailscale-user-login", LOGIN],
          ["Tailscale-User-Login", LOGIN],
          ["Authorization", `Bearer ${opened.token}`],
        ]),
      ),
    { status: 401, code: "identity_required" },
  );
  await assert.rejects(
    () =>
      security.requireIdentity(
        request([
          ["Tailscale-User-Login", LOGIN],
          ["Authorization", `Bearer ${opened.token}`],
          ["AUTHORIZATION", `Bearer ${opened.token}`],
        ]),
      ),
    { status: 401, code: "password_required" },
  );
});

test("the live session quota denies the next login without evicting or echoing", async (t) => {
  const { security, time } = await passwordMode(t);
  const issued = [];
  for (let attempt = 0; attempt < MAX_LIVE_SESSIONS; attempt++) {
    issued.push(await security.login(request(), PASSWORD));
    if ((attempt + 1) % LOGIN_LIMIT === 0) time.advance(LOGIN_WINDOW_MS);
  }
  await assert.rejects(() => security.login(request(), PASSWORD), (error) => {
    assert.equal(error.status, 429);
    assert.equal(error.code, "quota_exceeded");
    assert.equal(error.message.includes(PASSWORD), false);
    return true;
  });
  const first = issued[0];
  assert.deepEqual(await security.requireIdentity(bearer(first.token)), {
    owner: PASSWORD_OWNER,
    authSessionId: first.authSessionId,
    authExpiresAt: first.authExpiresAt,
  });
  assert.deepEqual(await security.logout(bearer(first.token)), { owner: PASSWORD_OWNER, authSessionId: first.authSessionId });
  const next = await security.login(request(), PASSWORD);
  assert.equal((await security.requireIdentity(bearer(next.token))).authSessionId, next.authSessionId);
  await assert.rejects(
    () => security.requireActiveTicketOwner(request(), { owner: PASSWORD_OWNER, authSessionId: first.authSessionId }),
    { status: 401, code: "password_required" },
  );
});

/** The identity unit changes no browser admission rule; these assert the current one. */
test("the browser boundary still decides admission exactly as before", async (t) => {
  t.mock.method(console, "error", () => {});
  const boundary = createBrowserBoundary({
    MOSHPIT_PUBLIC_ORIGIN: ORIGIN,
    MOSHPIT_ALLOWED_AUTHORITIES: AUTHORITY,
  });
  const cors = {
    "access-control-allow-origin": ORIGIN,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization, x-moshpit-device",
    vary: "origin",
  };
  const http = (pairs, options) => boundary.check(request(pairs, options), "http");
  const host = (value = AUTHORITY) => ["host", value];
  const json = ["content-type", "application/json"];
  const origin = ["origin", ORIGIN];

  assert.deepEqual(http([host(), origin, json]), { pathname: "/api/login", headers: cors, preflight: false });
  assert.deepEqual(http([host(), origin], { method: "GET", url: "/api/snapshot" }), {
    pathname: "/api/snapshot",
    headers: cors,
    preflight: false,
  });
  assert.deepEqual(http([host(), ["sec-fetch-site", "same-origin"]], { method: "GET", url: "/api/snapshot" }), {
    pathname: "/api/snapshot",
    headers: { vary: "origin" },
    preflight: false,
  });
  assert.deepEqual(http([host()], { method: "GET", url: "/index.html" }), {
    pathname: "/index.html",
    headers: {},
    preflight: false,
  });
  assert.deepEqual(
    http([host(), origin, ["access-control-request-method", "POST"], ["access-control-request-headers", "authorization"]], {
      method: "OPTIONS",
    }),
    { pathname: "/api/login", headers: cors, preflight: true },
  );

  assert.throws(() => http([host("attacker.example.com"), origin, json]), { status: 403, message: "host not allowed" });
  assert.throws(() => http([host(), host(), origin, json]), { status: 403, message: "host not allowed" });
  assert.throws(
    () => http([host("attacker.example.com"), ["x-forwarded-host", AUTHORITY], origin, json]),
    { status: 403, message: "host not allowed" },
  );
  assert.throws(() => http([host(), ["origin", "https://attacker.example.com"], json]), {
    status: 403,
    message: "origin not allowed",
  });
  assert.throws(() => http([host(), origin, origin, json]), { status: 403, message: "origin not allowed" });
  assert.throws(() => http([host(), json]), { status: 403, message: "origin not allowed" });
  assert.throws(() => http([host()], { method: "GET", url: "/api/snapshot" }), {
    status: 403,
    message: "origin not allowed",
  });
  assert.throws(() => http([host(), origin, ["content-type", "text/plain"]]), {
    status: 415,
    message: "unsupported media type",
  });
  assert.throws(() => http([host(), origin, json], { method: "DELETE" }), {
    status: 405,
    message: "method not allowed",
  });
  assert.throws(
    () => http([host(), origin, ["access-control-request-method", "POST"], ["access-control-request-headers", "cookie"]], { method: "OPTIONS" }),
    { status: 403, message: "preflight not allowed" },
  );
  assert.throws(
    () => http([host(), origin, ["access-control-request-method", "DELETE"]], { method: "OPTIONS" }),
    { status: 403, message: "preflight not allowed" },
  );

  const upgrade = (pairs, url = "/pty") => boundary.check(request(pairs, { method: "GET", url }), "websocket");
  assert.deepEqual(upgrade([host(), origin]), { pathname: "/pty", headers: {}, preflight: false });
  assert.throws(() => upgrade([host()]), { status: 403, message: "origin not allowed" });
  assert.throws(() => upgrade([host(), origin], "/api/snapshot"), { status: 404, message: "not found" });

  assert.throws(() => createBrowserBoundary({ MOSHPIT_ALLOWED_AUTHORITIES: AUTHORITY }), {
    message: /MOSHPIT_PUBLIC_ORIGIN is required/,
  });
  assert.throws(() => createBrowserBoundary({ MOSHPIT_PUBLIC_ORIGIN: ORIGIN }), {
    message: /MOSHPIT_ALLOWED_AUTHORITIES is required/,
  });
  assert.throws(
    () => createBrowserBoundary({ MOSHPIT_PUBLIC_ORIGIN: "http://127.0.0.1:8787", MOSHPIT_ALLOWED_AUTHORITIES: AUTHORITY }),
    { message: /must use https/ },
  );
});
