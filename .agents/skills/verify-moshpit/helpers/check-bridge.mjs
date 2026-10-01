import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  boundaryEnv,
  freePort,
  isolatedEnv,
  pairDevice,
  passwordEnv,
  terminalTicket,
} from "../../../../bridge/test-support.mjs";

// End to end over one isolated bridge in front of the demo herdr: identity,
// device approval, HTTP writes, action validation, the audit trail, and the
// ticketed terminal socket. Uses the same fixtures as the tracked bridge tests
// so this check cannot drift onto a protocol the bridge no longer speaks.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const { herdrInput } = await import(path.join(root, "bridge/herdr.mjs"));
// Since S4, literal text is marked { text }; a bare string is one key name or
// one character, and anything else is refused rather than guessed at.
assert.equal(herdrInput({ text: "hello world" })?.kind, "text");
assert.throws(() => herdrInput("hello world"), { code: "key_unsupported" });
assert.equal(herdrInput(" ")?.kind, "text");
assert.equal(herdrInput("esc")?.kind, "keys");
assert.equal(herdrInput("\r")?.value, "enter");
console.log("ok   herdrInput maps space to text and refuses unmarked text");

// One state directory per bridge. passwordEnv writes the password into the
// directory it is handed, so two bridges sharing one cannot hold distinct
// credentials, device stores or audit logs -- today that is masked only by
// the first bridge exiting before the second is configured.
const dirs = [];
async function freshState() {
  const dir = await mkdtemp(path.join(tmpdir(), "moshpit-bridge-"));
  dirs.push(dir);
  return dir;
}
const state = await freshState();
const children = [];

