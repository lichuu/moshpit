import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { boundaryEnv, bridgeCommand, freePort, pairDevice, passwordEnv, terminalTicket } from "./test-support.mjs";

const PASSWORD = "fixture-pass";
const JSON_TYPE = "application/json";

// The fixture records every herdr call. These are the read-only shapes the
// bridge polls on its own, so anything else in the log is a command a request
// pushed to the host.
const READ_ONLY = new Set([
  "api snapshot",
  "pane list",
  "pane read",
  "pane layout",
  "worktree list",
  "agent read",
]);

const HERDR_FIXTURE = `#!${process.execPath}
import { appendFileSync } from "node:fs";
const a = process.argv.slice(2);
appendFileSync(process.env.HERDR_CALLS, JSON.stringify(a) + "\\n");
if (a[0] === "api") console.log(JSON.stringify({ result: { snapshot: { agents: [
  { pane_id: "pane-a", agent: "codex", agent_status: "idle", cwd: "" },
  { pane_id: "pane-b", agent: "codex", agent_status: "idle", cwd: "" }
] } } }));
else if (a[0] === "pane" && a[1] === "list") console.log(JSON.stringify({ result: { panes: [{ pane_id: "pane-a", terminal_id: "term-a" }, { pane_id: "pane-b", terminal_id: "term-b" }] } }));
else if (a[0] === "pane" && a[1] === "layout") console.log(JSON.stringify({ result: { layout: { area: { width: 80, height: 24 } } } }));
else if (a[0] === "pane" && a[1] === "read") console.log("pane " + a[2] + "\\n");
else if (a[0] === "terminal" && a[1] === "session" && a[2] === "control") {
  process.stdin.on("data", (c) => appendFileSync(process.env.HERDR_CTRL, String(c)));
  setTimeout(() => {}, 30000);
}
else console.log("{}");
`;

/** A real password or allowlist in the shell must not reach an isolated bridge. */
function baseEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("MOSHPIT_") && key !== "HERDR_CALLS") env[key] = value;
  }
  return env;
}

async function scratchDir() {
  return mkdtemp(path.join(tmpdir(), "moshpit-security-"));
}

