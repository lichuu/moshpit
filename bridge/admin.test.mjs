import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  decodeAdminMessage,
  dispatchAdminRequest,
  formatAdminResult,
  MAX_REQUEST_BYTES,
  parseAdminArgs,
  sendAdminRequest,
  SOCKET_FILE,
  USAGE,
} from "./admin.mjs";
import { createDeviceStore, lifetimeOf, PAIRING_GRANT_MS } from "./devices.mjs";

const OWNER = "you@example.com";
const START = 1_800_000_000_000;
const CLI = fileURLToPath(new URL("./admin.mjs", import.meta.url));
const run = promisify(execFile);

function clock(start = START) {
  const time = { value: start };
  return { now: () => time.value, advance: (ms) => (time.value += ms) };
}

async function setup(t) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "moshpit-admin-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await chmod(stateDir, 0o700);
  const time = clock();
  const devices = await createDeviceStore({ stateDir, now: time.now });
  return { stateDir, time, devices, api: { devices, owner: OWNER } };
}

/** Stands in for the socket the bridge will own at cutover: one line in, one envelope out. */
async function listen(t, stateDir, api, { mode = 0o600 } = {}) {
  const socketPath = path.join(stateDir, SOCKET_FILE);
  const server = createServer((socket) => {
    let text = "";
    let answered = false;
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("data", async (chunk) => {
      text += chunk;
      const line = text.indexOf("\n");
      if (answered || line === -1) return;
      answered = true;
      const decoded = decodeAdminMessage(text.slice(0, line));
      const envelope = decoded.error ? decoded : await dispatchAdminRequest(decoded.message, api);
      socket.end(`${JSON.stringify(envelope)}\n`);
    });
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  server.listen(socketPath);
  await once(server, "listening");
  await chmod(socketPath, mode);
  return socketPath;
}

const approve = async (api, name = "Dana's phone") => {
  const { result } = await dispatchAdminRequest({ action: "pair", name }, api);
  return api.devices.pair({ secret: result.secret, owner: OWNER });
};

test("pair asks the bridge for a single-use secret the browser can spend", async (t) => {
  const { api, time } = await setup(t);
  const { result, error } = await dispatchAdminRequest({ action: "pair", name: "Dana's phone" }, api);

  assert.equal(error, undefined);
  assert.equal(result.name, "Dana's phone");
  assert.equal(result.owner, OWNER);
  assert.equal(result.expiresAt, time.now() + PAIRING_GRANT_MS);
  assert.match(result.secret, /^[A-Za-z0-9_-]{22}$/);

  const device = await api.devices.pair({ secret: result.secret, owner: OWNER });
  assert.equal(device.name, "Dana's phone");
  await assert.rejects(() => api.devices.pair({ secret: result.secret, owner: OWNER }), {
    code: "pairing_grant_used",
  });
});

test("devices lists approvals without a hash or a secret", async (t) => {
  const { api, stateDir } = await setup(t);
  const device = await approve(api);
  const { result } = await dispatchAdminRequest({ action: "devices" }, api);

  assert.equal(result.length, 1);
  assert.deepEqual(Object.keys(result[0]).sort(), [
    "active",
    "createdAt",
    "expiresAt",
    "id",
    "name",
    "owner",
    "revokedAt",
  ]);
  assert.equal(result[0].active, true);

  const { secretHash } = JSON.parse(await readFile(path.join(stateDir, "devices.json"), "utf8")).devices[0];
  const printed = formatAdminResult("devices", result);
  assert.match(printed, /DEVICE ID/);
  assert.match(printed, new RegExp(device.deviceId));
  assert.match(printed, /active/);
  assert.doesNotMatch(printed, new RegExp(secretHash));
  assert.doesNotMatch(printed, new RegExp(device.deviceSecret));
  assert.equal(formatAdminResult("devices", []), "No devices are approved. Run pair to approve one.");
});

test("revoke repeats the same revoked state instead of failing the second time", async (t) => {
  const { api, time } = await setup(t);
  const device = await approve(api);

  const first = await dispatchAdminRequest({ action: "revoke", deviceId: device.deviceId }, api);
  assert.equal(first.result.revokedAt, time.now());
  assert.equal(first.result.active, false);

  time.advance(1000);
  const second = await dispatchAdminRequest({ action: "revoke", deviceId: device.deviceId }, api);
  assert.deepEqual(second.result, first.result);
  assert.equal(formatAdminResult("revoke", second.result), formatAdminResult("revoke", first.result));
  assert.match(formatAdminResult("revoke", first.result), /is revoked as of .* UTC\./);

  const unknown = await dispatchAdminRequest({ action: "revoke", deviceId: randomUUID() }, api);
  assert.deepEqual(unknown, { error: { code: "device_unknown", message: "No device has that identifier." } });
});

test("an unknown action is refused by name, never by guessing an object property", async (t) => {
  const { api } = await setup(t);
  for (const action of ["sudo", "constructor", "toString", "__proto__", "", 7, null]) {
    const answer = await dispatchAdminRequest({ action }, api);
    assert.equal(answer.error.code, "admin_action_unknown", `action ${JSON.stringify(action)}`);
    assert.equal(answer.result, undefined);
  }
});

test("a malformed message is a structured error, not a throw", async (t) => {
  const { api } = await setup(t);
  const malformed = [
    null,
    "pair",
    ["pair"],
    {},
    { action: "pair" },
    { action: "pair", name: "phone", owner: "someone@example.com" },
    { action: "pair", name: 7 },
    { action: "pair", name: "" },
    { action: "pair", name: "x".repeat(257) },
    { action: "devices", name: "phone" },
    { action: "revoke" },
    { action: "revoke", deviceId: { id: 1 } },
  ];
  for (const message of malformed) {
    const answer = await dispatchAdminRequest(message, api);
    assert.equal(answer.result, undefined, JSON.stringify(message));
    assert.match(answer.error.code, /^admin_(request_invalid|action_unknown)$/, JSON.stringify(message));
    assert.equal(typeof answer.error.message, "string");
  }
  assert.equal((await dispatchAdminRequest({ action: "revoke", deviceId: "not-a-uuid" }, api)).error.code, "device_unknown");
});

test("malformed JSON and oversized lines are refused before parsing", () => {
  assert.equal(decodeAdminMessage("{").error.code, "admin_request_invalid");
  assert.equal(decodeAdminMessage("").error.code, "admin_request_invalid");
  assert.equal(decodeAdminMessage(undefined).error.code, "admin_request_invalid");
  assert.equal(decodeAdminMessage("x".repeat(MAX_REQUEST_BYTES + 1)).error.code, "admin_request_invalid");
  assert.deepEqual(decodeAdminMessage('{"action":"devices"}'), { message: { action: "devices" } });
});

test("a request travels the private socket and comes back as an envelope", async (t) => {
  const { api, stateDir } = await setup(t);
  const socketPath = await listen(t, stateDir, api);

  assert.equal((await stat(stateDir)).mode & 0o777, 0o700);
  assert.equal((await stat(socketPath)).mode & 0o777, 0o600);

  const paired = await sendAdminRequest({ action: "pair", name: "Dana's phone" }, { stateDir });
  assert.match(paired.result.secret, /^[A-Za-z0-9_-]{22}$/);

  const device = await api.devices.pair({ secret: paired.result.secret, owner: OWNER });
  const listed = await sendAdminRequest({ action: "devices" }, { stateDir });
  assert.deepEqual(
    listed.result.map((record) => record.id),
    [device.deviceId],
  );

  const revoked = await sendAdminRequest({ action: "revoke", deviceId: device.deviceId }, { stateDir });
  assert.equal(revoked.result.active, false);
  assert.deepEqual(await sendAdminRequest({ action: "sudo" }, { stateDir }), {
    error: { code: "admin_action_unknown", message: "Unknown action. This bridge accepts pair, devices, revoke, expiry, requests, approve, reject." },
  });
});

test("a socket loosened beyond its owner is refused before a secret is asked for", async (t) => {
  const { api, stateDir } = await setup(t);
  await listen(t, stateDir, api, { mode: 0o666 });

  const loose = await sendAdminRequest({ action: "devices" }, { stateDir });
  assert.equal(loose.error.code, "admin_socket_unsafe");
  assert.match(loose.error.message, /chmod 600/);

  await chmod(path.join(stateDir, SOCKET_FILE), 0o600);
  await chmod(stateDir, 0o755);
  const open = await sendAdminRequest({ action: "devices" }, { stateDir });
  assert.equal(open.error.code, "admin_socket_unsafe");
  assert.match(open.error.message, /chmod 700/);
});

test("no listening bridge is a reachability error, not a rewritten devices.json", async (t) => {
  const { stateDir } = await setup(t);
  const answer = await sendAdminRequest({ action: "devices" }, { stateDir });
  assert.equal(answer.error.code, "admin_bridge_unreachable");
  assert.match(answer.error.message, new RegExp(SOCKET_FILE));

  const missing = await sendAdminRequest({ action: "devices" }, { stateDir: path.join(stateDir, "absent") });
  assert.equal(missing.error.code, "admin_bridge_unreachable");
});

test("arguments map to exactly one bounded message", () => {
  assert.deepEqual(parseAdminArgs(["pair", "--name", "Dana's phone"]), {
    stateDir: undefined,
    message: { action: "pair", name: "Dana's phone" },
  });
  assert.deepEqual(parseAdminArgs(["pair", "--name=Dana's phone"]).message, {
    action: "pair",
    name: "Dana's phone",
  });
  assert.deepEqual(parseAdminArgs(["devices", "--state-dir", "/tmp/here"]), {
    stateDir: "/tmp/here",
    message: { action: "devices" },
  });

  const id = randomUUID();
  assert.deepEqual(parseAdminArgs(["revoke", id]).message, { action: "revoke", deviceId: id });

  // Terms cross the socket as text; the milliseconds are derived on each side.
  assert.deepEqual(parseAdminArgs(["expiry", id, "never"]).message, { action: "expiry", deviceId: id, term: "never" });
  assert.deepEqual(parseAdminArgs(["expiry", id, "30"]).message, { action: "expiry", deviceId: id, term: "30" });
  assert.equal(lifetimeOf("never"), null);
  assert.equal(lifetimeOf("30"), 30 * 24 * 60 * 60 * 1000);
  for (const term of ["0", "3651", "forever", "30.5", "-1", "", " 30", "never ", undefined])
    assert.equal(lifetimeOf(term), undefined, `${JSON.stringify(term)} is not a term`);

  const refused = [
    [],
    ["pair"],
    ["pair", "--name"],
    ["pair", "--name", "--state-dir"],
    ["pair", "--name", "a", "--name", "b"],
    ["pair", "extra", "--name", "a"],
    ["revoke"],
    ["revoke", id, "--name", "a"],
    ["expiry"],
    ["expiry", id],
    ["expiry", id, "never", "extra"],
    ["expiry", id, "forever"],
    ["expiry", id, "0"],
    ["expiry", id, "3651"],
    ["revoke", id, id],
    ["devices", "--name", "a"],
    ["devices", "extra"],
    ["forget", id],
    ["devices", "--wipe"],
  ];
  for (const argv of refused) {
    const answer = parseAdminArgs(argv);
    assert.equal(answer.message, undefined, argv.join(" "));
    assert.equal(answer.error.code, "admin_usage", argv.join(" "));
    assert.match(answer.error.message, /node bridge\/admin\.mjs pair --name/, argv.join(" "));
  }
  assert.match(USAGE, /--state-dir PATH/);
});

test("the pairing secret is printed once and stays out of every error string", async (t) => {
  const { api, stateDir } = await setup(t);
  await listen(t, stateDir, api);
  const paired = await sendAdminRequest({ action: "pair", name: "Dana's phone" }, { stateDir });
  const { secret } = paired.result;

  const printed = formatAdminResult("pair", paired.result);
  assert.equal(printed.split(secret).length - 1, 1);
  assert.doesNotMatch(printed, /admin\.sock|https?:|\?/);

  const device = await api.devices.pair({ secret, owner: OWNER });
  await api.devices.revoke(device.deviceId);
  const errors = [
    (await dispatchAdminRequest({ action: "pair", name: "" }, api)).error,
    (await dispatchAdminRequest({ action: "sudo", secret }, api)).error,
    (await dispatchAdminRequest({ action: "revoke", deviceId: secret }, api)).error,
    decodeAdminMessage(`{"action":"pair","secret":"${secret}"`).error,
    (await sendAdminRequest({ action: "devices" }, { stateDir: path.join(stateDir, "absent") })).error,
    parseAdminArgs(["pair", "--secret", secret]).error,
  ];
  for (const error of errors) {
    assert.ok(error, "expected a denial");
    assert.doesNotMatch(`${error.code} ${error.message}`, new RegExp(secret));
  }
  const listed = await sendAdminRequest({ action: "devices" }, { stateDir });
  assert.doesNotMatch(formatAdminResult("devices", listed.result), new RegExp(secret));
});

test("refusals is answered on the socket but is not an admin command", async (t) => {
  const { api } = await setup(t);
  assert.deepEqual(await dispatchAdminRequest({ action: "refusals" }, api), { result: [] });
  assert.match(parseAdminArgs(["refusals"]).error.message, /Unknown command/);
});

test("admin finds the state directory in the config MOSHPIT_CONFIG names", async (t) => {
  const { api, stateDir } = await setup(t);
  await listen(t, stateDir, api);
  const dir = await mkdtemp(path.join(os.tmpdir(), "mp-acfg-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = path.join(dir, "config.json");
  const origin = "https://box.tail1.ts.net:8803";
  await writeFile(
    config,
    JSON.stringify({ schemaVersion: 1, authMode: "tailscale", trustedOwner: OWNER, publicOrigin: origin, allowedAuthorities: [new URL(origin).host], stateDir }),
    { mode: 0o600 },
  );
  const env = { PATH: process.env.PATH, HOME: dir, MOSHPIT_CONFIG: config };
  const paired = await run(process.execPath, [CLI, "pair", "--name", "Dana's phone"], { env });
  assert.match(paired.stdout, /^ {2}[A-Za-z0-9_-]{22}$/m);
  const doubled = await run(process.execPath, [CLI, "devices"], { env: { ...env, MOSHPIT_STATE_DIR: stateDir } }).catch((error) => error);
  assert.equal(doubled.code, 1);
  assert.match(doubled.stderr, /MOSHPIT_STATE_DIR/);
});

test("the command prints the secret on stdout and exits non-zero without a bridge", async (t) => {
  const { api, stateDir } = await setup(t);
  await listen(t, stateDir, api);

  const paired = await run("node", [CLI, "pair", "--name", "Dana's phone", "--state-dir", stateDir]);
  const secret = paired.stdout.match(/^ {2}([A-Za-z0-9_-]{22})$/m)?.[1];
  assert.ok(secret, paired.stdout);
  assert.equal(paired.stderr, "");
  await api.devices.pair({ secret, owner: OWNER });

  const listed = await run("node", [CLI, "devices"], { env: { ...process.env, MOSHPIT_STATE_DIR: stateDir } });
  assert.match(listed.stdout, /Dana's phone/);
  assert.doesNotMatch(listed.stdout, new RegExp(secret));

  const failed = await run("node", [CLI, "devices", "--state-dir", path.join(stateDir, "absent")]).catch(
    (error) => error,
  );
  assert.equal(failed.code, 1);
  assert.equal(failed.stdout, "");
  assert.match(failed.stderr, /Start the bridge first/);

  const misused = await run("node", [CLI, "revoke", "--state-dir", stateDir]).catch((error) => error);
  assert.equal(misused.code, 1);
  assert.match(misused.stderr, /revoke needs a device id/);
});