function spawnBridge(port, dir, extra = {}) {
  const child = spawn(process.execPath, [path.join(root, "bridge/index.mjs")], {
    env: {
      ...isolatedEnv(),
      ...boundaryEnv(port),
      MOSHPIT_BIND: "127.0.0.1",
      MOSHPIT_STATE_DIR: dir,
      MOSHPIT_HERDR_BIN: "",
      ...extra,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve({ code, stderr })));
  return { child, exited };
}

async function eventually(label, predicate, ms = 4000) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

let socket;
try {
  // A bridge that could be reached off the host refuses to start at all.
  const exposedState = await freshState();
  const exposed = spawnBridge(await freePort(), exposedState, {
    ...(await passwordEnv(exposedState)),
    MOSHPIT_BIND: "0.0.0.0",
  });
  const refused = await exposed.exited;
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /loopback only/);
  console.log("ok   0.0.0.0 bind refused");

  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const bridge = spawnBridge(port, state, await passwordEnv(state, "fixture-password"));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("bridge did not start")), 10_000);
    bridge.child.stdout.on("data", (buf) => {
      if (String(buf).includes("moshpit-bridge")) {
        clearTimeout(timer);
        resolve();
      }
    });
    bridge.exited.then(({ code, stderr }) => reject(new Error(`bridge exited ${code}: ${stderr.trim()}`)));
  });

  const request = (route, { method = "GET", headers = {}, body } = {}) =>
    fetch(`${origin}${route}`, {
      method,
      headers: { origin, "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const codeOf = async (res) => (await res.json())?.error?.code;

  const anonymous = await request("/api/snapshot");
  assert.equal(anonymous.status, 401);
  assert.equal(await codeOf(anonymous), "password_required");
  console.log("ok   a read without identity is 401");

  const login = await request("/api/login", { method: "POST", body: { password: "fixture-password" } });
  assert.equal(login.status, 200);
  const identity = { authorization: `Bearer ${(await login.json()).token}` };
  const unpairedRead = await request("/api/snapshot", { headers: identity });
  assert.equal(unpairedRead.status, 403);
  assert.equal(await codeOf(unpairedRead), "device_required");
  const unpairedWrite = await request("/api/action", {
    method: "POST",
    headers: identity,
    body: { kind: "prompt", target: "migrate", text: "y" },
  });
  assert.equal(unpairedWrite.status, 403);
  assert.equal(await codeOf(unpairedWrite), "device_required");
  console.log("ok   identity without an approved device cannot read or write");

  const headers = { ...identity, "x-moshpit-device": await pairDevice(origin, identity, { stateDir: state }) };
  const snapshot = async () => (await request("/api/snapshot", { headers })).json();
  const migrate = async () => (await snapshot()).agents.find((agent) => agent.id === "migrate");
  const lines = async () => (await migrate()).lines.map((row) => row.text);
  assert.equal((await migrate())?.status, "blocked");
  console.log("ok   paired snapshot has the blocked demo agent");

  // security.test.mjs calls /api/vapid only as a readiness probe and ignores
  // the body, so nothing else catches a bridge serving an empty key — which
  // fails push subscription silently in the client.
  const vapid = await (await request("/api/vapid", { headers })).json();
  assert.ok(vapid.publicKey, "/api/vapid serves a public key");
  console.log("ok   /api/vapid serves a public key");

  const action = (body) => request("/api/action", { method: "POST", headers, body });
  // A blocked reply inserts without Enter; the explicit Enter commits it.
  assert.equal((await action({ kind: "prompt", target: "migrate", text: "y" })).status, 200);
  await eventually("prompt echo", async () => (await lines()).includes("> y"));
  assert.equal((await migrate()).status, "blocked", "a blocked reply is inserted, not submitted");
  assert.equal((await action({ kind: "keys", target: "migrate", keys: "enter" })).status, 200);
  await eventually("enter commits", async () => (await lines()).includes("running prisma migrate deploy"));
  console.log("ok   prompt inserts, Enter commits");

  assert.equal((await action({ kind: "prompt", text: "y" })).status, 400);
  assert.equal((await action({ kind: "keys", target: "migrate", keys: [] })).status, 400);
  assert.equal((await action({ kind: "start", cwd: "/tmp/x", agentKind: "crush" })).status, 400);
  assert.equal((await action({ kind: "start", agentKind: "pi" })).status, 400);
  console.log("ok   malformed prompt, keys, and start actions are 400");

  const started = await action({ kind: "start", cwd: "/tmp/x", agentKind: "pi" });
  assert.equal(started.status, 200);
  const { paneId } = await started.json();
  assert.ok(paneId);
  assert.ok((await snapshot()).agents.some((agent) => agent.id === paneId && agent.kind === "pi" && agent.cwd === "/tmp/x"));
  const audit = (await readFile(path.join(state, "audit.jsonl"), "utf8")).trim().split("\n").map((row) => JSON.parse(row));
  assert.ok(audit.some((row) => row.action === "start" && row.paneId === paneId));
  // One line per accepted write, and none for the four rejected ones. An
  // exact list catches a write that stops auditing and a row written twice;
  // no tracked test asserts this (security.test.mjs only reads expiry rows).
  assert.deepEqual(
    audit.filter((row) => row.kind === "action").map((row) => row.action),
    ["prompt", "keys", "start"],
    "the audit has one line per accepted write",
  );
  assert.ok(!audit.some((row) => JSON.stringify(row).includes("fixture-password")), "the audit never records the password");
  console.log("ok   start round-trips and is audited, one line per write");

  // The terminal socket: a ticket and a dump on connect. Since S4 it only
  // views the pane: input on it is refused and never forwarded, and keys and
  // text go over HTTP, where they land in the pane.
  socket = new WebSocket(`ws://127.0.0.1:${port}/pty?${await terminalTicket(origin, headers, "migrate")}`, {
    headers: { origin },
  });
  const frames = [];
  socket.onmessage = (event) => frames.push(String(event.data));
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error("terminal socket failed to open"));
  });
  const seen = (pattern) => frames.some((frame) => pattern.test(frame));
  await eventually("dump on connect", () => seen(/"dump":.*prisma migrate/));
  socket.send(JSON.stringify({ target: "migrate", keys: "esc" }));
  await eventually("socket input refused", () => seen(/terminal_input_http/));
  assert.ok(!seen(/\[esc\]/), "input on the socket never reaches the pane");
  assert.equal((await action({ kind: "keys", target: "migrate", keys: ["esc", { text: "hello world" }] })).status, 200);
  await eventually("esc over HTTP", () => seen(/\[esc\]/));
  await eventually("text over HTTP", () => seen(/hello world/));
  console.log("ok   ticketed terminal dumps on connect, refuses socket input, and shows HTTP keys and text");

  const closed = new Promise((resolve) => (socket.onclose = (event) => resolve(event.code)));
  socket.send(JSON.stringify({ target: "someone-else", keys: "esc" }));
  assert.equal(await closed, 1008);
  console.log("ok   input naming another pane closes the socket (1008)");
} finally {
  socket?.close();
  // SIGTERM is asynchronous: a bridge still flushing its device store or
  // appending to the audit log can recreate the directory after the rm and
  // leave an empty one behind. Wait for each to exit, and escalate so a
  // wedged bridge fails the check instead of hanging it.
  await Promise.all(
    children.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill();
      const exited = new Promise((resolve) => child.on("exit", resolve));
      await Promise.race([
        exited,
        new Promise((resolve) => setTimeout(resolve, 3000)).then(() => {
          child.kill("SIGKILL");
          return exited;
        }),
      ]);
    }),
  );
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
}