async function spawnBridge(t, dir, env, herdr = HERDR_FIXTURE) {
  const bin = path.join(dir, "herdr-fixture");
  const callLog = path.join(dir, "herdr-calls.jsonl");
  const ctrlLog = path.join(dir, "herdr-ctrl.jsonl");
  await writeFile(callLog, "");
  await writeFile(ctrlLog, "");
  await writeFile(bin, herdr, { mode: 0o700 });
  await writeFile(path.join(dir, "package.json"), '{"type":"module"}');
  const child = spawn(...bridgeCommand(), {
    env: {
      ...baseEnv(),
      MOSHPIT_BIND: "127.0.0.1",
      MOSHPIT_STATE_DIR: path.join(dir, "state"),
      MOSHPIT_HERDR_BIN: bin,
      MOSHPIT_POLL_MS: "600000",
      HERDR_CALLS: callLog,
      HERDR_CTRL: ctrlLog,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = [];
  const err = [];
  child.stdout.on("data", (chunk) => out.push(String(chunk)));
  child.stderr.on("data", (chunk) => err.push(String(chunk)));
  // Attached now, not in the hook: a bridge that rejects its configuration is
  // already gone by then, and a fresh listener would wait for an event that
  // has already fired.
  const exited = once(child, "exit").then(([code]) => code ?? 0);
  // Kill first. An earlier rm after-hook that throws ENOTEMPTY skips this
  // one, and the leftover child holds the job until the 20m CI timeout.
  t.after(async () => {
    child.kill("SIGKILL");
    await exited.catch(() => {});
    await rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  });
  return {
    child,
    callLog,
    ctrlLog,
    exited,
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
}

async function startBridge(t, { env = {}, herdr, dir: reuse } = {}) {
  // Reusing a directory restarts a bridge on the state an earlier one left.
  const dir = reuse ?? await scratchDir();
  // freePort releases each port before returning, so two calls can hand back
  // the same one. A hostile origin that happened to equal an allowed one was
  // allowed, and the origin checks failed at random.
  const ports = new Set();
  while (ports.size < 3) ports.add(await freePort());
  const [port, uiPort, hostilePort] = ports;
  const origin = `http://127.0.0.1:${port}`;
  const ui = `http://127.0.0.1:${uiPort}`;
  const hostile = `http://127.0.0.1:${hostilePort}`;
  const process_ = await spawnBridge(
    t,
    dir,
    {
      ...boundaryEnv(port),
      ...await passwordEnv(dir, PASSWORD),
      MOSHPIT_ALLOWED_ORIGINS: `${origin},${ui}`,
      ...env,
    },
    herdr,
  );
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (process_.child.exitCode !== null) {
      throw new Error(`bridge exited ${process_.child.exitCode}: ${process_.stderr()}`);
    }
    try {
      await fetch(`${origin}/api/vapid`, { headers: { origin } });
      break;
    } catch {
      if (Date.now() > deadline) throw new Error(`bridge never listened on ${port}`);
      await delay(50);
    }
  }
  const calls = async () =>
    (await readFile(process_.callLog, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((row) => JSON.parse(row));
  const bridge = {
    ...process_,
    port,
    dir,
    stateDir: path.join(dir, "state"),
    origin,
    ui,
    hostile,
    calls,
    ctrl: async () =>
      (await readFile(process_.ctrlLog, "utf8")).split("\n").filter(Boolean),
    mutations: async () =>
      (await calls()).filter((row) => !READ_ONLY.has(`${row[0]} ${row[1]}`) && !(row[0] === "terminal" && row[1] === "session")),
    request(pathname, { method = "GET", origin: from = origin, headers = {}, body } = {}) {
      const sent = { ...headers };
      if (from !== null) sent.origin = from;
      if (body !== undefined && sent["content-type"] === undefined) sent["content-type"] = JSON_TYPE;
      return fetch(`${origin}${pathname}`, {
        method,
        headers: sent,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    },
  };
  return bridge;
}

async function authorize(bridge) {
  const res = await bridge.request("/api/login", { method: "POST", body: { password: PASSWORD } });
  assert.equal(res.status, 200);
  const { token } = await res.json();
  const headers = { authorization: `Bearer ${token}` };
  headers["x-moshpit-device"] = await pairDevice(bridge.origin, headers, { stateDir: bridge.stateDir });
  return { token, headers };

}

function rawRequest(port, lines, body = "") {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(`${lines.join("\r\n")}\r\n\r\n${body}`);
    });
    const chunks = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    socket.setTimeout(2000, finish);
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    socket.on("close", finish);
  });
}

const statusOf = (raw) => Number(raw.slice(9, 12));

function maskFrame(payload, opcode = 1, { fin = true } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  const mask = crypto.randomBytes(4);
  const masked = Buffer.from(data);
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];
  let header;
  const first = (fin ? 0x80 : 0) | opcode;
  if (data.length < 126) {
    header = Buffer.from([first, 0x80 | data.length]);
  } else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = first;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = first;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  return Buffer.concat([header, mask, masked]);
}

/** Server frames are never masked, so this only has to read that shape. */
function decodeServerFrames(buf, { close = false } = {}) {
  const payloads = [];
  let offset = 0;
  while (offset + 2 <= buf.length) {
    const opcode = buf[offset] & 0x0f;
    let len = buf[offset + 1] & 0x7f;
    let i = offset + 2;
    if (len === 126) {
      if (i + 2 > buf.length) break;
      len = buf.readUInt16BE(i);
      i += 2;
    } else if (len === 127) {
      if (i + 8 > buf.length) break;
      len = Number(buf.readBigUInt64BE(i));
      i += 8;
    }
    if (i + len > buf.length) break;
    if (opcode === 1) payloads.push(buf.subarray(i, i + len).toString("utf8"));
    if (opcode === 8 && close) return { code: len >= 2 ? buf.readUInt16BE(i) : 1005 };
    offset = i + len;
  }
  return close ? null : payloads;
}

async function openPty(t, bridge, query, { origin = bridge.origin, host } = {}) {
  const socket = connect(bridge.port, "127.0.0.1");
  await once(socket, "connect");
  t.after(() => socket.destroy());
  let received = Buffer.alloc(0);
  let closeCode = null;
  socket.on("data", (chunk) => {
    received = Buffer.concat([received, chunk]);
    // Answer the server's close frame, as a browser does, so the closing
    // handshake completes and the server drops the connection.
    const head = received.indexOf("\r\n\r\n");
    if (closeCode === null && head !== -1) {
      const closing = decodeServerFrames(received.subarray(head + 4), { close: true });
      if (closing) {
        closeCode = closing.code;
        const reply = Buffer.alloc(2);
        reply.writeUInt16BE(closeCode === 1005 ? 1000 : closeCode);
        socket.end(maskFrame(reply, 8));
      }
    }
  });
  socket.on("error", () => {});
  const lines = [
    `GET /pty?${query} HTTP/1.1`,
    `Host: ${host ?? `127.0.0.1:${bridge.port}`}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString("base64")}`,
    "Sec-WebSocket-Version: 13",
    ...(origin === null ? [] : [`Origin: ${origin}`]),
  ];
  socket.write(`${lines.join("\r\n")}\r\n\r\n`);
  const deadline = Date.now() + 5000;
  while (received.indexOf("\r\n\r\n") === -1 && !socket.destroyed && Date.now() < deadline) {
    await delay(10);
  }
  const head = received.indexOf("\r\n\r\n");
  const status = head === -1 ? 0 : statusOf(received.subarray(0, head).toString("utf8"));
  return {
    socket,
    status,
    head: head === -1 ? "" : received.subarray(0, head).toString("utf8"),
    send: (value) => socket.write(maskFrame(typeof value === "string" ? value : JSON.stringify(value))),
    frames: () =>
      decodeServerFrames(received.subarray(head === -1 ? received.length : head + 4)).map((payload) => {
        try {
          return JSON.parse(payload);
        } catch {
          return { raw: payload };
        }
      }),
    closed: () => closeCode !== null || socket.destroyed || socket.readyState === "closed",
    closeCode: () => closeCode,
  };
}

test("the bridge refuses to start without an exact origin and authority policy", { timeout: 60000 }, async (t) => {
  const cases = [
    { name: "no public origin", env: { MOSHPIT_ALLOWED_AUTHORITIES: "host.example" } },
    { name: "no authorities", env: { MOSHPIT_PUBLIC_ORIGIN: "https://host.example" } },
    { name: "origin with a path", env: { MOSHPIT_PUBLIC_ORIGIN: "https://host.example/app", MOSHPIT_ALLOWED_AUTHORITIES: "host.example" } },
    { name: "origin with credentials", env: { MOSHPIT_PUBLIC_ORIGIN: "https://user:pw@host.example", MOSHPIT_ALLOWED_AUTHORITIES: "host.example" } },
    { name: "origin with a query", env: { MOSHPIT_PUBLIC_ORIGIN: "https://host.example?a=1", MOSHPIT_ALLOWED_AUTHORITIES: "host.example" } },
    { name: "wildcard origin", env: { MOSHPIT_PUBLIC_ORIGIN: "https://*.host.example", MOSHPIT_ALLOWED_AUTHORITIES: "host.example" } },
    { name: "insecure origin without the development flag", env: { MOSHPIT_PUBLIC_ORIGIN: "http://127.0.0.1:8787", MOSHPIT_ALLOWED_AUTHORITIES: "127.0.0.1:8787" } },
    { name: "non-loopback insecure origin in development", env: { MOSHPIT_PUBLIC_ORIGIN: "http://host.example", MOSHPIT_ALLOWED_AUTHORITIES: "host.example", MOSHPIT_DEV_INSECURE: "1" } },
    { name: "authority written as a URL", env: { MOSHPIT_PUBLIC_ORIGIN: "https://host.example", MOSHPIT_ALLOWED_AUTHORITIES: "https://host.example" } },
    { name: "authority with a trailing dot", env: { MOSHPIT_PUBLIC_ORIGIN: "https://host.example", MOSHPIT_ALLOWED_AUTHORITIES: "host.example." } },
    { name: "authority with an invalid port", env: { MOSHPIT_PUBLIC_ORIGIN: "https://host.example", MOSHPIT_ALLOWED_AUTHORITIES: "host.example:99999" } },
    { name: "empty authority list member", env: { MOSHPIT_PUBLIC_ORIGIN: "https://host.example", MOSHPIT_ALLOWED_AUTHORITIES: "host.example,," } },
    { name: "malformed extra allowed origin", env: { MOSHPIT_PUBLIC_ORIGIN: "https://host.example", MOSHPIT_ALLOWED_AUTHORITIES: "host.example", MOSHPIT_ALLOWED_ORIGINS: "https://ui.example,not-an-origin" } },
  ];
  for (const { name, env } of cases) {
    const dir = await scratchDir();
    const bridge = await spawnBridge(t, dir, {
      MOSHPIT_PORT: String(await freePort()),
      ...await passwordEnv(dir, PASSWORD),
      ...env,
    });
    const code = await bridge.exited;
    assert.equal(code, 1, `${name} should stop startup, stderr: ${bridge.stderr()}`);
    assert.match(bridge.stderr(), /MOSHPIT_(PUBLIC_ORIGIN|ALLOWED_ORIGINS|ALLOWED_AUTHORITIES)/, name);
  }
});

test("only a configured origin reaches the API", { timeout: 30000 }, async (t) => {
  const bridge = await startBridge(t);
  const { headers } = await authorize(bridge);

  const allowed = await bridge.request("/api/snapshot", { headers, origin: bridge.ui });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get("access-control-allow-origin"), bridge.ui);
  assert.equal(allowed.headers.get("vary"), "origin");

  const rejected = [
    bridge.hostile,
    "null",
    "https://evil.test",
    `https://127.0.0.1:${bridge.port}`,
    `http://127.0.0.1:${bridge.port + 1}`,
    `http://127.0.0.11:${bridge.port}`,
    `http://127.0.0.1:${bridge.port}/`,
    `http://127.0.0.1:${bridge.port}/api`,
    `http://127.0.0.1:${bridge.port}.evil.test`,
    `HTTP://127.0.0.1:${bridge.port}`,
  ];
  for (const origin of rejected) {
    const res = await bridge.request("/api/snapshot", { headers, origin });
    assert.equal(res.status, 403, `origin ${origin} must be refused`);
    assert.equal(res.headers.get("access-control-allow-origin"), null, `origin ${origin} must get no CORS grant`);
  }

  const mutating = await bridge.request("/api/action", {
    method: "POST",
    headers,
    origin: bridge.hostile,
    body: { kind: "close", target: "pane-a" },
  });
  assert.equal(mutating.status, 403);
  assert.deepEqual(await bridge.mutations(), []);
});

test("the same-origin exception covers reads only", { timeout: 30000 }, async (t) => {
  const bridge = await startBridge(t);
  const { headers } = await authorize(bridge);

  const read = await bridge.request("/api/snapshot", {
    headers: { ...headers, "sec-fetch-site": "same-origin" },
    origin: null,
  });
  assert.equal(read.status, 200);

  const withoutMetadata = await bridge.request("/api/snapshot", { headers, origin: null });
  assert.equal(withoutMetadata.status, 403);

  const crossSite = await bridge.request("/api/snapshot", {
    headers: { ...headers, "sec-fetch-site": "cross-site" },
    origin: null,
  });
  assert.equal(crossSite.status, 403);

  // Fetch metadata never rescues an origin the policy already refused.
  const disallowedWithMetadata = await bridge.request("/api/snapshot", {
    headers: { ...headers, "sec-fetch-site": "same-origin" },
    origin: bridge.hostile,
  });
  assert.equal(disallowedWithMetadata.status, 403);

  const mutation = await bridge.request("/api/action", {
    method: "POST",
    headers: { ...headers, "sec-fetch-site": "same-origin" },
    origin: null,
    body: { kind: "close", target: "pane-a" },
  });
  assert.equal(mutation.status, 403);
  assert.deepEqual(await bridge.mutations(), []);
});

test("JSON mutations require the JSON content type", { timeout: 30000 }, async (t) => {
  const bridge = await startBridge(t);
  const { headers } = await authorize(bridge);

  for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]) {
    const res = await bridge.request("/api/action", {
      method: "POST",
      headers: { ...headers, "content-type": type },
      body: { kind: "close", target: "pane-a" },
    });
    assert.equal(res.status, 415, `${type} must be refused`);
  }
  assert.deepEqual(await bridge.mutations(), []);

  const charset = await bridge.request("/api/action", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json; charset=utf-8" },
    body: { kind: "close", target: "pane-a" },
  });
  assert.equal(charset.status, 200);
  assert.deepEqual(await bridge.mutations(), [["pane", "close", "pane-a"]]);
});

test("login and pairing are behind the same origin policy", { timeout: 30000 }, async (t) => {
  const bridge = await startBridge(t);

  const hostileLogin = await bridge.request("/api/login", {
    method: "POST",
    origin: bridge.hostile,
    body: { password: PASSWORD },
  });
  assert.equal(hostileLogin.status, 403);
  assert.equal(hostileLogin.headers.get("access-control-allow-origin"), null);
  assert.equal(hostileLogin.headers.get("set-cookie"), null);

  const originlessLogin = await bridge.request("/api/login", {
    method: "POST",
    origin: null,
    headers: { "sec-fetch-site": "same-origin" },
    body: { password: PASSWORD },
  });
  assert.equal(originlessLogin.status, 403);

  const { headers } = await authorize(bridge);
  const hostilePair = await bridge.request("/api/devices/pair", {
    method: "POST",
    headers,
    origin: bridge.hostile,
    body: { name: "hostile-device" },
  });
  assert.equal(hostilePair.status, 403);
  const devices = JSON.parse(await readFile(path.join(bridge.dir, "state", "devices.json"), "utf8"));
  assert.deepEqual(
    devices.devices.map((device) => device.id),
    [headers["x-moshpit-device"].split(".")[0]],
  );
});

