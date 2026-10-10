import assert from "node:assert/strict";
import { createECDH, randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import https from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import webpush from "web-push";
import {
  checkPushEndpoint,
  createPushAgent,
  createPushDelivery,
  createPushReporter,
  createPushSender,
  createTransitionTracker,
  describePushFailure,
  openPushStore,
  parsePushPrivacy,
  parsePushSubscription,
  pushPayloadFor,
  pushPrivacyOf,
  PUSH_HOSTS,
  PUSH_PRIVACY_LEVELS,
  pushAvailability,
} from "./push-delivery.mjs";

const vapid = webpush.generateVAPIDKeys();
webpush.setVapidDetails("mailto:push-test@example.com", vapid.publicKey, vapid.privateKey);

function browserKeys() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") };
}

/** Stands in for DNS: every name resolves to `answers`, and each call is recorded. */
function fakeLookup(answers, calls = []) {
  return (hostname, options, callback) => {
    calls.push(hostname);
    if (options?.all) callback(null, answers);
    else callback(null, answers[0].address, answers[0].family);
  };
}

test("only a bare https endpoint at a known push service is accepted", () => {
  for (const endpoint of [
    "https://fcm.googleapis.com/fcm/send/abc",
    "https://updates.push.services.mozilla.com/wpush/v2/xyz",
    "https://web.push.apple.com/QAB",
    "https://fcm.googleapis.com:443/fcm/send/abc",
  ])
    assert.doesNotThrow(() => checkPushEndpoint(endpoint), endpoint);
  const refused = [
    ["http://fcm.googleapis.com/fcm/send/a", /fcm\.googleapis\.com must use https/],
    ["https://user:pass@fcm.googleapis.com/fcm/send/a", /fcm\.googleapis\.com must not carry credentials/],
    ["https://fcm.googleapis.com/fcm/send/a#frag", /must not carry a fragment/],
    ["https://fcm.googleapis.com/fcm/send/a#", /must not carry a fragment/],
    ["https://fcm.googleapis.com:8443/fcm/send/a", /default https port/],
    ["https://push.example/a", /host push\.example is not a known push service/],
    ["https://fcm.googleapis.com.evil.example/a", /host fcm\.googleapis\.com\.evil\.example is not/],
    ["https://fcm.googleapis.com./a", /host fcm\.googleapis\.com\. is not/],
    ["https://127.0.0.1/a", /host 127\.0\.0\.1 is not/],
    ["https://[::1]/a", /host \[::1\] is not/],
    ["https://localhost/a", /host localhost is not/],
    ["not a url", /Invalid push subscription/],
    [42, /Invalid push subscription/],
  ];
  for (const [endpoint, message] of refused) {
    assert.throws(() => checkPushEndpoint(endpoint), (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.code, "push_endpoint_invalid");
      assert.match(error.message, message);
      return true;
    }, String(endpoint));
  }
  assert.deepEqual([...PUSH_HOSTS].sort(), ["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com"]);
});

test("a subscription keeps only the fields sending needs", () => {
  const keys = browserKeys();
  assert.deepEqual(
    parsePushSubscription({ endpoint: "https://web.push.apple.com/QAB", keys: { ...keys, extra: 1 }, expirationTime: 5, other: "x" }),
    { endpoint: "https://web.push.apple.com/QAB", keys, expirationTime: 5 },
  );
  for (const bad of [null, [], {}, { endpoint: "https://web.push.apple.com/Q" }, { endpoint: "https://web.push.apple.com/Q", keys: { p256dh: "", auth: "a" } }, { endpoint: "https://web.push.apple.com/Q", keys: { p256dh: "a".repeat(300), auth: "a" } }])
    assert.throws(() => parsePushSubscription(bad), /push/i);
});

