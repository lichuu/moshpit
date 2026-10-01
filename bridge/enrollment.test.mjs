import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { sendAdminRequest } from "./admin.mjs";
import { MAX_PENDING_GRANTS, PAIRING_ATTEMPT_LIMIT, STATUS_LIMIT_PER_REQUEST } from "./devices.mjs";
import { boundaryEnv, bridgeCommand, freePort, isolatedEnv, pairDevice } from "./test-support.mjs";

// The request/approval flow through a running bridge: which authority each
// route needs, what it discloses, and the one-time redemption.

const USER = "enroll-test";

async function startBridge(t, extraEnv = {}) {
  const scratch = await mkdtemp(path.join(tmpdir(), "mp-enr-"));
  const port = await freePort();
  const child = spawn(...bridgeCommand(), {
    env: {
      ...isolatedEnv(),
      ...boundaryEnv(port),
      MOSHPIT_BIND: "127.0.0.1",
      MOSHPIT_STATE_DIR: scratch,
      MOSHPIT_HERDR_BIN: "",
      MOSHPIT_AUTH_MODE: "tailscale",
      MOSHPIT_TRUSTED_USER: USER,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  t.after(async () => {
    child.kill("SIGTERM");
    await exited.catch(() => undefined);
    await rm(scratch, { recursive: true, force: true });
  });
  await Promise.race([once(child.stdout, "data"), exited.then(() => assert.fail("the bridge exited at startup"))]);
  const origin = `http://127.0.0.1:${port}`;
  const identity = { "content-type": "application/json", "tailscale-user-login": USER, origin };

  async function call(method, route, { body, device, headers = identity } = {}) {
    const response = await fetch(`${origin}${route}`, {
      method,
      headers: { ...headers, ...(device ? { "x-moshpit-device": device } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  }
  const audit = async () =>
    (await readFile(path.join(scratch, "audit.jsonl"), "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { scratch, origin, identity, call, audit, pair: (name) => pairDevice(origin, identity, { stateDir: scratch, name }) };
}

const proofOf = (request) => ({ id: request.id, secret: request.secret });

test("identity may request, poll and redeem, but only an approved device lists or decides", async (t) => {
  const bridge = await startBridge(t);
  const anonymous = { "content-type": "application/json", origin: bridge.origin };
  for (const [method, route] of [
    ["POST", "/api/enrollment/request"],
    ["POST", "/api/enrollment/status"],
    ["POST", "/api/enrollment/redeem"],
    ["GET", "/api/enrollment/requests"],
    ["POST", "/api/enrollment/decision"],
  ]) {
    const answer = await bridge.call(method, route, { headers: anonymous, ...(method === "POST" ? { body: {} } : {}) });
    assert.equal(answer.status, 401, `${route} without identity`);
    assert.equal(answer.body.error.code, "identity_required");
  }

  const created = await bridge.call("POST", "/api/enrollment/request", { body: { name: "laptop" } });
  assert.equal(created.status, 200);
  assert.deepEqual(Object.keys(created.body).sort(), ["expiresAt", "id", "phrase", "secret"]);
  const status = await bridge.call("POST", "/api/enrollment/status", { body: proofOf(created.body) });
  assert.equal(status.body.status, "pending");
  assert.equal(status.body.phrase, created.body.phrase);

  const listed = await bridge.call("GET", "/api/enrollment/requests");
  assert.equal(listed.status, 403);
  assert.equal(listed.body.error.code, "device_required");
  for (const decision of ["approve", "reject"]) {
    const decided = await bridge.call("POST", "/api/enrollment/decision", { body: { id: created.body.id, decision } });
    assert.equal(decided.status, 403, decision);
    assert.equal(decided.body.error.code, "device_required");
  }
  const early = await bridge.call("POST", "/api/enrollment/redeem", { body: proofOf(created.body) });
  assert.equal(early.status, 409);
  assert.equal(early.body.error.code, "enrollment_not_approved");
  const wrong = await bridge.call("POST", "/api/enrollment/status", { body: { ...proofOf(created.body), secret: "A".repeat(22) } });
  assert.equal(wrong.status, 404);
  assert.equal(wrong.body.error.code, "enrollment_unknown");
  assert.equal((await bridge.call("GET", "/api/devices", { headers: bridge.identity })).status, 403);
});

test("an approved device approves, the new browser redeems once, and nothing secret is listed or audited", async (t) => {
  const bridge = await startBridge(t);
  const approver = await bridge.pair("phone");
  const created = (await bridge.call("POST", "/api/enrollment/request", { body: { name: "laptop" } })).body;

  const listed = await bridge.call("GET", "/api/enrollment/requests", { device: approver });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.length, 1);
  assert.deepEqual(Object.keys(listed.body[0]).sort(), ["ageMs", "createdAt", "expiresAt", "id", "name", "phrase"]);
  assert.equal(listed.body[0].phrase, created.phrase);

  const decided = await bridge.call("POST", "/api/enrollment/decision", { device: approver, body: { id: created.id, decision: "approve" } });
  assert.equal(decided.status, 200);
  assert.equal(decided.body.status, "approved");

  const redeemed = await bridge.call("POST", "/api/enrollment/redeem", { body: proofOf(created) });
  assert.equal(redeemed.status, 200);
  assert.deepEqual(Object.keys(redeemed.body).sort(), ["deviceId", "deviceSecret", "expiresAt"]);
  const credential = `${redeemed.body.deviceId}.${redeemed.body.deviceSecret}`;
  const devices = await bridge.call("GET", "/api/devices", { device: credential });
  assert.equal(devices.status, 200);
  assert.deepEqual(devices.body.map((device) => device.name).sort(), ["laptop", "phone"]);

  const again = await bridge.call("POST", "/api/enrollment/redeem", { body: proofOf(created) });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, "enrollment_consumed");
  assert.equal((await bridge.call("POST", "/api/enrollment/status", { body: proofOf(created) })).body.status, "consumed");
  assert.deepEqual((await bridge.call("GET", "/api/enrollment/requests", { device: approver })).body, []);

  const secrets = [
    created.secret,
    createHash("sha256").update(created.secret).digest("hex"),
    redeemed.body.deviceSecret,
    approver.split(".")[1],
  ];
  const entries = (await bridge.audit()).filter((entry) => entry.kind.startsWith("enrollment-"));
  assert.deepEqual(entries.map((entry) => entry.kind), ["enrollment-request", "enrollment-decision", "enrollment-redeem"]);
  for (const entry of entries)
    for (const key of Object.keys(entry)) assert.ok(["at", "kind", "requestId", "deviceId", "decision", "approver"].includes(key), key);
  const audited = await readFile(path.join(bridge.scratch, "audit.jsonl"), "utf8");
  for (const secret of [...secrets, created.phrase]) assert.equal(audited.includes(secret), false);
  for (const secret of secrets) assert.equal(JSON.stringify(listed.body).includes(secret), false);
});

test("a rejected request cannot redeem", async (t) => {
  const bridge = await startBridge(t);
  const approver = await bridge.pair("phone");
  const created = (await bridge.call("POST", "/api/enrollment/request", { body: { name: "stranger" } })).body;
  const decided = await bridge.call("POST", "/api/enrollment/decision", { device: approver, body: { id: created.id, decision: "reject" } });
  assert.equal(decided.body.status, "rejected");
  const redeemed = await bridge.call("POST", "/api/enrollment/redeem", { body: proofOf(created) });
  assert.equal(redeemed.status, 403);
  assert.equal(redeemed.body.error.code, "enrollment_rejected");
});

test("a revoked device cannot approve, and its earlier approval does not redeem", async (t) => {
  const bridge = await startBridge(t);
  const keeper = await bridge.pair("keeper");
  const doomed = await bridge.pair("doomed");
  const early = (await bridge.call("POST", "/api/enrollment/request", { body: { name: "early" } })).body;
  await bridge.call("POST", "/api/enrollment/decision", { device: doomed, body: { id: early.id, decision: "approve" } });
  const revoked = await bridge.call("POST", "/api/devices/revoke", { device: keeper, body: { deviceId: doomed.split(".")[0] } });
  assert.equal(revoked.status, 200);

  const late = (await bridge.call("POST", "/api/enrollment/request", { body: { name: "late" } })).body;
  const refused = await bridge.call("POST", "/api/enrollment/decision", { device: doomed, body: { id: late.id, decision: "approve" } });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.code, "device_revoked");
  const listed = await bridge.call("GET", "/api/enrollment/requests", { device: doomed });
  assert.equal(listed.status, 403);

  const stale = await bridge.call("POST", "/api/enrollment/redeem", { body: proofOf(early) });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, "enrollment_not_approved");
  assert.equal((await bridge.call("POST", "/api/enrollment/status", { body: proofOf(early) })).body.status, "pending");
});

test("a formerly revoked browser redeems a freshly approved request", async (t) => {
  const bridge = await startBridge(t);
  const keeper = await bridge.pair("phone");
  const old = await bridge.pair("laptop");
  const revoked = await bridge.call("POST", "/api/devices/revoke", { device: old, body: { deviceId: old.split(".")[0] } });
  assert.equal(revoked.status, 200);
  assert.equal((await bridge.call("GET", "/api/devices", { device: old })).body.error.code, "device_revoked");

  const created = (await bridge.call("POST", "/api/enrollment/request", { body: { name: "laptop again" } })).body;
  const approved = await bridge.call("POST", "/api/enrollment/decision", { device: keeper, body: { id: created.id, decision: "approve" } });
  assert.equal(approved.body.status, "approved");
  const redeemed = await bridge.call("POST", "/api/enrollment/redeem", { device: old, body: proofOf(created) });
  assert.equal(redeemed.status, 200);
  const fresh = `${redeemed.body.deviceId}.${redeemed.body.deviceSecret}`;
  assert.equal((await bridge.call("GET", "/api/devices", { device: fresh })).status, 200);
  assert.equal((await bridge.call("GET", "/api/devices", { device: old })).body.error.code, "device_revoked");
});

test("the admin socket lists and approves as local-admin, with no device at all", async (t) => {
  const bridge = await startBridge(t);
  const created = (await bridge.call("POST", "/api/enrollment/request", { body: { name: "first laptop" } })).body;
  const pending = await sendAdminRequest({ action: "requests" }, { stateDir: bridge.scratch });
  assert.deepEqual(pending.result.map((row) => [row.id, row.phrase]), [[created.id, created.phrase]]);
  assert.equal(JSON.stringify(pending).includes(created.secret), false);
  const approved = await sendAdminRequest({ action: "approve", requestId: created.id }, { stateDir: bridge.scratch });
  assert.equal(approved.result.status, "approved");

  const redeemed = await bridge.call("POST", "/api/enrollment/redeem", { body: proofOf(created) });
  assert.equal(redeemed.status, 200);
  const decision = (await bridge.audit()).find((entry) => entry.kind === "enrollment-decision");
  assert.deepEqual(Object.keys(decision).sort(), ["approver", "at", "decision", "kind", "requestId"]);
  assert.equal(decision.approver, "local-admin");
});

test("creation shares the pairing limits, and status polling is bounded", async (t) => {
  const bridge = await startBridge(t);
  const made = [];
  for (let index = 0; index < MAX_PENDING_GRANTS; index++)
    made.push((await bridge.call("POST", "/api/enrollment/request", { body: { name: `browser ${index}` } })).body);
  const full = await bridge.call("POST", "/api/enrollment/request", { body: { name: "one more" } });
  assert.equal(full.status, 429);
  assert.equal(full.body.error.code, "pairing_grant_limit");
  for (let attempt = MAX_PENDING_GRANTS + 1; attempt < PAIRING_ATTEMPT_LIMIT; attempt++)
    await bridge.call("POST", "/api/enrollment/redeem", { body: { id: made[0].id, secret: "A".repeat(22) } });
  const limited = await bridge.call("POST", "/api/enrollment/redeem", { body: proofOf(made[0]) });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, "pairing_rate_limited");

  for (let read = 0; read < STATUS_LIMIT_PER_REQUEST; read++)
    assert.equal((await bridge.call("POST", "/api/enrollment/status", { body: proofOf(made[1]) })).status, 200);
  const polled = await bridge.call("POST", "/api/enrollment/status", { body: proofOf(made[1]) });
  assert.equal(polled.status, 429);
  assert.equal(polled.body.error.code, "enrollment_rate_limited");
  assert.equal((await bridge.call("POST", "/api/enrollment/status", { body: proofOf(made[2]) })).status, 200);
});

test("the test-only request lifetime shortens requests, and a malformed one refuses startup", async (t) => {
  const bridge = await startBridge(t, { MOSHPIT_TEST_ENROLLMENT_REQUEST_MS: "300" });
  const created = (await bridge.call("POST", "/api/enrollment/request", { body: { name: "brief" } })).body;
  await new Promise((resolve) => setTimeout(resolve, 400));
  const status = await bridge.call("POST", "/api/enrollment/status", { body: proofOf(created) });
  assert.equal(status.body.status, "expired");
  const redeemed = await bridge.call("POST", "/api/enrollment/redeem", { body: proofOf(created) });
  assert.equal(redeemed.status, 410);
  assert.equal(redeemed.body.error.code, "enrollment_expired");

  const port = await freePort();
  const child = spawn(...bridgeCommand(), {
    env: { ...isolatedEnv(), ...boundaryEnv(port), MOSHPIT_STATE_DIR: bridge.scratch, MOSHPIT_TEST_ENROLLMENT_REQUEST_MS: "soon" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const [code] = await once(child, "exit");
  assert.equal(code, 1);
});