test("preflights answer only for the allowed origin, method and headers", { timeout: 30000 }, async (t) => {
  const bridge = await startBridge(t);

  const ok = await bridge.request("/api/action", {
    method: "OPTIONS",
    origin: bridge.ui,
    headers: {
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type, X-Moshpit-Device, authorization",
    },
  });
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get("access-control-allow-origin"), bridge.ui);
  assert.equal(ok.headers.get("access-control-allow-methods"), "GET, POST, OPTIONS");
  assert.equal(
    ok.headers.get("access-control-allow-headers"),
    "content-type, authorization, x-moshpit-device",
  );

  // A browser must never be able to advertise a Tailscale identity.
  const identity = await bridge.request("/api/action", {
    method: "OPTIONS",
    origin: bridge.ui,
    headers: {
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type, tailscale-user-login",
    },
  });
  assert.equal(identity.status, 403);
  assert.equal(identity.headers.get("access-control-allow-origin"), null);

  const badMethod = await bridge.request("/api/action", {
    method: "OPTIONS",
    origin: bridge.ui,
    headers: { "access-control-request-method": "DELETE" },
  });
  assert.equal(badMethod.status, 403);

  const hostile = await bridge.request("/api/action", {
    method: "OPTIONS",
    origin: bridge.hostile,
    headers: { "access-control-request-method": "POST" },
  });
  assert.equal(hostile.status, 403);
  assert.equal(hostile.headers.get("access-control-allow-origin"), null);
});

test("an allowed origin keeps its CORS grant on unauthenticated answers", { timeout: 30000 }, async (t) => {
  const bridge = await startBridge(t);
  const res = await bridge.request("/api/snapshot", { origin: bridge.ui });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("access-control-allow-origin"), bridge.ui);
});

test("Host is validated before anything else and forwarding headers never rescue it", { timeout: 30000 }, async (t) => {
  const bridge = await startBridge(t);
  const { headers } = await authorize(bridge);

  const spoofed = await rawRequest(bridge.port, [
    "GET /api/snapshot HTTP/1.1",
    "Host: evil.test",
    `Origin: ${bridge.origin}`,
    `Authorization: ${headers.authorization}`,
    `X-Forwarded-Host: 127.0.0.1:${bridge.port}`,
    `Forwarded: host=127.0.0.1:${bridge.port}`,
    "Connection: close",
  ]);
  assert.equal(statusOf(spoofed), 403);

  const missingHost = await rawRequest(bridge.port, [
    "GET /api/snapshot HTTP/1.1",
    `Origin: ${bridge.origin}`,
    "Connection: close",
  ]);
  assert.ok([400, 403].includes(statusOf(missingHost)), `missing Host answered ${statusOf(missingHost)}`);
  assert.doesNotMatch(missingHost, /TypeError|Cannot read properties/);

  const staticSpoof = await rawRequest(bridge.port, [
    "GET / HTTP/1.1",
    "Host: evil.test",
    "Connection: close",
  ]);
  assert.equal(statusOf(staticSpoof), 403);

  assert.deepEqual(await bridge.mutations(), []);
});

test("duplicate Host and Origin headers are refused", { timeout: 30000 }, async (t) => {
  const bridge = await startBridge(t);
  const { headers } = await authorize(bridge);
  const authority = `127.0.0.1:${bridge.port}`;

  const duplicateOrigin = await rawRequest(bridge.port, [
    "GET /api/snapshot HTTP/1.1",
    `Host: ${authority}`,
    `Origin: ${bridge.origin}`,
    "Origin: https://evil.test",
    `Authorization: ${headers.authorization}`,
    "Connection: close",
  ]);
  assert.equal(statusOf(duplicateOrigin), 403);

  const duplicateHost = await rawRequest(bridge.port, [
    "GET /api/snapshot HTTP/1.1",
    `Host: ${authority}`,
    "Host: evil.test",
    `Origin: ${bridge.origin}`,
    `Authorization: ${headers.authorization}`,
    "Connection: close",
  ]);
  assert.ok(statusOf(duplicateHost) >= 400, `duplicate Host answered ${statusOf(duplicateHost)}`);
});

test("static assets and the API stay separate", { timeout: 30000 }, async (t) => {
  const bridge = await startBridge(t);
  const { headers } = await authorize(bridge);

  // A navigation carries no Origin, and the app has to load anyway.
  const navigation = await bridge.request("/", { origin: null });
  const body = await navigation.text();
  assert.ok(
    navigation.status === 200 || (navigation.status === 404 && body === "spa not built"),
    `static navigation answered ${navigation.status}: ${body.slice(0, 80)}`,
  );

  const staticWrite = await bridge.request("/", { method: "POST", origin: null, body: {} });
  assert.equal(staticWrite.status, 405);

  // An unknown API path is an API answer, never the single-page fallback.
  const unknown = await bridge.request("/api/nope", { headers });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.headers.get("content-type"), "application/json");
  assert.deepEqual(await unknown.json(), { error: { code: "request_invalid", message: "not found" } });

  const unknownWithoutAuth = await bridge.request("/api/nope", { origin: bridge.hostile });
  assert.equal(unknownWithoutAuth.status, 403);
});

// pane list reads HERDR_PANES when it exists, so a test can close or replace
// a pane between issuing a ticket and upgrading with it.
const HERDR_PANES_FIXTURE = HERDR_FIXTURE.replace(
  `else if (a[0] === "pane" && a[1] === "list")`,
  `else if (a[0] === "pane" && a[1] === "list" && process.env.HERDR_PANES && existsSync(process.env.HERDR_PANES)) console.log(readFileSync(process.env.HERDR_PANES, "utf8"));
else if (a[0] === "pane" && a[1] === "list")`,
).replace(`import { appendFileSync } from "node:fs";`, `import { appendFileSync, existsSync, readFileSync } from "node:fs";`);

test("an upgrade re-reads its terminal and refuses a closed or replaced pane", { timeout: 30000 }, async (t) => {
  const panes = path.join(await scratchDir(), "panes.json");
  const bridge = await startBridge(t, { herdr: HERDR_PANES_FIXTURE, env: { HERDR_PANES: panes } });
  const { headers } = await authorize(bridge);
  const list = (entries) => writeFile(panes, JSON.stringify({ result: { panes: entries } }));
  const both = [{ pane_id: "pane-a", terminal_id: "term-a" }, { pane_id: "pane-b", terminal_id: "term-b" }];

  // Issued, then the pane closes before the upgrade. The pane cache would
  // still remember it for five seconds; the upgrade must not.
  const closed = await terminalTicket(bridge.origin, headers, "pane-a");
  await list([both[1]]);
  const gone = await openPty(t, bridge, closed);
  assert.equal(gone.status, 404);

  // The terminal now lives in another pane.
  await list(both);
  const moved = await terminalTicket(bridge.origin, headers, "pane-a");
  await list([{ pane_id: "pane-z", terminal_id: "term-a" }, both[1]]);
  const stale = await openPty(t, bridge, moved);
  assert.equal(stale.status, 409);

  // Either refusal still spent the ticket.
  await list(both);
  assert.equal((await openPty(t, bridge, moved)).status, 401);
  assert.equal((await openPty(t, bridge, await terminalTicket(bridge.origin, headers, "pane-a"))).status, 101);
});

async function waitClosed(pty, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!pty.closed() && Date.now() < deadline) await delay(20);
  return pty.closeCode();
}

test("terminal sockets are capped per device, even for parallel upgrades, and a closed one frees its slot", { timeout: 30000 }, async (t) => {
  const bridge = await startBridge(t);
  const { headers } = await authorize(bridge);
  const open = [];
  for (let i = 0; i < 4; i++) {
    const pty = await openPty(t, bridge, await terminalTicket(bridge.origin, headers, "pane-a"));
    assert.equal(pty.status, 101);
    open.push(pty);
  }
  const fifth = await openPty(t, bridge, await terminalTicket(bridge.origin, headers, "pane-b"));
  assert.equal(fifth.status, 429, "a fifth terminal on one device is refused");
  // Capacity is reserved before the async checks, so parallel upgrades
  // cannot slip past it either.
  const parallel = await Promise.all([1, 2, 3].map(async () => openPty(t, bridge, await terminalTicket(bridge.origin, headers, "pane-a"))));
  assert.ok(parallel.every((pty) => pty.status === 429));

  open[0].socket.end(maskFrame(Buffer.from([0x03, 0xe8]), 8));
  await waitClosed(open[0]);
  await delay(200);
  assert.equal((await openPty(t, bridge, await terminalTicket(bridge.origin, headers, "pane-a"))).status, 101, "closing one frees its slot");

  // A second device is counted separately.
  const other = await authorize(bridge);
  assert.equal((await openPty(t, bridge, await terminalTicket(bridge.origin, other.headers, "pane-b"))).status, 101);
});

test("terminal sockets are capped at 32 across every device, and a closed one frees a slot", { timeout: 60000 }, async (t) => {
  const bridge = await startBridge(t);
  // Eight devices at their own cap of four fill the bridge exactly.
  const devices = [];
  for (let i = 0; i < 9; i++) devices.push((await authorize(bridge)).headers);
  const open = [];
  for (const headers of devices.slice(0, 8)) {
    for (let i = 0; i < 4; i++) {
      const pty = await openPty(t, bridge, await terminalTicket(bridge.origin, headers, "pane-a"));
      assert.equal(pty.status, 101);
      open.push(pty);
    }
  }
  assert.equal(open.length, 32);
  // The ninth device is under its own cap, so only the bridge's refuses it.
  const ninth = devices[8];
  assert.equal((await openPty(t, bridge, await terminalTicket(bridge.origin, ninth, "pane-b"))).status, 503, "a 33rd terminal is refused");
  const parallel = await Promise.all([1, 2].map(async () => openPty(t, bridge, await terminalTicket(bridge.origin, ninth, "pane-a"))));
  assert.ok(parallel.every((pty) => pty.status === 503), "parallel upgrades cannot pass the bridge cap");

  open[0].socket.end(maskFrame(Buffer.from([0x03, 0xe8]), 8));
  await waitClosed(open[0]);
  await delay(200);
  assert.equal((await openPty(t, bridge, await terminalTicket(bridge.origin, ninth, "pane-a"))).status, 101, "closing one frees a bridge slot");
});

