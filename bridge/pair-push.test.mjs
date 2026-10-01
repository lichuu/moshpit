import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import { boundaryEnv, bridgeCommand, freePort, isolatedEnv, pairDevice } from "./test-support.mjs";

// Delivery itself (queue rechecks, 404/410 cleanup, failure reports, the
// filtering agent) is exercised in-process by push-delivery.test.mjs, where
// DNS can be faked. These tests cover what the running bridge owns:
// registration, availability, revocation and startup reconciliation. None of
// them moves an agent, so no test here makes a real push request.

const USER = "push-test";

async function startBridge(extraEnv = {}, scratch) {
  scratch ??= await mkdtemp(path.join(tmpdir(), "moshpit-push-"));
  const port = await freePort();
  const child = spawn(...bridgeCommand(), {
    env: {
      ...isolatedEnv(),
      ...boundaryEnv(port),
      MOSHPIT_BIND: "127.0.0.1",
      MOSHPIT_STATE_DIR: scratch,
      MOSHPIT_POLL_MS: "40",
      MOSHPIT_HERDR_BIN: "",
      MOSHPIT_AUTH_MODE: "tailscale",
      MOSHPIT_TRUSTED_USER: USER,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const errors = [];
  child.stderr.on("data", (c) => errors.push(String(c)));
  await once(child.stdout, "data");
  return { child, scratch, origin: `http://127.0.0.1:${port}`, errors };
}

async function stop(child, scratch, { keep = false } = {}) {
  child.kill("SIGTERM");
  await once(child, "exit").catch(() => undefined);
  if (!keep) await rm(scratch, { recursive: true, force: true });
}

const headers = {
  "content-type": "application/json",
  "tailscale-user-login": USER,
};

const subscription = (tag) => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/${tag}`,
  keys: { p256dh: "BExample", auth: "sEcReT" },
});

// The file appears with the first saved change.
async function saved(scratch) {
  try {
    return JSON.parse(await readFile(path.join(scratch, "push.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

async function register(origin, credential, body) {
  return fetch(`${origin}/api/push-subscription`, {
    method: "POST",
    headers: { ...headers, origin, "x-moshpit-device": credential },
    body: JSON.stringify(body),
  });
}

async function registered(origin, credential, body) {
  const res = await register(origin, credential, body);
  const text = await res.text();
  assert.equal(res.status, 200, text);
}

test("pair retain vs clearPush", async () => {
  const { child, scratch, origin } = await startBridge();
  try {
    const credential = await pairDevice(origin, headers, { stateDir: scratch, name: "dev-1" });
    const deviceId = credential.split(".")[0];
    const sub = subscription("a");
    await registered(origin, credential, { pushSubscription: sub });
    assert.equal((await saved(scratch))[deviceId].endpoint, sub.endpoint);
    await registered(origin, credential, {});
    assert.equal((await saved(scratch))[deviceId].endpoint, sub.endpoint);
    await registered(origin, credential, { pushSubscription: null });
    assert.equal((await saved(scratch))[deviceId].endpoint, sub.endpoint);
    await registered(origin, credential, { clearPush: true });
    assert.equal((await saved(scratch))[deviceId], undefined);
  } finally {
    await stop(child, scratch);
  }
});

test("discovery reports push available on a bridge that can send", async () => {
  const { child, scratch, origin } = await startBridge();
  try {
    const info = await (await fetch(`${origin}/api/auth-info`, { headers: { ...headers, origin } })).json();
    assert.deepEqual(info.push, { available: true });
  } finally {
    await stop(child, scratch);
  }
});

test("discovery names the caller's own login and never the owner, and is not cacheable", async () => {
  const { child, scratch, origin } = await startBridge();
  try {
    const info = (login) =>
      fetch(`${origin}/api/auth-info`, { headers: { origin, ...(login === undefined ? {} : { "tailscale-user-login": login }) } });
    const own = await info(USER);
    assert.equal(own.headers.get("cache-control"), "no-store");
    assert.equal((await own.json()).requesterLogin, USER);
    const other = await (await info("someone-else@example.com")).json();
    assert.equal(other.requesterLogin, "someone-else@example.com");
    assert.doesNotMatch(JSON.stringify(other), new RegExp(USER), "another caller learns nothing about the owner");
    const anonymous = await (await info()).json();
    assert.equal(anonymous.requesterLogin, null);
    assert.doesNotMatch(JSON.stringify(anonymous), new RegExp(USER));
  } finally {
    await stop(child, scratch);
  }
});

test("a relay setting turns push off, says why, and saves nothing", async () => {
  const { child, scratch, origin, errors } = await startBridge({ MOSHPIT_PUSH_ENDPOINT: "http://127.0.0.1:9/push" });
  try {
    const info = await (await fetch(`${origin}/api/auth-info`, { headers: { ...headers, origin } })).json();
    assert.equal(info.push.available, false);
    assert.match(info.push.reason, /MOSHPIT_PUSH_ENDPOINT/);
    assert.doesNotMatch(JSON.stringify(info), /127\.0\.0\.1:9/, "the relay address stays private");

    const credential = await pairDevice(origin, headers, { stateDir: scratch, name: "relay" });
    const res = await register(origin, credential, { pushSubscription: subscription("relay") });
    assert.equal(res.status, 503);
    const { error } = await res.json();
    assert.equal(error.code, "push_unavailable");
    assert.match(error.message, /MOSHPIT_PUSH_ENDPOINT/);
    assert.deepEqual(await saved(scratch), {});
    // Turning notifications off must still work.
    await registered(origin, credential, { clearPush: true });
    assert.match(errors.join(""), /push unavailable: /);
  } finally {
    await stop(child, scratch);
  }
});

test("revoking a device removes its subscription and leaves the others", async () => {
  const { child, scratch, origin } = await startBridge();
  try {
    const keeper = await pairDevice(origin, headers, { stateDir: scratch, name: "keeper" });
    const doomed = await pairDevice(origin, headers, { stateDir: scratch, name: "doomed" });
    await registered(origin, keeper, { pushSubscription: subscription("keeper") });
    await registered(origin, doomed, { pushSubscription: subscription("doomed") });
    const doomedId = doomed.split(".")[0];
    const revoke = await fetch(`${origin}/api/devices/revoke`, {
      method: "POST",
      headers: { ...headers, origin, "x-moshpit-device": keeper },
      body: JSON.stringify({ deviceId: doomedId }),
    });
    assert.equal(revoke.status, 200, await revoke.text());
    const list = await saved(scratch);
    assert.equal(list[doomedId], undefined);
    assert.equal(list[keeper.split(".")[0]].endpoint, subscription("keeper").endpoint);
    // The revoked browser cannot put its subscription back.
    const again = await register(origin, doomed, { pushSubscription: subscription("doomed") });
    assert.equal(again.status, 403);
    assert.equal((await again.json()).error.code, "device_revoked");
  } finally {
    await stop(child, scratch);
  }
});

test("startup drops subscriptions whose device is revoked or unknown", async () => {
  const first = await startBridge();
  let { scratch } = first;
  let keeperId;
  let revokedId;
  try {
    const keeper = await pairDevice(first.origin, headers, { stateDir: scratch, name: "keeper" });
    const revoked = await pairDevice(first.origin, headers, { stateDir: scratch, name: "revoked" });
    keeperId = keeper.split(".")[0];
    revokedId = revoked.split(".")[0];
    await registered(first.origin, keeper, { pushSubscription: subscription("keeper") });
    const res = await fetch(`${first.origin}/api/devices/revoke`, {
      method: "POST",
      headers: { ...headers, origin: first.origin, "x-moshpit-device": keeper },
      body: JSON.stringify({ deviceId: revokedId }),
    });
    assert.equal(res.status, 200, await res.text());
  } finally {
    await stop(first.child, scratch, { keep: true });
  }
  // As if the cleanup after that revocation had failed, and a device had
  // since vanished from the store.
  const orphanId = randomUUID();
  await writeFile(
    path.join(scratch, "push.json"),
    JSON.stringify({ [keeperId]: subscription("keeper"), [revokedId]: subscription("revoked"), [orphanId]: subscription("orphan") }),
    { mode: 0o600 },
  );
  const second = await startBridge({}, scratch);
  ({ scratch } = second);
  try {
    assert.deepEqual(Object.keys(await saved(scratch)), [keeperId]);
  } finally {
    await stop(second.child, scratch);
  }
});