test("a relay setting turns push off and says why", () => {
  assert.deepEqual(pushAvailability({}), { available: true });
  const off = pushAvailability({ MOSHPIT_PUSH_ENDPOINT: "http://127.0.0.1:9/push" });
  assert.equal(off.available, false);
  assert.match(off.reason, /MOSHPIT_PUSH_ENDPOINT/);
  assert.doesNotMatch(off.reason, /127\.0\.0\.1/, "the configured URL stays out of discovery");
});

// A plain TCP listener is enough to tell whether a connection was attempted:
// TLS starts only after the socket connects.
async function tripwire() {
  let connections = 0;
  const server = createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    get connections() { return connections; },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function request(agent, port) {
  return new Promise((resolve) => {
    const req = https.request({ host: "fcm.googleapis.com", port, path: "/fcm/send/x", method: "POST", agent }, () => resolve(null));
    req.on("error", resolve);
    req.end();
  });
}

test("a push host that resolves to loopback is refused before any connection", async () => {
  const wire = await tripwire();
  try {
    const calls = [];
    const error = await request(createPushAgent({ lookup: fakeLookup([{ address: "127.0.0.1", family: 4 }], calls) }), wire.port);
    assert.match(String(error?.message), /is not allowed/);
    assert.deepEqual(calls, ["fcm.googleapis.com"], "the refusal judged the address DNS returned");
    assert.equal(describePushFailure(error).category, "refused a non-public address");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(wire.connections, 0);
    // Control: the same lookup and listener do connect once loopback is
    // allowed, so the zero above is the filter, not a dead listener.
    await request(createPushAgent({ lookup: fakeLookup([{ address: "127.0.0.1", family: 4 }]), allowIPAddressList: ["127.0.0.1"] }), wire.port);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(wire.connections, 1);
  } finally {
    await wire.close();
  }
});

test("every non-public answer, and any mixed answer, is refused", async () => {
  const answers = [
    [{ address: "::1", family: 6 }],
    [{ address: "::ffff:127.0.0.1", family: 6 }],
    [{ address: "10.1.2.3", family: 4 }],
    [{ address: "172.16.0.9", family: 4 }],
    [{ address: "192.168.1.1", family: 4 }],
    [{ address: "169.254.169.254", family: 4 }],
    [{ address: "100.100.100.100", family: 4 }],
    [{ address: "fd7a:115c:a1e0::1", family: 6 }],
    [{ address: "fe80::1", family: 6 }],
    [{ address: "0.0.0.0", family: 4 }],
    [{ address: "142.250.80.10", family: 4 }, { address: "10.0.0.8", family: 4 }],
    [{ address: "2607:f8b0:4004:c1b::5f", family: 6 }, { address: "::1", family: 6 }],
  ];
  for (const list of answers) {
    const error = await request(createPushAgent({ lookup: fakeLookup(list) }), 443);
    assert.match(String(error?.message), /is not allowed/, JSON.stringify(list));
  }
});

test("web-push sends through the filtering agent and a rebinding host gets no request", async () => {
  const calls = [];
  const send = createPushSender({ webpush, agentOptions: { lookup: fakeLookup([{ address: "127.0.0.1", family: 4 }], calls) } });
  const subscription = { endpoint: "https://fcm.googleapis.com/fcm/send/rebind", keys: browserKeys() };
  await assert.rejects(send(subscription, "{}"), (error) => {
    assert.equal(describePushFailure(error).category, "refused a non-public address");
    return true;
  });
  assert.deepEqual(calls, ["fcm.googleapis.com"]);
});

test("a send that never resolves ends at its deadline", async () => {
  const hang = () => {};
  const send = createPushSender({ webpush, agentOptions: { lookup: hang }, timeoutMs: 150 });
  const started = Date.now();
  await assert.rejects(send({ endpoint: "https://web.push.apple.com/slow", keys: browserKeys() }, "{}"), (error) => {
    assert.equal(describePushFailure(error).category, "timed out");
    return true;
  });
  assert.ok(Date.now() - started < 2000);
});

test("failures are described without bodies or paths and said once per host", () => {
  const lines = [];
  const reporter = createPushReporter((line) => lines.push(line));
  const apple = Object.assign(new Error("Received unexpected response code"), { statusCode: 403, body: '{"reason":"BadJwtToken"}' });
  const fcm = Object.assign(new Error("Received unexpected response code"), { statusCode: 403, body: "the key in the authorization header does not correspond to the sender ID" });
  reporter.failed("https://web.push.apple.com/SECRET-PATH", apple);
  reporter.failed("https://web.push.apple.com/OTHER-PATH", apple);
  reporter.failed("https://fcm.googleapis.com/fcm/send/SECRET", fcm);
  reporter.failed("https://fcm.googleapis.com/fcm/send/SECRET", Object.assign(new Error("x"), { statusCode: 500 }));
  reporter.failed("https://fcm.googleapis.com/fcm/send/SECRET", Object.assign(new Error("connect ECONNREFUSED 1.2.3.4:443"), { code: "ECONNREFUSED" }));
  assert.deepEqual(lines, [
    "push send failed 403 sender rejected (BadJwtToken) to web.push.apple.com",
    "push send failed 403 sender rejected to fcm.googleapis.com",
    "push send failed 500 provider error to fcm.googleapis.com",
    "push send failed - network error (ECONNREFUSED) to fcm.googleapis.com",
  ]);
  assert.doesNotMatch(lines.join("\n"), /SECRET|PATH|sender ID|1\.2\.3\.4/);
  for (let i = 0; i < 200; i += 1) reporter.failed(`https://web.push.apple.com/${i}`, Object.assign(new Error(), { statusCode: 400 + (i % 90) }));
});

async function scratchStore(initial) {
  const dir = await mkdtemp(path.join(tmpdir(), "moshpit-push-store-"));
  const file = path.join(dir, "push.json");
  if (initial !== undefined) await writeFile(file, JSON.stringify(initial), { mode: 0o600 });
  return { dir, file, pushStore: await openPushStore(file), done: () => rm(dir, { recursive: true, force: true }) };
}

test("the store writes privately and atomically, and removes only the current subscription", async () => {
  const a = { endpoint: "https://fcm.googleapis.com/fcm/send/a", keys: browserKeys() };
  const b = { endpoint: "https://fcm.googleapis.com/fcm/send/b", keys: browserKeys() };
  const { dir, file, pushStore, done } = await scratchStore({ one: a, gone: null });
  try {
    assert.deepEqual(pushStore.get("one"), a);
    assert.equal(pushStore.get("gone"), null);
    assert.equal(pushStore.get("__proto__"), null);
    await pushStore.update((list) => ({ ...list, one: b }));
    await pushStore.removeIfCurrent("one", a);
    assert.deepEqual(pushStore.get("one"), b, "a stale removal cannot clear the replacement");
    await pushStore.removeIfCurrent("one", b);
    assert.equal(pushStore.get("one"), null);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.deepEqual((await readdir(dir)).sort(), ["push.json"], "no temp files are left behind");
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { gone: null });
    await assert.rejects(pushStore.update(() => { throw new Error("refused"); }), /refused/);
    await pushStore.update((list) => ({ ...list, two: a }));
    assert.deepEqual(pushStore.get("two"), a, "a failed mutation does not wedge the lane");
    await pushStore.retain((deviceId) => deviceId !== "two");
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {});
  } finally {
    await done();
  }
});