test("a failed upgrade releases its reservation", { timeout: 30000 }, async (t) => {
  const panes = path.join(await scratchDir(), "panes.json");
  const bridge = await startBridge(t, { herdr: HERDR_PANES_FIXTURE, env: { HERDR_PANES: panes } });
  const { headers } = await authorize(bridge);
  // Five upgrades refused after reserving (the pane closed) must leave all
  // four of the device's slots free.
  for (let i = 0; i < 5; i++) {
    await writeFile(panes, JSON.stringify({ result: { panes: [{ pane_id: "pane-a", terminal_id: "term-a" }] } }));
    const ticket = await terminalTicket(bridge.origin, headers, "pane-a");
    await writeFile(panes, JSON.stringify({ result: { panes: [] } }));
    assert.equal((await openPty(t, bridge, ticket)).status, 404);
  }
  await writeFile(panes, JSON.stringify({ result: { panes: [{ pane_id: "pane-a", terminal_id: "term-a" }] } }));
  for (let i = 0; i < 4; i++) assert.equal((await openPty(t, bridge, await terminalTicket(bridge.origin, headers, "pane-a"))).status, 101);
});

test("oversized, fragmented-oversized and binary messages close the socket at the boundary", { timeout: 30000 }, async (t) => {
  const bridge = await startBridge(t);
  const { headers } = await authorize(bridge);
  const pty = () => terminalTicket(bridge.origin, headers, "pane-a").then((q) => openPty(t, bridge, q));

  const big = await pty();
  big.socket.write(maskFrame("x".repeat(64 * 1024 + 1)));
  assert.equal(await waitClosed(big), 1009, "a message over 64 KiB is refused with 1009");

  // Two 40 KiB fragments: each fits, the whole message does not.
  const pieces = await pty();
  pieces.socket.write(Buffer.concat([
    maskFrame("y".repeat(40 * 1024), 1, { fin: false }),
    maskFrame("y".repeat(40 * 1024), 0, { fin: true }),
  ]));
  assert.equal(await waitClosed(pieces), 1009, "fragments count toward one message");

  // Small fragments that fit are one ordinary message, refused as input.
  const fits = await pty();
  fits.socket.write(Buffer.concat([maskFrame('{"te', 1, { fin: false }), maskFrame('xt":"hi"}', 0, { fin: true })]));
  await delay(300);
  assert.ok(fits.frames().some((f) => f?.error?.code === "terminal_input_http"));
  assert.ok(!fits.closed());

  const binary = await pty();
  binary.socket.write(maskFrame(Buffer.from([1, 2, 3]), 2));
  assert.equal(await waitClosed(binary), 1003, "binary input is refused");
  assert.deepEqual(await bridge.mutations(), []);
});

// A viewer that stops reading must not grow the bridge's memory: once its
// send buffer passes the bound, the next frame closes it with 1013.
const HERDR_FLOOD_FIXTURE = HERDR_FIXTURE.replace(
  `else if (a[0] === "pane" && a[1] === "read") console.log("pane " + a[2] + "\\n");`,
  `else if (a[0] === "pane" && a[1] === "read") console.log(Array.from({ length: 2000 }, () => Math.random().toString(36).repeat(4)).join("\\n"));`,
);

test("a slow consumer is disconnected with 1013", { timeout: 60000 }, async (t) => {
  assert.notEqual(HERDR_FLOOD_FIXTURE, HERDR_FIXTURE, "the flood fixture replaced the pane read");
  const bridge = await startBridge(t, { herdr: HERDR_FLOOD_FIXTURE });
  const { headers } = await authorize(bridge);
  const slow = await openPty(t, bridge, await terminalTicket(bridge.origin, headers, "pane-a"));
  assert.equal(slow.status, 101);
  slow.socket.pause();
  await delay(8000);
  slow.socket.resume();
  assert.equal(await waitClosed(slow, 20000), 1013);
});

test("a socket closes when its terminal goes away", { timeout: 30000 }, async (t) => {
  const dir = await scratchDir();
  const panes = path.join(dir, "panes.json");
  // Once the pane is gone from the list, reading it fails too.
  const herdr = HERDR_PANES_FIXTURE.replace(
    `else if (a[0] === "pane" && a[1] === "read")`,
    `else if (a[0] === "pane" && a[1] === "read" && existsSync(process.env.HERDR_PANES) && !readFileSync(process.env.HERDR_PANES, "utf8").includes(a[2])) process.exit(1);
else if (a[0] === "pane" && a[1] === "read")`,
  );
  const bridge = await startBridge(t, { herdr, env: { HERDR_PANES: panes } });
  const { headers } = await authorize(bridge);
  const viewer = await openPty(t, bridge, await terminalTicket(bridge.origin, headers, "pane-a"));
  assert.equal(viewer.status, 101);
  await delay(300);
  assert.ok(!viewer.closed());
  await writeFile(panes, JSON.stringify({ result: { panes: [{ pane_id: "pane-b", terminal_id: "term-b" }] } }));
  const deadline = Date.now() + 5000;
  while (!viewer.closed() && Date.now() < deadline) await delay(50);
  assert.ok(viewer.closed(), "the viewer learns the pane closed");
});

test("a terminal URL carries exactly one ticket and nothing else", { timeout: 30000 }, async (t) => {
  const bridge = await startBridge(t);
  const { headers } = await authorize(bridge);
  const good = await terminalTicket(bridge.origin, headers, "pane-a");
  const other = await terminalTicket(bridge.origin, headers, "pane-b");
  for (const query of [`${good}&${other}`, `${good}&target=pane-b`, `${good}&token=x`, "", "target=pane-a", `${good}&ticket=`]) {
    const refused = await openPty(t, bridge, query);
    assert.equal(refused.status, 400, `query ${JSON.stringify(query.replace(/ticket=[^&]+/g, "ticket=…"))} must be refused`);
    assert.match(refused.head, /\r\ncontent-type: application\/json/i);
  }
  // The shape check runs before a ticket is spent, so both still open.
  assert.equal((await openPty(t, bridge, good)).status, 101);
  assert.equal((await openPty(t, bridge, other)).status, 101);
});

test("terminal upgrades require an allowed origin", { timeout: 30000 }, async (t) => {
  const bridge = await startBridge(t);
  const { headers } = await authorize(bridge);
  const query = await terminalTicket(bridge.origin, headers, "pane-a");

  const allowed = await openPty(t, bridge, query, { origin: bridge.ui });
  assert.equal(allowed.status, 101);

  for (const origin of [null, "null", bridge.hostile, "https://evil.test"]) {
    const refused = await openPty(t, bridge, query, { origin });
    assert.equal(refused.status, 403, `origin ${origin} must not upgrade`);
  }

  const badHost = await openPty(t, bridge, query, { host: "evil.test" });
  assert.equal(badHost.status, 403);
});

test("a terminal socket only views its pane: input is refused, and a crossing frame closes it", { timeout: 30000 }, async (t) => {
  const bridge = await startBridge(t);
  const { headers } = await authorize(bridge);
  const query = () => terminalTicket(bridge.origin, headers, "pane-a");

  // herdr acknowledges no input on the control pipe, so the socket forwards
  // none: every input frame is answered with a refusal and nothing is sent.
  const viewer = await openPty(t, bridge, await query());
  assert.equal(viewer.status, 101);
  for (const frame of [{ target: "term-a", text: "one" }, { keys: "enter" }, { keys: "home" }, "raw keys"]) viewer.send(frame);
  await delay(300);
  const refusals = viewer.frames().filter((f) => f?.error?.code === "terminal_input_http");
  assert.equal(refusals.length, 4, "each input frame is refused explicitly");
  assert.ok(!viewer.closed(), "a refused key does not end the terminal");
  assert.deepEqual(await bridge.ctrl(), [], "nothing reaches a session-control line");
  assert.ok(!(await bridge.calls()).some((row) => row[0] === "terminal" && row[1] === "session"), "no control session is opened");
  assert.deepEqual(await bridge.mutations(), [], "and nothing is retried over the write lane");

  for (const target of ["pane-b", null, "", 7, { id: "pane-a" }]) {
    const refused = await openPty(t, bridge, await query());
    assert.equal(refused.status, 101);
    refused.send({ target, text: "nope" });
    await delay(200);
    assert.ok(refused.closed(), `target ${JSON.stringify(target)} must close the connection`);
  }
  assert.deepEqual(await bridge.mutations(), [], "address-check failures never touch the pane write lane");
});

