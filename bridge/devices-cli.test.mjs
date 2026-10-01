import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { decodeAdminMessage, dispatchAdminRequest, parseAdminArgs, sendAdminRequest, SOCKET_FILE } from "./admin.mjs";
import { createDeviceStore } from "./devices.mjs";
import { main } from "./devices-cli.mjs";
import { cliCommand, isolatedEnv, parseEnvelope } from "./test-support.mjs";

// `moshpit devices` against a real device store behind an admin socket. The
// spawned cases run bridge/cli.mjs, or the release executable under
// test:release; the prompt cases run in process with an injected terminal.

const OWNER = "you@example.com";

async function host(t) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "mp-dcli-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await chmod(stateDir, 0o700);
  const store = await createDeviceStore({ stateDir });
  const api = { devices: store, owner: OWNER };
  const socketPath = path.join(stateDir, SOCKET_FILE);
  const server = createServer((socket) => {
    let text = "";
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("data", async (chunk) => {
      text += chunk;
      const line = text.indexOf("\n");
      if (line === -1) return;
      const decoded = decodeAdminMessage(text.slice(0, line));
      socket.end(`${JSON.stringify(decoded.error ? decoded : await dispatchAdminRequest(decoded.message, api))}\n`);
    });
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  server.listen(socketPath);
  await once(server, "listening");
  await chmod(socketPath, 0o600);
  const request = (name = "laptop") => store.requestEnrollment({ name, owner: OWNER });
  return { stateDir, store, request };
}

async function run(t, args, env = {}) {
  const child = spawn(...cliCommand("devices", ...args), { env: { ...isolatedEnv(), ...env }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill("SIGKILL"));
  const out = [];
  const err = [];
  child.stdout.on("data", (chunk) => out.push(String(chunk)));
  child.stderr.on("data", (chunk) => err.push(String(chunk)));
  const [code] = await once(child, "exit");
  return { code, stdout: out.join(""), stderr: err.join("") };
}

function terminal({ isTTY, answer }) {
  const out = [];
  const err = [];
  const asked = [];
  const io = { stdout: { write: (text) => out.push(text) }, stderr: { write: (text) => err.push(text) }, exitCode: undefined };
  const context = {
    isTTY,
    prompt: async (question) => {
      asked.push(question);
      return answer;
    },
    send: sendAdminRequest,
  };
  return { io, context, asked, stdout: () => out.join(""), stderr: () => err.join("") };
}

test("pending lists name, phrase and age, never a secret, as text and as --json", async (t) => {
  const { stateDir, request } = await host(t);
  const empty = await run(t, ["pending", "--state-dir", stateDir]);
  assert.equal(empty.code, 0);
  assert.match(empty.stdout, /No access requests are waiting/);

  const made = await request();
  const listed = await run(t, ["pending", "--state-dir", stateDir]);
  assert.equal(listed.code, 0);
  assert.match(listed.stdout, /REQUEST ID\s+NAME\s+PHRASE\s+AGE/);
  assert.ok(listed.stdout.includes(made.id));
  assert.ok(listed.stdout.includes(made.phrase));
  assert.equal(listed.stdout.includes(made.secret), false);

  const json = await run(t, ["pending", "--json"], { MOSHPIT_STATE_DIR: stateDir });
  assert.equal(json.code, 0);
  const parsed = parseEnvelope(json.stdout, "devices", { exitCode: 0 });
  assert.deepEqual(parsed.result.map((row) => [row.id, row.phrase]), [[made.id, made.phrase]]);
  assert.equal(json.stdout.includes(made.secret), false);
});

test("devices and devices list show the approved devices", async (t) => {
  const { stateDir, store } = await host(t);
  const grant = await store.issueGrant({ name: "phone", owner: OWNER });
  await store.pair({ secret: grant.secret, owner: OWNER });
  for (const args of [[], ["list"]]) {
    const listed = await run(t, [...args, "--state-dir", stateDir]);
    assert.equal(listed.code, 0, args.join(" "));
    assert.match(listed.stdout, /DEVICE ID\s+NAME\s+OWNER\s+STATUS\s+EXPIRES\n.*phone/);
  }
  const json = parseEnvelope((await run(t, ["list", "--json", "--state-dir", stateDir])).stdout, "devices", { exitCode: 0 });
  assert.deepEqual(json.result.map((device) => device.name), ["phone"]);
});

test("approve and reject refuse without --yes when no terminal can confirm, and change nothing", async (t) => {
  const { stateDir, store, request } = await host(t);
  const made = await request();
  for (const command of ["approve", "reject"]) {
    const refused = await run(t, [command, made.id, "--state-dir", stateDir]);
    assert.equal(refused.code, 30, command);
    assert.match(refused.stderr, /needs confirmation/);
    assert.ok(refused.stderr.includes(made.phrase));
    const json = await run(t, [command, made.id, "--json", "--state-dir", stateDir]);
    assert.equal(json.code, 30);
    assert.equal(parseEnvelope(json.stdout, "devices", { exitCode: 30 }).error.code, "confirmation_required");
  }
  assert.equal(store.enrollmentStatus({ id: made.id, secret: made.secret, owner: OWNER }).status, "pending");
});

test("approve --yes decides as the local admin and prints the name and phrase", async (t) => {
  const { stateDir, store, request } = await host(t);
  const made = await request();
  const approved = await run(t, ["approve", made.id, "--yes", "--state-dir", stateDir]);
  assert.equal(approved.code, 0, approved.stderr);
  assert.ok(approved.stdout.includes(made.phrase));
  assert.match(approved.stdout, /"laptop".*is approved\./);
  const device = await store.redeemEnrollment({ id: made.id, secret: made.secret, owner: OWNER });
  assert.equal(device.name, "laptop");

  const other = await request("stranger");
  const rejected = await run(t, ["reject", other.id, "--yes", "--json", "--state-dir", stateDir]);
  assert.equal(rejected.code, 0);
  assert.deepEqual(parseEnvelope(rejected.stdout, "devices", { exitCode: 0 }), {
    schemaVersion: 1,
    command: "devices",
    ok: true,
    exitCode: 0,
    result: { id: other.id, name: "stranger", phrase: other.phrase, status: "rejected", expiresAt: other.expiresAt },
  });

  const gone = await run(t, ["approve", other.id, "--yes", "--state-dir", stateDir]);
  assert.equal(gone.code, 1);
  assert.match(gone.stderr, /No access request with that id is waiting/);
});

test("on a terminal, approve shows the phrase and acts only on yes", async (t) => {
  const { stateDir, store, request } = await host(t);
  const made = await request();
  const declined = terminal({ isTTY: true, answer: false });
  await main(["approve", made.id, "--state-dir", stateDir], { io: declined.io, env: {}, context: declined.context });
  assert.equal(declined.io.exitCode, 1);
  assert.equal(declined.asked.length, 1);
  assert.ok(declined.asked[0].includes(made.phrase));
  assert.ok(declined.asked[0].includes('"laptop"'));
  assert.equal(store.enrollmentStatus({ id: made.id, secret: made.secret, owner: OWNER }).status, "pending");

  const accepted = terminal({ isTTY: true, answer: true });
  await main(["approve", made.id, "--state-dir", stateDir], { io: accepted.io, env: {}, context: accepted.context });
  assert.equal(accepted.io.exitCode, 0, accepted.stderr());
  assert.equal(store.enrollmentStatus({ id: made.id, secret: made.secret, owner: OWNER }).status, "approved");

  const skipped = terminal({ isTTY: true, answer: false });
  const other = await request("other");
  await main(["reject", other.id, "--yes", "--state-dir", stateDir], { io: skipped.io, env: {}, context: skipped.context });
  assert.equal(skipped.io.exitCode, 0);
  assert.equal(skipped.asked.length, 0);
});

test("usage errors exit 2, and the admin command keeps its own request actions", async (t) => {
  for (const args of [["approve"], ["pending", "extra"], ["pending", "--yes"], ["frobnicate"], ["--nope"]]) {
    const result = await run(t, args);
    assert.equal(result.code, 2, args.join(" "));
    assert.match(result.stderr, /usage: moshpit devices/);
  }
  assert.deepEqual(parseAdminArgs(["requests"], {}).message, { action: "requests" });
  assert.deepEqual(parseAdminArgs(["approve", "abc"], {}).message, { action: "approve", requestId: "abc" });
  assert.equal(parseAdminArgs(["reject"], {}).error.code, "admin_usage");

  const { stateDir, request } = await host(t);
  const made = await request();
  const listed = await sendAdminRequest({ action: "requests" }, { stateDir });
  assert.deepEqual(listed.result.map((row) => row.id), [made.id]);
  const rejected = await sendAdminRequest({ action: "reject", requestId: made.id }, { stateDir });
  assert.equal(rejected.result.status, "rejected");
});

// The state directory comes from the host config the way the bridge resolves
// it: --state-dir, then the config named by MOSHPIT_CONFIG, then
// MOSHPIT_STATE_DIR, then the default.
async function configuredHost(t) {
  const served = await host(t);
  const dir = await mkdtemp(path.join(os.tmpdir(), "mp-dcfg-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = path.join(dir, "config.json");
  const origin = "https://box.tail1.ts.net:8803";
  await writeFile(
    config,
    JSON.stringify({
      schemaVersion: 1,
      authMode: "tailscale",
      trustedOwner: OWNER,
      publicOrigin: origin,
      allowedAuthorities: [new URL(origin).host],
      stateDir: served.stateDir,
    }),
    { mode: 0o600 },
  );
  return { ...served, config, dir };
}

test("devices finds the state directory in the config MOSHPIT_CONFIG names", async (t) => {
  const { config, request } = await configuredHost(t);
  const made = await request();
  const listed = await run(t, ["pending", "--json"], { MOSHPIT_CONFIG: config });
  assert.equal(listed.code, 0, listed.stderr);
  assert.deepEqual(parseEnvelope(listed.stdout, "devices", { exitCode: 0 }).result.map((row) => row.id), [made.id]);
});

test("--state-dir wins over the config's state directory", async (t) => {
  const { config, stateDir } = await configuredHost(t);
  const elsewhere = await run(t, ["pending", "--json", "--state-dir", path.join(stateDir, "nowhere")], { MOSHPIT_CONFIG: config });
  assert.equal(elsewhere.code, 1);
  assert.equal(parseEnvelope(elsewhere.stdout, "devices", { exitCode: 1 }).error.code, "admin_bridge_unreachable");
});

test("a state directory set both in the config and the environment is refused, as the bridge refuses it", async (t) => {
  const { config, stateDir } = await configuredHost(t);
  const doubled = await run(t, ["pending", "--json"], { MOSHPIT_CONFIG: config, MOSHPIT_STATE_DIR: stateDir });
  assert.equal(doubled.code, 1);
  const error = parseEnvelope(doubled.stdout, "devices", { exitCode: 1 }).error;
  assert.equal(error.code, "config_invalid");
  assert.match(error.message, /MOSHPIT_STATE_DIR/);
});