test("a torn store starts empty and says so, and a missing one starts empty quietly", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "moshpit-push-store-"));
  try {
    const file = path.join(dir, "push.json");
    let complaints = 0;
    const onCorrupt = () => (complaints += 1);
    assert.equal((await openPushStore(file, { onCorrupt })).get("a"), null);
    assert.equal(complaints, 0);
    await writeFile(file, '{"a":{"endpoint":"https://fcm.goo', { mode: 0o600 });
    assert.equal((await openPushStore(file, { onCorrupt })).get("a"), null);
    await writeFile(file, "[]", { mode: 0o600 });
    await openPushStore(file, { onCorrupt });
    assert.equal(complaints, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("transitions: first sight is silent, then block and finished turn", () => {
  const observe = createTransitionTracker();
  assert.deepEqual(observe([{ id: "a", status: "blocked" }, { id: "b", status: "working" }]), []);
  assert.deepEqual(observe([{ id: "a", status: "blocked" }, { id: "b", status: "working" }]), []);
  assert.deepEqual(observe([{ id: "a", status: "working" }, { id: "b", status: "idle" }]), [{ id: "b", type: "turn" }]);
  assert.deepEqual(observe([{ id: "a", status: "blocked" }, { id: "b", status: "done" }, { id: "c", status: "blocked" }]), [{ id: "a", type: "block" }]);
});

/** A device table and push store with a send that each test can hold open. */
async function deliveryRig(names) {
  const devices = names.map((name, i) => ({ id: `${name}-id`, name, owner: "owner", active: true, index: i }));
  const subscriptions = Object.fromEntries(devices.map((device) => [device.id, { endpoint: `https://fcm.googleapis.com/fcm/send/${device.name}`, keys: browserKeys() }]));
  const rig = await scratchStore(subscriptions);
  const requests = [];
  const lines = [];
  let inFlight = 0;
  let maxInFlight = 0;
  rig.respond = async () => {};
  const deliver = createPushDelivery({
    pushStore: rig.pushStore,
    devices: () => devices,
    activeDevice: ({ deviceId, owner }) => {
      const device = devices.find((candidate) => candidate.id === deviceId);
      if (!device?.active || device.owner !== owner) throw new Error("device_access_denied");
    },
    async send(subscription, body) {
      requests.push({ endpoint: subscription.endpoint, body: JSON.parse(body) });
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await rig.respond(subscription);
      } finally {
        inFlight -= 1;
      }
    },
    reporter: createPushReporter((line) => lines.push(line)),
  });
  return Object.assign(rig, { devices, requests, lines, deliver, maxInFlight: () => maxInFlight });
}

test("delivery sends one request at a time to every active subscription", async () => {
  const rig = await deliveryRig(["phone", "tablet"]);
  try {
    rig.devices[1].active = false;
    const result = await rig.deliver([{ type: "block", agent: "a" }, { type: "turn", agent: "b" }]);
    assert.deepEqual(rig.requests.map((r) => [r.endpoint.split("/").pop(), r.body.type]), [["phone", "block"], ["phone", "turn"]]);
    assert.equal(rig.maxInFlight(), 1);
    assert.deepEqual(result, { sent: 2, gone: 0 });
  } finally {
    await rig.done();
  }
});

test("a device revoked while earlier sends are in flight gets no request", async () => {
  const rig = await deliveryRig(["keeper", "doomed"]);
  try {
    let release;
    rig.respond = (subscription) => subscription.endpoint.endsWith("/keeper") ? new Promise((resolve) => (release = resolve)) : undefined;
    const running = rig.deliver([{ type: "block", agent: "a" }]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(rig.requests.length, 1);
    rig.devices[1].active = false; // revoked (or expired) mid-queue
    release();
    await running;
    assert.deepEqual(rig.requests.map((r) => r.endpoint), ["https://fcm.googleapis.com/fcm/send/keeper"]);
  } finally {
    await rig.done();
  }
});

test("a subscription replaced mid-queue is neither sent to nor cleared by its old response", async () => {
  const rig = await deliveryRig(["first", "swap"]);
  try {
    const replacement = { endpoint: "https://fcm.googleapis.com/fcm/send/new", keys: browserKeys() };
    let release;
    // Only the first request is held; later ones answer at once.
    rig.respond = (subscription) => {
      if (subscription.endpoint.endsWith("/first") && !release) return new Promise((resolve) => (release = resolve));
      return undefined;
    };
    const running = rig.deliver([{ type: "block", agent: "a" }, { type: "turn", agent: "a" }]);
    await new Promise((resolve) => setImmediate(resolve));
    await rig.pushStore.update((list) => ({ ...list, "swap-id": replacement }));
    release();
    await running;
    assert.ok(!rig.requests.some((r) => r.endpoint.endsWith("/swap")), JSON.stringify(rig.requests));
    assert.deepEqual(rig.pushStore.get("swap-id"), replacement);
  } finally {
    await rig.done();
  }
});

test("404 and 410 clear the subscription only while it is still current", async () => {
  const rig = await deliveryRig(["gone", "moved", "fine"]);
  try {
    const replacement = { endpoint: "https://fcm.googleapis.com/fcm/send/moved-new", keys: browserKeys() };
    rig.respond = async (subscription) => {
      if (subscription.endpoint.endsWith("/gone")) throw Object.assign(new Error("gone"), { statusCode: 410 });
      if (subscription.endpoint.endsWith("/moved")) {
        // The browser re-subscribed while this request was in flight.
        await rig.pushStore.update((list) => ({ ...list, "moved-id": replacement }));
        throw Object.assign(new Error("not found"), { statusCode: 404 });
      }
    };
    const result = await rig.deliver([{ type: "block", agent: "a" }, { type: "block", agent: "b" }]);
    assert.equal(rig.pushStore.get("gone-id"), null);
    assert.deepEqual(rig.pushStore.get("moved-id"), replacement);
    assert.ok(rig.pushStore.get("fine-id"));
    assert.equal(rig.requests.filter((r) => r.endpoint.endsWith("/gone")).length, 1, "a gone endpoint is not retried in the same run");
    assert.equal(result.gone, 2);
    assert.deepEqual(rig.lines, []);
  } finally {
    await rig.done();
  }
});

test("a sender-side rejection is reported once and keeps the subscription", async () => {
  const rig = await deliveryRig(["denied"]);
  try {
    rig.respond = async () => { throw Object.assign(new Error("Received unexpected response code"), { statusCode: 403, body: "private detail" }); };
    await rig.deliver([{ type: "block", agent: "a" }, { type: "turn", agent: "a" }]);
    await rig.deliver([{ type: "block", agent: "a" }]);
    assert.equal(rig.requests.length, 3);
    assert.deepEqual(rig.lines, ["push send failed 403 sender rejected to fcm.googleapis.com"]);
    assert.ok(rig.pushStore.get("denied-id"));
  } finally {
    await rig.done();
  }
});

test("a saved subscription outside the allowlist is skipped and named", async () => {
  const rig = await deliveryRig(["legacy", "broken", "ok"]);
  try {
    await rig.pushStore.update((list) => ({
      ...list,
      "legacy-id": { endpoint: "https://push.example/old", keys: browserKeys() },
      "broken-id": { endpoint: "https://fcm.googleapis.com/fcm/send/broken" },
    }));
    await rig.deliver([{ type: "block", agent: "a" }]);
    assert.deepEqual(rig.requests.map((r) => r.endpoint), ["https://fcm.googleapis.com/fcm/send/ok"]);
    assert.deepEqual(rig.lines, [
      "push skipped for push.example: Push endpoint host push.example is not a known push service (fcm.googleapis.com, updates.push.services.mozilla.com, web.push.apple.com).",
      "push skipped for fcm.googleapis.com: Invalid push subscription.",
    ]);
  } finally {
    await rig.done();
  }
});

const FULL_PAYLOAD = { type: "block", agent: "w1:p2", name: "refactor-auth", prompt: "Allow rm -rf build?", url: "/?tab=steer&agent=w1:p2" };

test("each privacy level carries exactly its allowed fields", () => {
  assert.deepEqual(PUSH_PRIVACY_LEVELS, ["full", "name", "generic"]);
  assert.deepEqual(pushPayloadFor(FULL_PAYLOAD, "full"), FULL_PAYLOAD);
  assert.deepEqual(pushPayloadFor(FULL_PAYLOAD, "name"), { type: "block", agent: "w1:p2", name: "refactor-auth", url: "/?tab=steer&agent=w1:p2" });
  assert.deepEqual(pushPayloadFor(FULL_PAYLOAD, "generic"), { type: "block", url: "/?tab=steer&agent=w1:p2" });
  // A field the sender left undefined is absent, not present and empty, and an
  // extra field is never passed through.
  const turn = { type: "turn", agent: "w1:p2", name: "refactor-auth", prompt: undefined, url: "/", output: "secret" };
  assert.deepEqual(Object.keys(pushPayloadFor(turn, "full")), ["type", "agent", "name", "url"]);
  assert.deepEqual(Object.keys(pushPayloadFor(turn, "generic")), ["type", "url"]);
  const wire = JSON.stringify(pushPayloadFor(FULL_PAYLOAD, "generic"));
  for (const withheld of ["refactor-auth", "rm -rf", "name", "prompt"]) assert.ok(!wire.includes(withheld), withheld);
});

test("a missing or unknown stored level sends in full, and a bad requested level is rejected", () => {
  for (const entry of [undefined, null, {}, { privacy: undefined }, { privacy: "everything" }, { privacy: 2 }, { privacy: "FULL" }])
    assert.equal(pushPrivacyOf(entry), "full", JSON.stringify(entry));
  for (const level of PUSH_PRIVACY_LEVELS) {
    assert.equal(pushPrivacyOf({ privacy: level }), level);
    assert.equal(parsePushPrivacy(level), level);
  }
  for (const bad of ["everything", "", "FULL", null, 1, ["full"], {}, true]) {
    assert.throws(() => parsePushPrivacy(bad), (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.code, "push_privacy_invalid");
      assert.match(error.message, /full, name, generic/);
      return true;
    }, JSON.stringify(bad));
  }
});

test("delivery builds each device's payload at its own level and rereads it at send time", async () => {
  const rig = await deliveryRig(["open", "named", "plain", "legacy", "odd"]);
  try {
    await rig.pushStore.update((list) => ({
      ...list,
      "open-id": { ...list["open-id"], privacy: "full" },
      "named-id": { ...list["named-id"], privacy: "name" },
      "plain-id": { ...list["plain-id"], privacy: "generic" },
      "odd-id": { ...list["odd-id"], privacy: "future-level" },
    }));
    await rig.deliver([FULL_PAYLOAD]);
    const bodies = Object.fromEntries(rig.requests.map((r) => [r.endpoint.split("/").pop(), r.body]));
    assert.deepEqual(bodies.open, FULL_PAYLOAD);
    assert.deepEqual(bodies.named, { type: "block", agent: "w1:p2", name: "refactor-auth", url: FULL_PAYLOAD.url });
    assert.deepEqual(bodies.plain, { type: "block", url: FULL_PAYLOAD.url });
    assert.deepEqual(bodies.legacy, FULL_PAYLOAD, "a subscription saved before the setting existed is sent in full");
    assert.deepEqual(bodies.odd, FULL_PAYLOAD, "an unknown stored level is sent in full");

    // Raising privacy while an earlier send is in flight applies to the next one.
    rig.requests.length = 0;
    let release;
    rig.respond = (subscription) => subscription.endpoint.endsWith("/open") ? new Promise((resolve) => (release = resolve)) : undefined;
    const running = rig.deliver([FULL_PAYLOAD]);
    await new Promise((resolve) => setImmediate(resolve));
    await rig.pushStore.update((list) => ({ ...list, "named-id": { ...list["named-id"], privacy: "generic" } }));
    release();
    await running;
    assert.deepEqual(rig.requests.find((r) => r.endpoint.endsWith("/named")).body, { type: "block", url: FULL_PAYLOAD.url });
  } finally {
    await rig.done();
  }
});