test("demo output reaches only the terminal that opened its target", { timeout: 30000 }, async (t) => {
  const bridge = await startBridge(t, { env: { MOSHPIT_HERDR_BIN: "" } });
  const { headers } = await authorize(bridge);

  const migrate = await openPty(t, bridge, await terminalTicket(bridge.origin, headers, "migrate"));
  const auth = await openPty(t, bridge, await terminalTicket(bridge.origin, headers, "auth"));
  assert.equal(migrate.status, 101);
  assert.equal(auth.status, 101);

  // Keys go over HTTP; the sockets only view their panes.
  const keys = (list) => bridge.request("/api/action", { method: "POST", headers, body: { kind: "keys", target: "migrate", keys: list } });
  assert.equal((await keys([{ text: "hello" }])).status, 200);
  assert.equal((await keys(["esc"])).status, 200);
  await delay(300);
  assert.ok(migrate.frames().some((f) => f.line?.text === "[esc]"), "demo keys render through the keys path, not the prompt path");

  const echoed = migrate.frames().filter((frame) => frame.target === "migrate");
  assert.ok(echoed.length > 0, "the sending terminal still sees its own output");
  assert.deepEqual(
    auth.frames().filter((frame) => typeof frame.target === "string"),
    [],
    "another terminal must not receive it",
  );
});

test("hostile mutations cannot log, submit, or revoke a password session", { timeout: 30000 }, async (t) => {
  const bridge = await startBridge(t);
  const { headers } = await authorize(bridge);
  for (const pathname of ["/api/logout", "/api/log", "/api/submit"]) {
    for (const origin of [bridge.hostile, null]) {
      const response = await bridge.request(pathname, {
        method: "POST", origin, headers,
        body: { target: "pane-a", text: "must not dispatch", message: "must not log" },
      });
      assert.equal(response.status, 403);
      assert.equal(response.headers.get("access-control-allow-origin"), null);
    }
  }
  assert.equal((await bridge.request("/api/snapshot", { headers })).status, 200);
  await assert.rejects(readFile(path.join(bridge.dir, "state", "client.log")), { code: "ENOENT" });
  assert.deepEqual(await bridge.mutations(), []);
});

test("protocol 2: single-use tickets, device/session revocation, admin and legacy denials", { timeout: 30000 }, async (t) => {
  const { sendAdminRequest } = await import("./admin.mjs");
  const { stat } = await import("node:fs/promises");
  const bridge = await startBridge(t);
  const admin = (message) => sendAdminRequest(message, { stateDir: path.join(bridge.dir, "state") });
  assert.deepEqual(await (await bridge.request("/api/auth-info")).json(), { protocol: 2, requiredFactors: ["password"], push: { available: true }, connectOrigins: [], requesterLogin: null });
  const login = await bridge.request("/api/login", { method: "POST", body: { password: PASSWORD } });
  assert.equal(login.headers.get("set-cookie"), null);
  const session = await login.json();
  const identityHeaders = { authorization: `Bearer ${session.token}` };
  const grant = await admin({ action: "pair", name: "admin phone" });
  assert.ok(grant.result.secret);
  const paired = await bridge.request("/api/devices/pairing", { method: "POST", headers: identityHeaders, body: { secret: grant.result.secret, name: "admin phone" } });
  assert.equal(paired.status, 200);
  const device = await paired.json();
  const headers = { ...identityHeaders, "x-moshpit-device": `${device.deviceId}.${device.deviceSecret}` };
  assert.equal((await admin({ action: "devices" })).result[0].id, device.deviceId);
  assert.equal((await stat(path.join(bridge.dir, "state", "admin.sock"))).mode & 0o777, 0o600);
  assert.equal((await admin({ action: "expiry", deviceId: device.deviceId, term: "never" })).result.expiresAt, null);
  const expiryAudits = (await readFile(path.join(bridge.dir, "state", "audit.jsonl"), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.kind === "expiry");
  assert.deepEqual(expiryAudits.map(({ kind, deviceId, expiresAt }) => ({ kind, deviceId, expiresAt })), [
    { kind: "expiry", deviceId: device.deviceId, expiresAt: null },
  ]);
  const query = await terminalTicket(bridge.origin, headers, "pane-a");
  const opened = await openPty(t, bridge, query);
  assert.equal(opened.status, 101);
  assert.equal((await openPty(t, bridge, query)).status, 401, "a real socket cannot spend a ticket twice");
  const waiting = await terminalTicket(bridge.origin, headers, "pane-a");
  assert.ok((await admin({ action: "revoke", deviceId: device.deviceId })).result.revokedAt);
  await delay(100);
  assert.ok(opened.closed(), "admin revoke destroys the device socket");
  assert.equal((await openPty(t, bridge, waiting)).status, 401, "admin revoke drops unopened tickets");
  const revoked = await bridge.request("/api/snapshot", { headers });
  assert.equal((await revoked.json()).error.code, "device_revoked");

  const credential = await pairDevice(bridge.origin, identityHeaders, { stateDir: bridge.stateDir, name: "second phone" });
  headers["x-moshpit-device"] = credential;
  const second = await openPty(t, bridge, await terminalTicket(bridge.origin, headers, "pane-a"));
  const secondWaiting = await terminalTicket(bridge.origin, headers, "pane-a");
  const revoke = await bridge.request("/api/devices/revoke", { method: "POST", headers, body: { deviceId: credential.split(".")[0] } });
  assert.equal(revoke.status, 200);
  await delay(100);
  assert.ok(second.closed(), "HTTP revoke destroys sockets");
  assert.equal((await openPty(t, bridge, secondWaiting)).status, 401);

  headers["x-moshpit-device"] = await pairDevice(bridge.origin, identityHeaders, { stateDir: bridge.stateDir, name: "third phone" });
  const sessionSocket = await openPty(t, bridge, await terminalTicket(bridge.origin, headers, "pane-a"));
  const sessionWaiting = await terminalTicket(bridge.origin, headers, "pane-a");
  for (let i = 0; i < 2; i++) {
    const logout = await bridge.request("/api/logout", { method: "POST", headers: identityHeaders, body: {} });
    assert.equal(logout.status, 200, "logout is idempotent and needs no device header");
    assert.deepEqual(await logout.json(), { ok: true });
  }
  await delay(100);
  assert.ok(sessionSocket.closed());
  assert.equal((await openPty(t, bridge, sessionWaiting)).status, 401);

  const authed = await authorize(bridge);
  const cookie = await bridge.request("/api/snapshot", { headers: { cookie: `moshpit=${authed.token}`, "x-moshpit-device": authed.headers["x-moshpit-device"] } });
  assert.equal(cookie.status, 401);
  assert.equal((await cookie.json()).error.code, "password_required");
  const bare = await bridge.request("/api/snapshot", { headers: { ...authed.headers, "x-moshpit-device": authed.headers["x-moshpit-device"].split(".")[0] } });
  assert.equal(bare.status, 403);
  assert.equal((await bare.json()).error.code, "device_required");
  const legacy = await rawRequest(bridge.port, [
    `GET /pty?token=${authed.token}&device=${device.deviceId} HTTP/1.1`,
    `Host: 127.0.0.1:${bridge.port}`, `Origin: ${bridge.origin}`,
    "Upgrade: websocket", "Connection: Upgrade", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
  ]);
  // Refused by the query shape before any ticket or credential is looked at.
  assert.equal(statusOf(legacy), 400);
  assert.equal(JSON.parse(legacy.split("\r\n\r\n")[1]).error.code, "terminal_query_invalid");
  assert.deepEqual(await bridge.mutations(), [], "auth/device/ticket/admin paths never mutate herdr");
});

test("identity alone never enrolls a device; only admin-socket grants redeem, even for recovery", { timeout: 60000 }, async (t) => {
  const { sendAdminRequest } = await import("./admin.mjs");
  const bridge = await startBridge(t);
  const admin = (message) => sendAdminRequest(message, { stateDir: bridge.stateDir });
  const login = async (target = bridge) => {
    const res = await target.request("/api/login", { method: "POST", body: { password: PASSWORD } });
    assert.equal(res.status, 200);
    return { authorization: `Bearer ${(await res.json()).token}` };
  };
  const redeem = (target, identity, secret, name) =>
    target.request("/api/devices/pairing", { method: "POST", headers: identity, body: { secret, name } });
  const selfIssue = async (target, headers) => {
    const res = await target.request("/api/devices/pair", { method: "POST", headers, body: { name: "self" } });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, "enrollment_authorization_required");
  };
  const readState = async () => JSON.parse(await readFile(path.join(bridge.stateDir, "devices.json"), "utf8").catch(() => '{"devices":[],"grants":[]}'));

  // Without identity the route answers as any protected route does.
  const anonymous = await bridge.request("/api/devices/pair", { method: "POST", body: { name: "anon" } });
  assert.equal(anonymous.status, 401);

  // An old client that still asks for a grant is refused, and nothing is minted.
  const identity = await login();
  await selfIssue(bridge, identity);
  assert.deepEqual(await readState(), { devices: [], grants: [] });

  // An admin grant redeems exactly once, even when the browser races itself.
  const first = (await admin({ action: "pair", name: "phone" })).result;
  const raced = await Promise.all(Array.from({ length: 5 }, () => redeem(bridge, identity, first.secret, "phone")));
  const statuses = raced.map((res) => res.status).sort();
  assert.deepEqual(statuses, [200, 403, 403, 403, 403]);
  for (const res of raced.filter((res) => res.status === 403))
    assert.equal((await res.json()).error.code, "pairing_grant_used");
  const phone = await raced.find((res) => res.status === 200).json();
  const phoneHeaders = { ...identity, "x-moshpit-device": `${phone.deviceId}.${phone.deviceSecret}` };
  assert.equal((await bridge.request("/api/snapshot", { headers: phoneHeaders })).status, 200);
  // An approved device cannot mint grants for others over HTTP either.
  await selfIssue(bridge, phoneHeaders);

  const laptopGrant = (await admin({ action: "pair", name: "laptop" })).result;
  const laptop = await (await redeem(bridge, identity, laptopGrant.secret, "laptop")).json();

  // Revoke every device. The browsers keep their identity but cannot pair back.
  for (const deviceId of [phone.deviceId, laptop.deviceId])
    assert.ok((await admin({ action: "revoke", deviceId })).result.revokedAt);
  const revoked = await bridge.request("/api/snapshot", { headers: phoneHeaders });
  assert.equal((await revoked.json()).error.code, "device_revoked");
  await selfIssue(bridge, identity);
  await selfIssue(bridge, phoneHeaders);
  assert.deepEqual((await readState()).grants, []);

  // Local recovery still works with nothing approved, and the formerly revoked
  // browser, whose identity still works, redeems the fresh grant.
  const recovery = (await admin({ action: "pair", name: "phone again" })).result;
  const recovered = await (await redeem(bridge, identity, recovery.secret, "phone again")).json();
  const recoveredHeaders = { ...identity, "x-moshpit-device": `${recovered.deviceId}.${recovered.deviceSecret}` };
  assert.equal((await bridge.request("/api/snapshot", { headers: recoveredHeaders })).status, 200);
  const listed = Object.fromEntries((await admin({ action: "devices" })).result.map((device) => [device.id, device]));
  assert.notEqual(listed[phone.deviceId].revokedAt, null, "recovery does not reinstate a revoked device");
  assert.notEqual(listed[laptop.deviceId].revokedAt, null);
  assert.equal(listed[recovered.deviceId].active, true);

  const kinds = (await readFile(path.join(bridge.stateDir, "audit.jsonl"), "utf8"))
    .split("\n").filter(Boolean).map((line) => JSON.parse(line).kind);
  assert.equal(kinds.filter((kind) => kind === "pair-refused").length, 4);
  assert.deepEqual(await bridge.mutations(), [], "refused enrollment never reaches herdr");

  // A restart keeps approvals and revocations but not password sessions, and
  // still refuses identity-only enrollment.
  bridge.child.kill("SIGKILL");
  await bridge.exited;
  const restarted = await startBridge(t, { dir: bridge.dir });
  const stale = await restarted.request("/api/snapshot", { headers: recoveredHeaders });
  assert.equal(stale.status, 401, "a password session does not survive a restart");
  const fresh = await login(restarted);
  const revokedAgain = await restarted.request("/api/snapshot", { headers: { ...fresh, "x-moshpit-device": phoneHeaders["x-moshpit-device"] } });
  assert.equal((await revokedAgain.json()).error.code, "device_revoked");
  const kept = await restarted.request("/api/snapshot", { headers: { ...fresh, "x-moshpit-device": recoveredHeaders["x-moshpit-device"] } });
  assert.equal(kept.status, 200);
  await selfIssue(restarted, fresh);
});

