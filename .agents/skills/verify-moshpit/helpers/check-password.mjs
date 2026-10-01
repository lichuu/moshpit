import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import {
  createPasswordAuth,
  SESSION_MS,
  LOGIN_WINDOW_MS,
  LOGIN_LIMIT,
} from "../../../../bridge/auth.mjs";
import {
  boundaryEnv,
  freePort,
  isolatedEnv,
  pairDevice,
  passwordEnv,
  terminalTicket,
} from "../../../../bridge/test-support.mjs";

let time = 0;
const auth = createPasswordAuth("fixture-password", () => time);
assert.equal(auth.login(null).status, 401);
assert.equal(auth.login("wrong").status, 401);
const first = auth.login("fixture-password").token;
assert.ok(auth.valid(first));
time = SESSION_MS - 1;
assert.ok(auth.valid(first));
time++;
assert.equal(auth.valid(first), false);
const second = auth.login("fixture-password").token;
auth.revoke(second);
assert.equal(auth.valid(second), false);
auth.revoke(second);
const limited = createPasswordAuth("fixture-password", () => time);
for (let i = 0; i < LOGIN_LIMIT; i++)
  assert.equal(limited.login("wrong").status, 401);
assert.equal(limited.login("fixture-password").status, 429);
time += LOGIN_WINDOW_MS;
assert.equal(limited.login("fixture-password").status, 200);
console.log("ok   session expiry, revocation, and throttle recovery");

// The same policy through a live, isolated password-mode bridge: none of the
// caller's MOSHPIT_* settings, a throwaway state directory, the demo herdr.
const port = await freePort();
const origin = `http://127.0.0.1:${port}`;
const scratch = await mkdtemp(path.join(tmpdir(), "moshpit-password-"));
const bridge = spawn(process.execPath, ["bridge/index.mjs"], {
  env: {
    ...isolatedEnv(),
    ...boundaryEnv(port),
    ...(await passwordEnv(scratch, "fixture-password")),
    MOSHPIT_BIND: "127.0.0.1",
    MOSHPIT_STATE_DIR: scratch,
    MOSHPIT_HERDR_BIN: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
const exited = once(bridge, "exit");
let stderr = "";
bridge.stderr.on("data", (chunk) => (stderr += chunk));
let socket;
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Bridge startup timed out")), 10000);
    bridge.stdout.on("data", (chunk) => {
      if (String(chunk).includes("moshpit-bridge")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    bridge.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Bridge exited ${code}: ${stderr.trim()}`));
    });
  });
  const request = (route, { method = "GET", headers = {}, body } = {}) =>
    fetch(`${origin}${route}`, {
      method,
      headers: { origin, "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const login = (password) => request("/api/login", { method: "POST", body: { password } });

  assert.equal((await request("/api/snapshot")).status, 401);
  const response = await login("fixture-password");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("set-cookie"), null, "the session is a bearer token, never a cookie");
  const { token } = await response.json();
  const identity = { authorization: `Bearer ${token}` };
  const headers = { ...identity, "x-moshpit-device": await pairDevice(origin, identity, { stateDir: scratch }) };
  const snapshot = await request("/api/snapshot", { headers });
  assert.equal(snapshot.status, 200);
  const agent = (await snapshot.json()).agents[0];
  const detail = await request(`/api/agent-detail?target=${encodeURIComponent(agent.id)}`, { headers });
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).agentId, agent.id);
  console.log("ok   live login, pairing, snapshot, and agent detail");

  socket = new WebSocket(`ws://127.0.0.1:${port}/pty?${await terminalTicket(origin, headers, agent.id)}`, {
    headers: { origin },
  });
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error("terminal socket failed to open"));
  });
  const closed = new Promise((resolve) => (socket.onclose = resolve));
  const logout = await request("/api/logout", { method: "POST", headers: identity, body: {} });
  assert.equal(logout.status, 200);
  await Promise.race([
    closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Logout did not close terminal")), 3000).unref()),
  ]);
  assert.equal((await request("/api/snapshot", { headers })).status, 401);
  console.log("ok   logout revokes the bearer and closes that session's open terminal");

  // The attempt budget is global and counted before verification, so the
  // correct password is refused too once it is spent.
  let throttled;
  for (let i = 0; i <= LOGIN_LIMIT && !throttled; i++) {
    const attempt = await login("wrong");
    if (attempt.status === 429) throttled = attempt;
    else assert.equal(attempt.status, 401);
  }
  assert.ok(throttled, `no 429 within ${LOGIN_LIMIT + 1} attempts`);
  assert.ok(Number(throttled.headers.get("retry-after")) > 0);
  assert.equal((await login("fixture-password")).status, 429);
  console.log("ok   live login limit returns 429 and Retry-After");
} finally {
  socket?.close();
  bridge.kill();
  // A bridge wedged past SIGTERM would block here forever. node-checks now
  // caps that, but it caps it with a SIGKILL to the whole group -- so without
  // an escalation here the wedge becomes a killed run rather than a failed
  // check. Escalate, and let the assertion be the thing that reports.
  await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, 3000)).then(() => {
      bridge.kill("SIGKILL");
      return exited;
    }),
  ]);
  await rm(scratch, { recursive: true, force: true });
}