// Tickets live in memory only: one issued before a restart opens nothing after
// it, while the device it was issued to still gets a fresh one (V1).
test("a terminal ticket does not survive a bridge restart, and the device gets a new one", { timeout: 30000 }, async (t) => {
  const bridge = await startBridge(t);
  const { headers } = await authorize(bridge);
  const unspent = await terminalTicket(bridge.origin, headers, "pane-a");
  bridge.child.kill("SIGKILL");
  await bridge.exited;

  const restarted = await startBridge(t, { dir: bridge.dir });
  assert.equal((await openPty(t, restarted, unspent)).status, 401, "a ticket from before the restart is refused");
  const res = await restarted.request("/api/login", { method: "POST", body: { password: PASSWORD } });
  assert.equal(res.status, 200);
  const device = { authorization: `Bearer ${(await res.json()).token}`, "x-moshpit-device": headers["x-moshpit-device"] };
  assert.equal((await openPty(t, restarted, await terminalTicket(restarted.origin, device, "pane-a"))).status, 101, "the approved device opens a terminal again");
});

test("an oversized JSON body is refused before the handler runs", { timeout: 30000 }, async (t) => {
  const bridge = await startBridge(t);
  const res = await bridge.request("/api/login", {
    method: "POST",
    body: { password: "x".repeat(70_000) },
  });
  assert.equal(res.status, 413);
  assert.deepEqual(await res.json(), { error: { code: "request_invalid", message: "Request too large." } });
});

test("an image larger than 10 MB is refused before the action dispatches", { timeout: 30000 }, async (t) => {
  const bridge = await startBridge(t);
  const { headers } = await authorize(bridge);
  // 13,981,016 base64 characters decode to 10,485,762 bytes, just over 10 MiB,
  // inside the prompt body cap so the image check, not the body check, fires.
  const res = await bridge.request("/api/action", {
    method: "POST",
    headers,
    body: { kind: "prompt", target: "pane-a", text: "", attachment: { name: "big.png", type: "image/png", data: "A".repeat(13_981_016) } },
  });
  assert.equal(res.status, 413);
  assert.deepEqual(await res.json(), { error: { code: "request_invalid", message: "Images must be 10 MB or smaller." } });
  assert.deepEqual(await bridge.mutations(), []);
});

test("an accepted image is stored, named to the agent and served back unchanged", { timeout: 30000 }, async (t) => {
  const bridge = await startBridge(t);
  const { headers } = await authorize(bridge);
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("not a real image body")]);
  const res = await bridge.request("/api/action", {
    method: "POST",
    headers,
    body: { kind: "prompt", target: "pane-a", text: "look", attachment: { name: "shot.png", type: "image/png", data: png.toString("base64") } },
  });
  assert.equal(res.status, 200);
  const { attachment } = await res.json();
  assert.ok(JSON.stringify(await bridge.mutations()).includes(attachment.path), "the prompt names the stored file");
  const served = await bridge.request(`/api/upload?path=${encodeURIComponent(attachment.path)}`, { headers });
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), png);
});

test("every API answer is no-store, every answer is nosniff and no-referrer, only the SPA carries the CSP", { timeout: 30000 }, async (t) => {
  const bridge = await startBridge(t);
  const { headers } = await authorize(bridge);

  const snapshot = await bridge.request("/api/snapshot", { headers });
  assert.equal(snapshot.status, 200);
  // The snapshot names every agent and its status; agent-detail and session
  // carry the conversation itself. None of it may sit in the disk cache after
  // a logout or a revocation.
  assert.equal(snapshot.headers.get("cache-control"), "no-store");
  assert.equal(snapshot.headers.get("x-content-type-options"), "nosniff");
  assert.equal(snapshot.headers.get("content-security-policy"), null, "JSON consumers must not get the SPA CSP");
  assert.equal(snapshot.headers.get("referrer-policy"), "no-referrer");

  const login = await bridge.request("/api/login", { method: "POST", body: { password: PASSWORD } });
  assert.equal(login.status, 200);
  assert.equal(login.headers.get("cache-control"), "no-store");
  const identityHeaders = { authorization: `Bearer ${(await login.json()).token}` };

  const ticket = await bridge.request("/api/terminal-ticket", { method: "POST", headers, body: { target: "pane-a" } });
  assert.equal(ticket.status, 200);
  assert.equal(ticket.headers.get("cache-control"), "no-store");

  const { sendAdminRequest } = await import("./admin.mjs");
  const grant = (await sendAdminRequest({ action: "pair", name: "no-store pair" }, { stateDir: bridge.stateDir })).result;
  const pairing = await bridge.request("/api/devices/pairing", { method: "POST", headers: identityHeaders, body: { secret: grant.secret, name: "no-store pair" } });
  assert.equal(pairing.status, 200);
  assert.equal(pairing.headers.get("cache-control"), "no-store");

  const logout = await bridge.request("/api/logout", { method: "POST", headers: identityHeaders, body: {} });
  assert.equal(logout.status, 200);
  assert.equal(logout.headers.get("cache-control"), "no-store");

  const navigation = await bridge.request("/", { origin: null });
  await navigation.text();
  assert.equal(navigation.headers.get("x-content-type-options"), "nosniff", "the SPA answer carries nosniff even unbuilt");
  assert.equal(navigation.headers.get("referrer-policy"), "no-referrer");
  assert.notEqual(navigation.headers.get("cache-control"), "no-store", "the app shell keeps its own caching");
  assert.equal(
    navigation.headers.get("content-security-policy"),
    `default-src 'self'; connect-src 'self' ${bridge.origin.replace("http", "ws")}; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'`,
    "the SPA answer carries the CSP whether or not the build exists",
  );

  // Errors name the failure and can echo what was asked for, so they are as
  // uncacheable as the answers they stand in for.
  const refused = await bridge.request("/api/snapshot", { origin: bridge.hostile });
  assert.equal(refused.status, 403);
  assert.equal(refused.headers.get("x-content-type-options"), "nosniff", "a boundary refusal still carries nosniff");
  assert.equal(refused.headers.get("cache-control"), "no-store", "a boundary refusal is no-store");
  assert.equal(refused.headers.get("referrer-policy"), "no-referrer");
  await refused.text();
  for (const [path, init, status] of [
    ["/api/snapshot", {}, 401],
    ["/api/devices", { headers: identityHeaders }, 401],
    ["/api/no-such-route", { headers }, 404],
    ["/api/action", { method: "POST", headers, body: { kind: "nonsense" } }, 400],
  ]) {
    const error = await bridge.request(path, init);
    assert.equal(error.status, status, `${path} answers ${status}`);
    assert.equal(error.headers.get("cache-control"), "no-store", `${path} ${status} is no-store`);
    assert.equal(error.headers.get("referrer-policy"), "no-referrer");
    await error.text();
  }

  const logged = await bridge.request("/api/log", { method: "POST", headers, body: { kind: "beat" } });
  assert.equal(logged.status, 204, "a keepalive log post gets an empty answer");
  assert.equal(logged.headers.get("cache-control"), "no-store");
  assert.equal(await logged.text(), "");

  const upgrade = await openPty(t, bridge, "ticket=spent");
  assert.equal(upgrade.status, 401);
  assert.match(upgrade.head, /\r\ncache-control: no-store\r\n/i, "a refused upgrade is no-store");
  assert.match(upgrade.head, /\r\nreferrer-policy: no-referrer\r\n/i);
});

// web-push POSTs to the endpoint the subscription names, so an unvalidated
// subscription lets a paired device aim the bridge at the host's own network.
// The allowlist is a string check; bridge/push-delivery.test.mjs proves the
// filtering agent refuses an allowed name that resolves inward.
test("a push subscription must name an https endpoint at a known push service", { timeout: 30000 }, async (t) => {
  const bridge = await startBridge(t);
  const { headers } = await authorize(bridge);
  const keys = { p256dh: "BExample", auth: "sEcReT" };

  const hostile = [
    "http://fcm.googleapis.com/fcm/send/abc",
    "https://user:pass@fcm.googleapis.com/fcm/send/abc",
    "https://fcm.googleapis.com:8443/fcm/send/abc",
    "https://fcm.googleapis.com/fcm/send/abc#x",
    "https://push.example/p",
    "https://fcm.googleapis.com.attacker.example/p",
    "https://127.0.0.1/p",
    "https://localhost/p",
    "https://[::1]/p",
    "https://[::ffff:127.0.0.1]/p",
    "https://169.254.169.254/latest/meta-data/",
    "https://10.0.0.5/p",
    "https://192.168.1.9/p",
    "https://172.16.0.1/p",
    "https://[fd00::1]/p",
    "https://nas.local/p",
    // Decimal and hex spellings normalise back to 127.0.0.1 before the check.
    "https://2130706433/p",
    "https://0x7f000001/p",
  ];
  for (const endpoint of hostile) {
    const res = await bridge.request("/api/push-subscription", {
      method: "POST", headers, body: { pushSubscription: { endpoint, keys } },
    });
    assert.equal(res.status, 400, `${endpoint} must be refused`);
    const { error } = await res.json();
    assert.equal(error.code, "push_endpoint_invalid");
    // The refusal names the host, so an unknown provider is a one-line fix.
    assert.ok(error.message.includes(new URL(endpoint).hostname), `${error.message} must name the host`);
  }

  // A null subscription is not malformed — it means "leave mine alone" — so it
  // is deliberately absent here.
  for (const malformed of ["https://fcm.googleapis.com/p", { endpoint: "https://fcm.googleapis.com/p" }, { endpoint: "not a url", keys }]) {
    const res = await bridge.request("/api/push-subscription", {
      method: "POST", headers, body: { pushSubscription: malformed },
    });
    assert.equal(res.status, 400, `${JSON.stringify(malformed)} must be refused`);
    assert.equal((await res.json()).error.code, "push_endpoint_invalid");
  }

  // The real endpoints must still go through, including the FCM host an
  // over-eager private-address pattern would swallow.
  for (const endpoint of [
    "https://fcm.googleapis.com/fcm/send/abc",
    "https://updates.push.services.mozilla.com/wpush/v2/xyz",
    "https://web.push.apple.com/QAB",
  ]) {
    const res = await bridge.request("/api/push-subscription", {
      method: "POST", headers, body: { pushSubscription: { endpoint, keys } },
    });
    assert.equal(res.status, 200, `${endpoint} must be accepted`);
    await res.text();
  }
});

test("a revoked device is told to pair again with 403, not 410", { timeout: 30000 }, async (t) => {
  const bridge = await startBridge(t);
  const { headers } = await authorize(bridge);
  const deviceId = headers["x-moshpit-device"].split(".")[0];

  const revoked = await bridge.request("/api/devices/revoke", { method: "POST", headers, body: { deviceId } });
  assert.equal(revoked.status, 200);
  await revoked.text();

  // The client keys recovery off the code, but the status is the runbook's
  // contract and tests/unit/access.spec.ts stubs it as 403.
  const res = await bridge.request("/api/push-subscription", {
    method: "POST", headers,
    body: { pushSubscription: { endpoint: "https://fcm.googleapis.com/p", keys: { p256dh: "B", auth: "s" } } },
  });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error.code, "device_revoked");
});

// A body of literal `null` parses fine, then every handler that reads a
// property off it throws — which used to surface as a 500 echoing the
// internal TypeError.
test("a null or scalar JSON body is a 400, not a 500", { timeout: 30000 }, async (t) => {
  const bridge = await startBridge(t);
  const { headers } = await authorize(bridge);

  for (const pathname of [
    "/api/terminal-ticket",
    "/api/devices/revoke",
    "/api/devices/expiry",
    "/api/push-subscription",
  ]) {
    for (const body of [null, 42, "a string", []]) {
      const res = await bridge.request(pathname, { method: "POST", headers, body });
      assert.equal(res.status, 400, `${pathname} with ${JSON.stringify(body)} must be a 400`);
      const { error } = await res.json();
      assert.equal(error.code, "request_invalid");
      assert.ok(!/destructure|undefined|TypeError/i.test(error.message), `internal detail leaked: ${error.message}`);
    }
  }
});

// The app served here may reach only this bridge and the ones the operator
// named; any other destination is blocked by the browser before it connects.
test("the app's connect-src is this bridge plus MOSHPIT_CONNECT_ORIGINS, published in discovery", { timeout: 30000 }, async (t) => {
  const bridge = await startBridge(t, { env: { MOSHPIT_CONNECT_ORIGINS: "https://one.example.ts.net, https://two.example.ts.net:8803" } });
  const navigation = await bridge.request("/", { origin: null });
  await navigation.text();
  const csp = navigation.headers.get("content-security-policy");
  const connect = csp.split("; ").find((part) => part.startsWith("connect-src ")).split(" ").slice(1);
  assert.deepEqual(connect, [
    "'self'", bridge.origin.replace("http", "ws"),
    "https://one.example.ts.net", "wss://one.example.ts.net",
    "https://two.example.ts.net:8803", "wss://two.example.ts.net:8803",
  ]);
  assert.ok(!/https:(\s|;)|wss:(\s|;)/.test(csp), "no scheme-wide source remains");
  const info = await (await bridge.request("/api/auth-info")).json();
  assert.deepEqual(info.connectOrigins, ["https://one.example.ts.net", "https://two.example.ts.net:8803"]);
});

test("a malformed MOSHPIT_CONNECT_ORIGINS refuses startup", { timeout: 20000 }, async (t) => {
  for (const [value, message] of [
    ["https://*.example.ts.net", /must name one host, not a wildcard/],
    ["http://evil.example", /may use http only on localhost/],
    ["https://bridge.example/path", /must not carry a path/],
    ["https://a.example,,https://b.example", /has an empty member/],
  ]) {
    const dir = await scratchDir();
    const bridge = await spawnBridge(t, dir, { ...boundaryEnv(await freePort()), ...await passwordEnv(dir, PASSWORD), MOSHPIT_CONNECT_ORIGINS: value });
    assert.equal(await bridge.exited, 1, value);
    assert.match(bridge.stderr(), new RegExp(`MOSHPIT_CONNECT_ORIGINS .*${message.source}`));
  }
});

test("MOSHPIT_AUTH_MODE missing refuses startup", { timeout: 10000 }, async (t) => {
  const dir = await scratchDir();
  const bridge = await spawnBridge(t, dir, boundaryEnv(await freePort()));
  assert.equal(await bridge.exited, 1);
  assert.match(bridge.stderr(), /MOSHPIT_AUTH_MODE is required/);
  assert.equal(bridge.stdout(), "");
});

// A planted link at a state or log path would make the bridge write its
// VAPID private key, subscriptions or audit trail wherever the link points.
// client.log is read by whoever debugs the host, so it keeps only the black
// box's own bounded fields, never a prompt, and a device cannot flood it.
// send-text "slow" holds the pane's lane for a second and a half.
const HERDR_SLOW_FIXTURE = HERDR_FIXTURE.replace(
  `else console.log("{}");`,
  `else if (a[0] === "pane" && a[1] === "send-text" && a[3] === "slow") setTimeout(() => console.log("{}"), 1500);
else console.log("{}");`,
);

test("a write queued behind another is re-authorized when its turn comes", { timeout: 30000 }, async (t) => {
  const { sendAdminRequest } = await import("./admin.mjs");
  const bridge = await startBridge(t, { herdr: HERDR_SLOW_FIXTURE });
  const { headers } = await authorize(bridge);
  const keys = (text) => bridge.request("/api/action", { method: "POST", headers, body: { kind: "keys", target: "pane-a", keys: [{ text }] } });

  const holding = keys("slow");
  await delay(300);
  // Both wait behind "slow" in pane-a's lane, accepted while the device was
  // still approved.
  const queued = keys("after");
  const answered = bridge.request("/api/action", { method: "POST", headers, body: { kind: "answer", target: "pane-a", token: "t", optionKey: "1" } });
  await delay(200);
  const deviceId = headers["x-moshpit-device"].split(".")[0];
  assert.ok((await sendAdminRequest({ action: "revoke", deviceId }, { stateDir: bridge.stateDir })).result.revokedAt);

  assert.equal((await holding).status, 200, "the write already under way completes");
  const refused = await queued;
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).error.code, "device_revoked");
  assert.equal((await answered).status, 403, "a queued answer is re-authorized too");
  const writes = (await bridge.mutations()).map((row) => row.join(" "));
  assert.deepEqual(writes, ["pane send-text pane-a slow"], "nothing queued behind the revocation reaches herdr");
});

test("a key list is checked whole, and text is sent only when marked as text", { timeout: 30000 }, async (t) => {
  const bridge = await startBridge(t);
  const { headers } = await authorize(bridge);
  const keys = (list) => bridge.request("/api/action", { method: "POST", headers, body: { kind: "keys", target: "pane-a", keys: list } });

  for (const list of [["1", "pgup"],["enter", "Enter"], ["Tabs (Recommended)", "enter"], [{ text: "" }]]) {
    const refused = await keys(list);
    assert.equal(refused.status, 400, JSON.stringify(list));
    assert.equal((await refused.json()).error.code, "key_unsupported");
  }
  assert.deepEqual(await bridge.mutations(), [], "a refused element leaves nothing half-sent");

  const sent = await keys([{ text: "Enter" }, "enter"]);
  assert.equal(sent.status, 200);
  assert.deepEqual(await bridge.mutations(), [
    ["pane", "send-text", "pane-a", "Enter"],
    ["pane", "send-keys", "pane-a", "enter"],
  ]);
});

// The matrix is shared with the browser parser test (tests/unit/modules.spec.ts).
const KEY_MATRIX = JSON.parse(await readFile(new URL("../tests/fixtures/key-matrix.json", import.meta.url), "utf8"));

test("every key in the shared matrix reaches herdr as its exact argv", { timeout: 60000 }, async (t) => {
  const bridge = await startBridge(t);
  const { headers } = await authorize(bridge);
  const keys = (list) => bridge.request("/api/action", { method: "POST", headers, body: { kind: "keys", target: "pane-a", keys: list } });
  const argv = (bridge_) => [bridge_.kind === "keys" ? "send-keys" : "send-text", "pane-a", bridge_.value];

  const delivered = KEY_MATRIX.rows.filter((row) => row.bridge);
  assert.ok(delivered.length > 60);
  for (const row of delivered) {
    const sent = await keys([row.parsed.value]);
    assert.equal(sent.status, 200, row.name);
  }
  assert.deepEqual(
    await bridge.mutations(),
    delivered.map((row) => ["pane", ...argv(row.bridge)]),
    "one exact herdr call per key, in order",
  );
});

test("a mixed key batch keeps its order, and one unknown name sends nothing", { timeout: 30000 }, async (t) => {
  const bridge = await startBridge(t);
  const { headers } = await authorize(bridge);
  const keys = (list) => bridge.request("/api/action", { method: "POST", headers, body: { kind: "keys", target: "pane-a", keys: list } });

  const sent = await keys([{ text: "ls" }, "home", "enter", "ctrl+left", "f5", "delete", "shift+tab", "pagedown", "alt+enter", "end"]);
  assert.equal(sent.status, 200);
  assert.deepEqual(await bridge.mutations(), [
    ["pane", "send-text", "pane-a", "ls"],
    ["pane", "send-text", "pane-a", "\x1b[H"],
    ["pane", "send-keys", "pane-a", "enter"],
    ["pane", "send-text", "pane-a", "\x1b[1;5D"],
    ["pane", "send-text", "pane-a", "\x1b[15~"],
    ["pane", "send-text", "pane-a", "\x1b[3~"],
    ["pane", "send-keys", "pane-a", "shift+tab"],
    ["pane", "send-text", "pane-a", "\x1b[6~"],
    ["pane", "send-keys", "pane-a", "alt+enter"],
    ["pane", "send-text", "pane-a", "\x1b[F"],
  ]);

  // An unrecognised name is refused, not typed, and the keys before it are
  // not half-delivered.
  const before = (await bridge.mutations()).length;
  for (const name of KEY_MATRIX.unknown) {
    const refused = await keys(["home", "enter", name, "f1"]);
    assert.equal(refused.status, 400, name);
    assert.equal((await refused.json()).error.code, "key_unsupported", name);
  }
  assert.equal((await bridge.mutations()).length, before, "no refused list reached herdr");
});

test("diagnostics are schema-checked, bounded and rate limited per device",{ timeout: 30000 }, async (t) => {
  const bridge = await startBridge(t);
  const { headers } = await authorize(bridge);
  const post = (body) => bridge.request("/api/log", { method: "POST", headers, body });

  const invalid = await post({ kind: "beat", text: "a prompt that must not be logged" });
  assert.equal(invalid.status, 400);
  const { error } = await invalid.json();
  assert.equal(error.code, "diagnostic_invalid");
  assert.ok(!error.message.includes("prompt that must not"), "the refusal does not echo what was sent");

  const tooLarge = await post({ kind: "error", message: "x".repeat(20 * 1024) });
  assert.equal(tooLarge.status, 413);
  assert.equal((await tooLarge.json()).error.code, "diagnostic_too_large");

  const accepted = await post({ kind: "error", message: "boom", trail: [{ t: 1, what: "tab steer" }] });
  assert.equal(accepted.status, 204);
  const log = await readFile(path.join(bridge.dir, "state", "client.log"), "utf8");
  const [line] = log.trim().split("\n");
  const record = JSON.parse(line);
  assert.deepEqual(Object.keys(record).sort(), ["at", "deviceId", "kind", "message", "trail", "ua"]);
  assert.ok(!log.includes("prompt that must not"));

  // Three requests above spent three of this minute's sixty.
  for (let i = 3; i < 60; i++) assert.equal((await post({ kind: "beat" })).status, 204);
  const limited = await post({ kind: "beat" });
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).error.code, "diagnostic_rate_limited");
  assert.ok(Number(limited.headers.get("retry-after")) > 0);

  // Another device keeps its own allowance.
  const other = await authorize(bridge);
  assert.equal((await bridge.request("/api/log", { method: "POST", headers: other.headers, body: { kind: "beat" } })).status, 204);
});

test("a symlinked VAPID key, push store or log refuses startup and is not followed", { timeout: 30000 }, async (t) => {
  for (const name of ["vapid.json", "push.json", "audit.jsonl", "client.log"]) {
    const dir = await scratchDir();
    t.after(() => rm(dir, { recursive: true, force: true }));
    const state = path.join(dir, "state");
    await mkdir(state, { mode: 0o700 });
    const target = path.join(dir, "target");
    await writeFile(target, "original");
    await symlink(target, path.join(state, name));
    const bridge = await spawnBridge(t, dir, { ...boundaryEnv(await freePort()), ...await passwordEnv(dir, PASSWORD) });
    assert.equal(await bridge.exited, 1, `${name} must refuse startup`);
    assert.match(bridge.stderr(), new RegExp(`${name.replace(".", "\\.")} is a symbolic link; move it aside or fix it`));
    assert.equal(await readFile(target, "utf8"), "original");
  }
});

test("an explicitly empty device lifetime refuses startup", { timeout: 10000 }, async (t) => {
  const dir = await scratchDir();
  const bridge = await spawnBridge(t, dir, {
    ...boundaryEnv(await freePort()),
    ...await passwordEnv(dir, PASSWORD),
    MOSHPIT_DEVICE_LIFETIME_DAYS: "",
  });
  assert.equal(await bridge.exited, 1);
  assert.match(bridge.stderr(), /MOSHPIT_DEVICE_LIFETIME_DAYS must be a whole number of days from 1 to 3650/);
  assert.equal(bridge.stdout(), "");
});

// Expiry is the one device operation the app could not reach, even though it
// already revokes over the same guard.
test("a paired browser can re-date and disable its own expiry over HTTP", { timeout: 30000 }, async (t) => {
  const bridge = await startBridge(t);
  const { headers } = await authorize(bridge);
  const deviceId = headers["x-moshpit-device"].split(".")[0];

  const listed = await (await bridge.request("/api/devices", { headers })).json();
  assert.ok(listed.find((device) => device.id === deviceId).expiresAt > Date.now());

  const never = await bridge.request("/api/devices/expiry", { method: "POST", headers, body: { deviceId, term: "never" } });
  assert.equal(never.status, 200);
  assert.equal((await never.json()).expiresAt, null);

  const dated = await bridge.request("/api/devices/expiry", { method: "POST", headers, body: { deviceId, term: "30" } });
  assert.equal(dated.status, 200);
  assert.ok((await dated.json()).expiresAt > Date.now());

  // The term is text on the wire and is parsed by the bridge, never trusted.
  for (const term of ["forever", "0", "3651", "30.5", 30, null]) {
    const res = await bridge.request("/api/devices/expiry", { method: "POST", headers, body: { deviceId, term } });
    assert.equal(res.status, 400, `${JSON.stringify(term)} must be refused`);
    assert.equal((await res.json()).error.code, "device_expiry_invalid");
  }

  const unknown = await bridge.request("/api/devices/expiry", {
    method: "POST",
    headers,
    body: { deviceId: "00000000-0000-4000-8000-000000000000", term: "never" },
  });
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error.code, "device_unknown");
});
