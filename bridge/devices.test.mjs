import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createDeviceStore,
  DEFAULT_DEVICE_LIFETIME_MS,
  ENROLLMENT_REQUEST_MS,
  LOCAL_ADMIN,
  MAX_ACTIVE_DEVICES,
  MAX_PENDING_GRANTS,
  MAX_STATE_BYTES,
  PAIRING_ATTEMPT_LIMIT,
  PAIRING_GRANT_MS,
  PAIRING_REFUSALS,
  RETIRED_GRANT_MS,
  PAIRING_WINDOW_MS,
  REVOKED_DEVICE_RETENTION_MS,
  STATE_VERSION,
  STATUS_LIMIT_PER_OWNER,
  STATUS_LIMIT_PER_REQUEST,
  STATUS_WINDOW_MS,
  REVOCATION_BYTES,
} from "./devices.mjs";

const OWNER = "you@example.com";
const OTHER = "someone@example.com";
const START = 1_800_000_000_000;
const CROWDED_GRANT_SECRET = "PairingSecret000000000";
const CROWDED_DEVICE_SECRET = "A".repeat(43);
const root = () => process.getuid?.() === 0;
const digestOf = (secret) => createHash("sha256").update(secret).digest("hex");

function clock(start = START) {
  const time = { value: start };
  return { now: () => time.value, advance: (ms) => (time.value += ms), set: (ms) => (time.value = ms) };
}

async function temporaryDir(t, label = "devices") {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), `moshpit-${label}-`));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  return stateDir;
}

async function setup(t, options = {}) {
  const stateDir = await temporaryDir(t);
  const time = clock();
  return { stateDir, time, store: await createDeviceStore({ stateDir, now: time.now, ...options }) };
}

async function approve(store, { name = "phone", owner = OWNER } = {}) {
  const grant = await store.issueGrant({ name, owner });
  const device = await store.pair({ secret: grant.secret, owner });
  return { ...device, credential: `${device.deviceId}.${device.deviceSecret}` };
}

const stateOf = (stateDir) => readFile(path.join(stateDir, "devices.json"), "utf8");

// One approved device and one pending grant beside enough unexpired revoked
// rows to leave exactly `slack` bytes under the capacity rule the store
// enforces: encoded bytes plus room to revoke every device still held.
function crowdedDocument(slack) {
  const document = {
    version: 2,
    devices: [
      {
        id: randomUUID(),
        name: "phone",
        owner: OWNER,
        secretHash: digestOf(CROWDED_DEVICE_SECRET),
        createdAt: START,
        expiresAt: START + DEFAULT_DEVICE_LIFETIME_MS,
        revokedAt: null,
      },
    ],
    grants: [
      {
        secretHash: digestOf(CROWDED_GRANT_SECRET),
        name: "pending",
        owner: OWNER,
        expiresAt: START + PAIRING_GRANT_MS,
      },
    ],
  };
  const capacity = () =>
    Buffer.byteLength(JSON.stringify(document)) +
    REVOCATION_BYTES * document.devices.filter((row) => row.revokedAt === null).length;
  const filler = (index) => ({
    id: randomUUID(),
    name: "n",
    owner: "o",
    secretHash: digestOf(`filler ${index}`),
    createdAt: START,
    expiresAt: START + PAIRING_WINDOW_MS,
    revokedAt: START,
  });
  const rowBytes = Buffer.byteLength(JSON.stringify(filler(0))) + 1;
  const rows = Math.floor((MAX_STATE_BYTES - slack - capacity()) / rowBytes);
  for (let index = 0; index < rows; index++) document.devices.push(filler(index));
  document.devices.at(-1).owner = "o".repeat(1 + MAX_STATE_BYTES - slack - capacity());
  return document;
}

async function crowdedDir(t, document) {
  const stateDir = await temporaryDir(t, "devices-crowded");
  await writeFile(path.join(stateDir, "devices.json"), JSON.stringify(document), { mode: 0o600 });
  return stateDir;
}

test("a pairing grant approves exactly one device, even when raced", async (t) => {
  const { store, time } = await setup(t);
  const grant = await store.issueGrant({ name: "phone", owner: OWNER });
  assert.match(grant.secret, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(grant.expiresAt, time.now() + PAIRING_GRANT_MS);

  const results = await Promise.allSettled([
    store.pair({ secret: grant.secret, owner: OWNER }),
    store.pair({ secret: grant.secret, owner: OWNER }),
    store.pair({ secret: grant.secret, owner: OWNER }),
  ]);
  const paired = results.filter((result) => result.status === "fulfilled");
  assert.equal(paired.length, 1);
  for (const result of results.filter((entry) => entry.status === "rejected"))
    assert.equal(result.reason.code, "pairing_grant_used");

  const device = paired[0].value;
  assert.match(device.deviceId, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  assert.match(device.deviceSecret, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(device.expiresAt, time.now() + DEFAULT_DEVICE_LIFETIME_MS);
  assert.deepEqual(store.authorize({ credential: `${device.deviceId}.${device.deviceSecret}`, owner: OWNER }), {
    deviceId: device.deviceId,
    owner: OWNER,
    name: "phone",
    expiresAt: device.expiresAt,
  });
  assert.equal(store.list().length, 1);
});

test("the device name comes from the pairing request, otherwise from the grant", async (t) => {
  const { store } = await setup(t);
  const named = await store.issueGrant({ name: "grant name", owner: OWNER });
  assert.equal((await store.pair({ secret: named.secret, owner: OWNER })).name, "grant name");
  const renamed = await store.issueGrant({ name: "grant name", owner: OWNER });
  assert.equal((await store.pair({ secret: renamed.secret, name: "browser name", owner: OWNER })).name, "browser name");
  const rejected = await store.issueGrant({ name: "grant name", owner: OWNER });
  await assert.rejects(() => store.pair({ secret: rejected.secret, name: "x".repeat(65), owner: OWNER }), {
    code: "pairing_request_invalid",
    status: 400,
  });
  await assert.rejects(() => store.issueGrant({ name: "line\nbreak", owner: OWNER }), {
    code: "pairing_request_invalid",
  });
  assert.deepEqual(
    store.list().map((row) => row.name),
    ["grant name", "browser name"],
  );
});

test("an approval becomes visible only after it is on disk", async (t) => {
  const { store, stateDir } = await setup(t);
  const grant = await store.issueGrant({ name: "phone", owner: OWNER });
  const pairing = store.pair({ secret: grant.secret, owner: OWNER });
  // Microtasks cannot outrun the event loop's file callbacks, so this observes
  // the store while its replacement of devices.json is still in flight.
  for (let tick = 0; tick < 10; tick++) await null;
  const midflight = store.list();
  const device = await pairing;

  assert.deepEqual(midflight, []);
  assert.equal(store.list().length, 1);
  assert.equal(JSON.parse(await stateOf(stateDir)).devices[0].id, device.deviceId);
});

test("expired and wrong-owner grants are refused without consuming another attempt path", async (t) => {
  const { store, time } = await setup(t);
  const grant = await store.issueGrant({ name: "phone", owner: OWNER });
  await assert.rejects(() => store.pair({ secret: grant.secret, owner: OTHER }), { code: "pairing_grant_wrong_owner" });
  await assert.rejects(() => store.pair({ secret: "not-a-secret", owner: OWNER }), { code: "pairing_grant_invalid" });
  await assert.rejects(() => store.pair({ secret: grant.secret, owner: "" }), { code: "pairing_request_invalid" });

  time.advance(PAIRING_GRANT_MS);
  await assert.rejects(() => store.pair({ secret: grant.secret, owner: OWNER }), { code: "pairing_grant_expired" });
  assert.deepEqual(store.list(), []);
});

test("a credential must be well formed, known, secret-matching and owner-matching", async (t) => {
  const { store } = await setup(t);
  const device = await approve(store);
  for (const credential of [
    undefined,
    "",
    device.deviceId,
    device.deviceSecret,
    `${device.deviceId}.`,
    `${device.deviceId}.${device.deviceSecret}x`,
    `${device.deviceId}.${device.deviceSecret.slice(0, -1)}=`,
    `${randomUUID()}.${device.deviceSecret}`,
    `${device.deviceId}.${"A".repeat(43)}`,
    `${device.deviceId}${device.deviceSecret}`,
  ])
    assert.throws(() => store.authorize({ credential, owner: OWNER }), { code: "device_required", status: 403 });
  assert.throws(() => store.authorize({ credential: device.credential, owner: OTHER }), { code: "device_required" });
  assert.throws(() => store.activeDevice({ deviceId: device.deviceId, owner: OTHER }), { code: "device_required" });
  assert.equal(store.activeDevice({ deviceId: device.deviceId, owner: OWNER }).deviceId, device.deviceId);
});

test("a credential from another host is not accepted here", async (t) => {
  const first = await setup(t);
  const second = {
    stateDir: await temporaryDir(t, "devices-other"),
    time: clock(),
  };
  second.store = await createDeviceStore({ stateDir: second.stateDir, now: second.time.now });
  const device = await approve(first.store);
  assert.throws(() => second.store.authorize({ credential: device.credential, owner: OWNER }), {
    code: "device_required",
  });
  assert.deepEqual(second.store.list(), []);
});

test("revocation and expiry are disclosed only to the matching secret and owner", async (t) => {
  const { store, time } = await setup(t);
  const revoked = await approve(store, { name: "old phone" });
  const expiring = await approve(store, { name: "laptop" });
  await store.revoke(revoked.deviceId);

  assert.throws(() => store.authorize({ credential: revoked.credential, owner: OWNER }), { code: "device_revoked" });
  assert.throws(() => store.authorize({ credential: `${revoked.deviceId}.${expiring.deviceSecret}`, owner: OWNER }), {
    code: "device_required",
  });
  assert.throws(() => store.authorize({ credential: revoked.credential, owner: OTHER }), { code: "device_required" });
  assert.throws(() => store.activeDevice({ deviceId: revoked.deviceId, owner: OWNER }), { code: "device_required" });

  time.advance(DEFAULT_DEVICE_LIFETIME_MS - 1);
  assert.equal(store.authorize({ credential: expiring.credential, owner: OWNER }).deviceId, expiring.deviceId);
  time.advance(1);
  assert.throws(() => store.authorize({ credential: expiring.credential, owner: OWNER }), { code: "device_expired" });
  assert.throws(() => store.authorize({ credential: expiring.credential, owner: OTHER }), { code: "device_required" });
  assert.equal(
    store.list().every((entry) => entry.active === false),
    true,
  );
});

test("revocation is idempotent, keeps the row until expiry and never reactivates it", async (t) => {
  const { store, time } = await setup(t);
  const device = await approve(store);
  const first = await store.revoke(device.deviceId);
  time.advance(1000);
  const second = await store.revoke(device.deviceId);
  assert.equal(second.revokedAt, first.revokedAt);
  assert.equal(second.active, false);

  const grant = await store.issueGrant({ name: "phone", owner: OWNER });
  const replacement = await store.pair({ secret: grant.secret, owner: OWNER });
  assert.notEqual(replacement.deviceId, device.deviceId);
  assert.throws(() => store.authorize({ credential: device.credential, owner: OWNER }), { code: "device_revoked" });

  const rows = store.list();
  assert.equal(rows.length, 2);
  assert.equal(rows.find((row) => row.id === device.deviceId).expiresAt, device.expiresAt);
});

test("approval, revocation and denial survive reopening the state directory", async (t) => {
  const { store, stateDir, time } = await setup(t);
  const device = await approve(store);
  const keeper = await approve(store, { name: "laptop" });

  const restarted = await createDeviceStore({ stateDir, now: time.now });
  assert.equal(restarted.authorize({ credential: device.credential, owner: OWNER }).deviceId, device.deviceId);
  await restarted.revoke(device.deviceId);
  await restarted.revoke(keeper.deviceId);

  const again = await createDeviceStore({ stateDir, now: time.now });
  assert.throws(() => again.authorize({ credential: device.credential, owner: OWNER }), { code: "device_revoked" });
  assert.throws(() => again.authorize({ credential: keeper.credential, owner: OWNER }), { code: "device_revoked" });
  assert.equal(
    again.list().every((row) => row.active === false),
    true,
  );
  assert.throws(() => again.activeDevice({ deviceId: keeper.deviceId, owner: OWNER }), { code: "device_required" });
});

test("a missing state file starts an empty registry that still denies access", async (t) => {
  const stateDir = await temporaryDir(t);
  const store = await createDeviceStore({ stateDir, now: clock().now });
  assert.deepEqual(store.list(), []);
  assert.throws(() => store.authorize({ credential: `${randomUUID()}.${"A".repeat(43)}`, owner: OWNER }), {
    code: "device_required",
  });
  await assert.rejects(() => readFile(path.join(stateDir, "devices.json"), "utf8"), { code: "ENOENT" });
  assert.equal((await stat(stateDir)).mode & 0o777, 0o700);
});

test("only digests reach the disk, under private modes, beside untouched files", async (t) => {
  const stateDir = await temporaryDir(t);
  await chmod(stateDir, 0o755);
  await mkdir(path.join(stateDir, "uploads"), { recursive: true });
  await writeFile(path.join(stateDir, "uploads", "keep.png"), "image bytes");
  const store = await createDeviceStore({ stateDir, now: clock().now });
  assert.equal((await stat(stateDir)).mode & 0o777, 0o700);

  const grant = await store.issueGrant({ name: "phone", owner: OWNER });
  const device = await store.pair({ secret: grant.secret, owner: OWNER });
  const text = await stateOf(stateDir);
  const document = JSON.parse(text);
  assert.equal(document.version, STATE_VERSION);
  assert.equal(document.grants.length, 0);
  assert.equal(text.includes(grant.secret), false);
  assert.equal(text.includes(device.deviceSecret), false);
  assert.equal(document.devices[0].secretHash, createHash("sha256").update(device.deviceSecret).digest("hex"));
  assert.equal((await stat(path.join(stateDir, "devices.json"))).mode & 0o777, 0o600);
  assert.equal(await readFile(path.join(stateDir, "uploads", "keep.png"), "utf8"), "image bytes");

  const pending = await store.issueGrant({ name: "laptop", owner: OWNER });
  const saved = JSON.parse(await stateOf(stateDir));
  assert.equal(saved.grants.length, 1);
  assert.equal(saved.grants[0].secretHash, createHash("sha256").update(pending.secret).digest("hex"));
  assert.equal(JSON.stringify(saved).includes(pending.secret), false);
});

test("a state file left readable by an earlier version is tightened on open", async (t) => {
  const { stateDir, time } = await setup(t);
  const store = await createDeviceStore({ stateDir, now: time.now });
  await approve(store);
  const file = path.join(stateDir, "devices.json");
  await chmod(file, 0o644);
  await createDeviceStore({ stateDir, now: time.now });
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test("unsafe, legacy and corrupt state is refused without clobbering the file", async (t) => {
  const legacyDir = await temporaryDir(t, "devices-legacy");
  const legacy = `[{"deviceId":"phone","pairedAt":1}]`;
  await writeFile(path.join(legacyDir, "devices.json"), legacy, { mode: 0o600 });
  await assert.rejects(() => createDeviceStore({ stateDir: legacyDir, now: clock().now }), {
    code: "device_state_legacy",
  });
  assert.equal(await stateOf(legacyDir), legacy);

  for (const broken of [
    "{",
    "null",
    `{"version":1,"devices":[],"grants":[]}`,
    `{"version":2,"devices":[]}`,
    `{"version":2,"devices":[],"grants":[],"extra":1}`,
    `{"version":2,"devices":[{"id":"not-a-uuid","name":"a","owner":"o","secretHash":"${"0".repeat(64)}","createdAt":1,"expiresAt":2,"revokedAt":null}],"grants":[]}`,
    `{"version":2,"devices":[{"id":"${randomUUID()}","name":"a","owner":"o","secretHash":"nope","createdAt":1,"expiresAt":2,"revokedAt":null}],"grants":[]}`,
    `{"version":2,"devices":[{"id":"${randomUUID()}","name":"a","owner":"o","secretHash":"${"0".repeat(64)}","createdAt":9,"expiresAt":2,"revokedAt":null}],"grants":[]}`,
    `{"version":2,"devices":[{"id":"${randomUUID()}","name":"a","owner":"o","secretHash":"${"0".repeat(64)}","createdAt":1,"expiresAt":2,"revokedAt":null,"role":"admin"}],"grants":[]}`,
    `{"version":2,"devices":[],"grants":[{"secretHash":"${"0".repeat(64)}","name":"a","owner":"o"}]}`,
    `{"version":2,"devices":[{"id":["${randomUUID()}"],"name":"a","owner":"o","secretHash":"${"0".repeat(64)}","createdAt":1,"expiresAt":2,"revokedAt":null}],"grants":[]}`,
    `{"version":2,"devices":[{"id":[["${randomUUID()}"]],"name":"a","owner":"o","secretHash":"${"0".repeat(64)}","createdAt":1,"expiresAt":2,"revokedAt":null}],"grants":[]}`,
    `{"version":2,"devices":[{"id":"${randomUUID().toUpperCase()}","name":"a","owner":"o","secretHash":"${"0".repeat(64)}","createdAt":1,"expiresAt":2,"revokedAt":null}],"grants":[]}`,
    `{"version":2,"devices":[{"id":"${randomUUID()}","name":"a","owner":"o","secretHash":["${"0".repeat(64)}"],"createdAt":1,"expiresAt":2,"revokedAt":null}],"grants":[]}`,
    `{"version":2,"devices":[{"id":"${randomUUID()}","name":"a","owner":"o","secretHash":"${"0".repeat(64)}\\n","createdAt":1,"expiresAt":2,"revokedAt":null}],"grants":[]}`,
    `{"version":2,"devices":[{"id":"${randomUUID()}","name":"a","owner":"o","secretHash":"${"0".repeat(63)}","createdAt":1,"expiresAt":2,"revokedAt":null}],"grants":[]}`,
    `{"version":2,"devices":[],"grants":[{"secretHash":["${"0".repeat(64)}"],"name":"a","owner":"o","expiresAt":9}]}`,
    `{"version":2,"devices":[],"grants":[{"secretHash":"${"0".repeat(64)}\\n","name":"a","owner":"o","expiresAt":9}]}`,
    `{"version":2,"devices":[],"grants":[{"secretHash":null,"name":"a","owner":"o","expiresAt":9}]}`,
    `{"version":2,"devices":[],"grants":[{"secretHash":1234567890,"name":"a","owner":"o","expiresAt":9}]}`,
  ]) {
    const dir = await temporaryDir(t, "devices-broken");
    await writeFile(path.join(dir, "devices.json"), broken, { mode: 0o600 });
    await assert.rejects(() => createDeviceStore({ stateDir: dir, now: clock().now }), { code: "device_state_invalid" });
    assert.equal(await stateOf(dir), broken);
  }

  const duplicated = await temporaryDir(t, "devices-duplicate");
  const id = randomUUID();
  const row = `{"id":"${id}","name":"a","owner":"o","secretHash":"${"0".repeat(64)}","createdAt":1,"expiresAt":2,"revokedAt":null}`;
  await writeFile(path.join(duplicated, "devices.json"), `{"version":2,"devices":[${row},${row}],"grants":[]}`);
  await assert.rejects(() => createDeviceStore({ stateDir: duplicated, now: clock().now }), {
    code: "device_state_invalid",
  });

  const linked = await temporaryDir(t, "devices-symlink");
  const target = path.join(linked, "elsewhere.json");
  await writeFile(target, `{"version":2,"devices":[],"grants":[]}`, { mode: 0o600 });
  await symlink(target, path.join(linked, "devices.json"));
  await assert.rejects(() => createDeviceStore({ stateDir: linked, now: clock().now }), { code: "device_state_unsafe" });
  assert.equal(await readFile(target, "utf8"), `{"version":2,"devices":[],"grants":[]}`);
});

test("a symlinked state directory and a non-directory state path are refused", async (t) => {
  const parent = await temporaryDir(t, "devices-parent");
  const real = path.join(parent, "real");
  await mkdir(real, { mode: 0o700 });
  await symlink(real, path.join(parent, "link"));
  await assert.rejects(() => createDeviceStore({ stateDir: path.join(parent, "link"), now: clock().now }), {
    code: "device_state_unsafe",
  });

  const file = path.join(parent, "file");
  await writeFile(file, "not a directory");
  await assert.rejects(() => createDeviceStore({ stateDir: file, now: clock().now }), { code: "device_state_unsafe" });

  const notRegular = await temporaryDir(t, "devices-notregular");
  await mkdir(path.join(notRegular, "devices.json"), { mode: 0o700 });
  await assert.rejects(() => createDeviceStore({ stateDir: notRegular, now: clock().now }), {
    code: "device_state_unsafe",
  });

  const socketDir = await temporaryDir(t, "devices-socket");
  const server = createServer();
  t.after(() => new Promise((resolve) => server.close(resolve)));
  server.listen(path.join(socketDir, "devices.json"));
  await once(server, "listening");
  await assert.rejects(() => createDeviceStore({ stateDir: socketDir, now: clock().now }), {
    code: "device_state_unsafe",
  });
});

test("pairing attempts are bounded per minute without spending a valid grant", async (t) => {
  const { store, time } = await setup(t);
  const grant = await store.issueGrant({ name: "phone", owner: OWNER });
  for (let attempt = 0; attempt < PAIRING_ATTEMPT_LIMIT; attempt++)
    await assert.rejects(() => store.pair({ secret: "A".repeat(22), owner: OWNER }), {
      code: "pairing_grant_invalid",
    });
  await assert.rejects(() => store.pair({ secret: grant.secret, owner: OWNER }), {
    code: "pairing_rate_limited",
    status: 429,
  });

  time.advance(PAIRING_WINDOW_MS);
  const device = await store.pair({ secret: grant.secret, owner: OWNER });
  assert.equal(store.authorize({ credential: `${device.deviceId}.${device.deviceSecret}`, owner: OWNER }).owner, OWNER);
});

test("pending grants and active devices are capped", async (t) => {
  const { store, time } = await setup(t);
  const grants = [];
  for (let issued = 0; issued < MAX_PENDING_GRANTS; issued++)
    grants.push(await store.issueGrant({ name: `phone ${issued}`, owner: OWNER }));
  await assert.rejects(() => store.issueGrant({ name: "one more", owner: OWNER }), {
    code: "pairing_grant_limit",
    status: 429,
  });

  time.advance(PAIRING_GRANT_MS);
  const fresh = await store.issueGrant({ name: "phone", owner: OWNER });
  await assert.rejects(() => store.pair({ secret: grants[0].secret, owner: OWNER }), {
    code: "pairing_grant_expired",
  });
  const first = await store.pair({ secret: fresh.secret, owner: OWNER });
  assert.ok(first.deviceId);
});

test("the active device quota holds and frees again after revocation", async (t) => {
  const { store, time } = await setup(t);
  const devices = [];
  for (let created = 0; created < MAX_ACTIVE_DEVICES; created++) {
    devices.push(await approve(store, { name: `device ${created}` }));
    time.advance(PAIRING_WINDOW_MS);
  }
  const grant = await store.issueGrant({ name: "one too many", owner: OWNER });
  await assert.rejects(() => store.pair({ secret: grant.secret, owner: OWNER }), {
    code: "device_limit",
    status: 429,
  });

  await store.revoke(devices[0].deviceId);
  const replacement = await store.pair({ secret: grant.secret, owner: OWNER });
  assert.equal(store.list().filter((row) => row.active).length, MAX_ACTIVE_DEVICES);
  assert.equal(store.authorize({ credential: `${replacement.deviceId}.${replacement.deviceSecret}`, owner: OWNER }).deviceId, replacement.deviceId);
});

test("pruning drops rows past their expiry and keeps the rest", async (t) => {
  const { store, stateDir, time } = await setup(t);
  const revoked = await approve(store, { name: "phone" });
  await store.revoke(revoked.deviceId);
  await store.issueGrant({ name: "pending", owner: OWNER });

  assert.deepEqual(await store.prune(), { devices: 0, grants: 0, requests: 0 });
  time.advance(PAIRING_GRANT_MS);
  assert.deepEqual(await store.prune(), { devices: 0, grants: 1, requests: 0 });
  assert.equal(store.list().length, 1);

  time.advance(DEFAULT_DEVICE_LIFETIME_MS);
  assert.deepEqual(await store.prune(), { devices: 1, grants: 0, requests: 0 });
  assert.deepEqual(store.list(), []);
  const saved = JSON.parse(await stateOf(stateDir));
  assert.deepEqual(saved, { version: STATE_VERSION, devices: [], grants: [], requests: [] });
  assert.throws(() => store.authorize({ credential: revoked.credential, owner: OWNER }), { code: "device_required" });
});

test("a response lost after a successful commit leaves no reusable grant", async (t) => {
  const { store, stateDir, time } = await setup(t);
  const grant = await store.issueGrant({ name: "phone", owner: OWNER });
  const device = await store.pair({ secret: grant.secret, owner: OWNER });

  const restarted = await createDeviceStore({ stateDir, now: time.now });
  await assert.rejects(() => restarted.pair({ secret: grant.secret, owner: OWNER }), {
    code: "pairing_grant_invalid",
  });
  assert.equal(restarted.list().length, 1);
  assert.equal(
    restarted.authorize({ credential: `${device.deviceId}.${device.deviceSecret}`, owner: OWNER }).deviceId,
    device.deviceId,
  );
});

test("an approval refused for capacity spends no grant and keeps authorization and revocation", async (t) => {
  const document = crowdedDocument(40);
  const known = document.devices[0];
  const credential = `${known.id}.${CROWDED_DEVICE_SECRET}`;
  const stateDir = await crowdedDir(t, document);
  const time = clock();
  const store = await createDeviceStore({ stateDir, now: time.now });
  const saved = await stateOf(stateDir);

  await assert.rejects(() => store.issueGrant({ name: "laptop", owner: OWNER }), {
    code: "device_state_full",
    status: 429,
  });
  await assert.rejects(() => store.pair({ secret: CROWDED_GRANT_SECRET, owner: OWNER }), {
    code: "device_state_full",
    status: 429,
  });
  assert.equal(await stateOf(stateDir), saved);
  assert.equal(store.authorize({ credential, owner: OWNER }).deviceId, known.id);

  assert.equal((await store.revoke(known.id)).active, false);
  const reopened = await createDeviceStore({ stateDir, now: time.now });
  assert.throws(() => reopened.authorize({ credential, owner: OWNER }), { code: "device_revoked" });

  time.advance(PAIRING_WINDOW_MS + 1);
  const paired = await reopened.pair({ secret: CROWDED_GRANT_SECRET, owner: OWNER });
  assert.equal(paired.name, "pending");
  assert.equal(
    reopened.authorize({ credential: `${paired.deviceId}.${paired.deviceSecret}`, owner: OWNER }).deviceId,
    paired.deviceId,
  );
});

test("every accepted mutation leaves state that reopens", async (t) => {
  const stateDir = await crowdedDir(t, crowdedDocument(40));
  const time = clock();
  const store = await createDeviceStore({ stateDir, now: time.now });

  for (let attempt = 0; attempt < 3; attempt++) {
    await assert.rejects(() => store.issueGrant({ name: `laptop ${attempt}`, owner: OWNER }), {
      code: "device_state_full",
    });
    const reopened = await createDeviceStore({ stateDir, now: time.now });
    assert.equal(reopened.list().length, store.list().length);
  }

  time.advance(PAIRING_WINDOW_MS + 1);
  const issued = await store.issueGrant({ name: "laptop", owner: OWNER });
  const device = await store.pair({ secret: issued.secret, owner: OWNER });
  const reopened = await createDeviceStore({ stateDir, now: time.now });
  assert.equal(reopened.list().length, 2);
  assert.equal(
    reopened.authorize({ credential: `${device.deviceId}.${device.deviceSecret}`, owner: OWNER }).deviceId,
    device.deviceId,
  );
});

test("state without room to revoke the devices it holds refuses to start", async (t) => {
  const document = crowdedDocument(40);
  const text = JSON.stringify({
    ...document,
    devices: document.devices.map((row) => ({ ...row, revokedAt: null })),
  });
  const stateDir = await temporaryDir(t, "devices-headroom");
  await writeFile(path.join(stateDir, "devices.json"), text, { mode: 0o600 });

  assert.ok(Buffer.byteLength(text) <= MAX_STATE_BYTES);
  await assert.rejects(() => createDeviceStore({ stateDir, now: clock().now }), {
    code: "device_state_full",
    status: 500,
  });
  assert.equal(await stateOf(stateDir), text);
});

test("a write that fails before the temporary file retires the store, not the grant", { skip: root() }, async (t) => {
  const { store, stateDir, time } = await setup(t);
  const grant = await store.issueGrant({ name: "phone", owner: OWNER });
  const existing = await stateOf(stateDir);
  await chmod(stateDir, 0o500);
  t.after(() => chmod(stateDir, 0o700).catch(() => {}));

  await assert.rejects(() => store.pair({ secret: grant.secret, owner: OWNER }), {
    code: "device_state_unavailable",
    status: 503,
  });
  await assert.rejects(() => store.issueGrant({ name: "laptop", owner: OWNER }), { code: "device_state_unavailable" });
  assert.throws(() => store.list(), { code: "device_state_unavailable" });
  assert.throws(() => store.authorize({ credential: `${randomUUID()}.${"A".repeat(43)}`, owner: OWNER }), {
    code: "device_state_unavailable",
  });
  assert.equal(await stateOf(stateDir), existing);

  await chmod(stateDir, 0o700);
  const restarted = await createDeviceStore({ stateDir, now: time.now });
  assert.deepEqual(restarted.list(), []);
  const device = await restarted.pair({ secret: grant.secret, owner: OWNER });
  assert.equal(restarted.list().length, 1);
  assert.equal(restarted.authorize({ credential: `${device.deviceId}.${device.deviceSecret}`, owner: OWNER }).owner, OWNER);
});

// Expiry is configurable per bridge and clearable per device, the way a
// tailnet sets a default key lifetime and then disables it on one machine.

test("a device paired under a null lifetime never expires or prunes away", async (t) => {
  const { store, time } = await setup(t, { deviceLifetimeMs: null });
  const grant = await store.issueGrant({ name: "phone", owner: OWNER });
  const device = await store.pair({ secret: grant.secret, owner: OWNER });
  assert.equal(device.expiresAt, null);

  time.advance(DEFAULT_DEVICE_LIFETIME_MS * 10);
  assert.deepEqual(await store.prune(), { devices: 0, grants: 0, requests: 0 });
  assert.equal(store.authorize({ credential: `${device.deviceId}.${device.deviceSecret}`, owner: OWNER }).deviceId, device.deviceId);
  assert.equal(store.list()[0].active, true);

  // Never expiring is not never revocable.
  await store.revoke(device.deviceId);
  assert.throws(() => store.authorize({ credential: `${device.deviceId}.${device.deviceSecret}`, owner: OWNER }), {
    code: "device_revoked",
  });
});

test("a revoked never-expiring device is retained for 90 days, then pruned across reopen", async (t) => {
  const { store, stateDir, time } = await setup(t, { deviceLifetimeMs: null });
  const device = await approve(store);
  await store.revoke(device.deviceId);

  time.advance(REVOKED_DEVICE_RETENTION_MS - 1);
  const duringRetention = await createDeviceStore({ stateDir, now: time.now, deviceLifetimeMs: null });
  assert.throws(() => duringRetention.authorize({ credential: device.credential, owner: OWNER }), {
    code: "device_revoked",
  });
  assert.deepEqual(await duringRetention.prune(), { devices: 0, grants: 0, requests: 0 });

  time.advance(1);
  assert.deepEqual(await duringRetention.prune(), { devices: 1, grants: 0, requests: 0 });
  const afterRetention = await createDeviceStore({ stateDir, now: time.now, deviceLifetimeMs: null });
  assert.deepEqual(afterRetention.list(), []);
  assert.throws(() => afterRetention.authorize({ credential: device.credential, owner: OWNER }), {
    code: "device_required",
  });
});

test("a bridge lifetime shorter than the default is honoured", async (t) => {
  const day = 24 * 60 * 60 * 1000;
  const { store, time } = await setup(t, { deviceLifetimeMs: day });
  const grant = await store.issueGrant({ name: "phone", owner: OWNER });
  const device = await store.pair({ secret: grant.secret, owner: OWNER });
  assert.equal(device.expiresAt, START + day);

  time.advance(day + 1);
  assert.throws(() => store.authorize({ credential: `${device.deviceId}.${device.deviceSecret}`, owner: OWNER }), {
    code: "device_expired",
  });
});

test("setExpiry clears an expiry, sets a new one and refuses a revoked device", async (t) => {
  const { store, time } = await setup(t);
  const grant = await store.issueGrant({ name: "phone", owner: OWNER });
  const device = await store.pair({ secret: grant.secret, owner: OWNER });
  const credential = `${device.deviceId}.${device.deviceSecret}`;

  assert.equal((await store.setExpiry({ deviceId: device.deviceId, lifetimeMs: null })).expiresAt, null);
  time.advance(DEFAULT_DEVICE_LIFETIME_MS * 2);
  assert.equal(store.authorize({ credential, owner: OWNER }).deviceId, device.deviceId);

  // Measured from now, so a lapsed device comes back for the full term.
  const day = 24 * 60 * 60 * 1000;
  const view = await store.setExpiry({ deviceId: device.deviceId, lifetimeMs: day });
  assert.equal(view.expiresAt, time.now() + day);
  assert.equal(view.active, true);

  await assert.rejects(store.setExpiry({ deviceId: randomUUID(), lifetimeMs: null }), { code: "device_unknown" });
  await assert.rejects(store.setExpiry({ deviceId: device.deviceId, lifetimeMs: 0 }), { code: "device_expiry_invalid" });
  await store.revoke(device.deviceId);
  await assert.rejects(store.setExpiry({ deviceId: device.deviceId, lifetimeMs: null }), { code: "device_revoked" });
});

test("version 2 rejects a null expiry while version 3 accepts it", async (t) => {
  const id = randomUUID();
  const document = {
    version: 2,
    devices: [{
      id,
      name: "phone",
      owner: OWNER,
      secretHash: digestOf(CROWDED_DEVICE_SECRET),
      createdAt: START,
      expiresAt: null,
      revokedAt: null,
    }],
    grants: [],
  };
  const stateDir = await temporaryDir(t);
  await writeFile(path.join(stateDir, "devices.json"), JSON.stringify(document), { mode: 0o600 });
  await assert.rejects(() => createDeviceStore({ stateDir, now: clock().now }), { code: "device_state_invalid" });

  document.version = 3;
  await writeFile(path.join(stateDir, "devices.json"), JSON.stringify(document), { mode: 0o600 });
  const store = await createDeviceStore({ stateDir, now: clock().now });
  assert.equal(store.list()[0].expiresAt, null);
  assert.equal(store.list()[0].active, true);
});

test("a version 2 file is read and rewritten at the current version with its expiries intact", async (t) => {
  const stateDir = await temporaryDir(t);
  const time = clock();
  const id = randomUUID();
  await writeFile(
    path.join(stateDir, "devices.json"),
    JSON.stringify({
      version: 2,
      devices: [
        {
          id,
          name: "phone",
          owner: OWNER,
          secretHash: digestOf(CROWDED_DEVICE_SECRET),
          createdAt: START,
          expiresAt: START + DEFAULT_DEVICE_LIFETIME_MS,
          revokedAt: null,
        },
      ],
      grants: [],
    }),
    { mode: 0o600 },
  );
  const store = await createDeviceStore({ stateDir, now: time.now });
  assert.equal(store.list()[0].expiresAt, START + DEFAULT_DEVICE_LIFETIME_MS);

  await store.setExpiry({ deviceId: id, lifetimeMs: null });
  const saved = JSON.parse(await readFile(path.join(stateDir, "devices.json"), "utf8"));
  assert.equal(saved.version, STATE_VERSION);
  assert.equal(saved.devices[0].expiresAt, null);
});

async function requested(store, { name = "laptop", owner = OWNER } = {}) {
  return store.requestEnrollment({ name, owner });
}

test("an access request is pending, then approved, then redeemed once into a device", async (t) => {
  const { store } = await setup(t);
  const approver = await approve(store, { name: "phone" });
  const request = await requested(store);
  assert.match(request.id, /^[0-9a-f-]{36}$/);
  assert.match(request.secret, /^[A-Za-z0-9_-]{22}$/);
  assert.match(request.phrase, /^[a-z]+ [a-z]+ [a-z]+$/);
  assert.equal(request.expiresAt, START + ENROLLMENT_REQUEST_MS);

  const proof = { id: request.id, secret: request.secret, owner: OWNER };
  assert.deepEqual(store.enrollmentStatus(proof), {
    id: request.id, name: "laptop", phrase: request.phrase, status: "pending", expiresAt: request.expiresAt,
  });
  const [listed] = store.pendingRequests({ owner: OWNER });
  assert.deepEqual(Object.keys(listed).sort(), ["ageMs", "createdAt", "expiresAt", "id", "name", "phrase"]);
  assert.equal(listed.phrase, request.phrase);

  const decided = await store.decideEnrollment({ id: request.id, decision: "approve", owner: OWNER, approver: approver.deviceId });
  assert.equal(decided.status, "approved");
  assert.deepEqual(store.pendingRequests({ owner: OWNER }), []);

  const device = await store.redeemEnrollment(proof);
  assert.equal(device.name, "laptop");
  assert.equal(store.authorize({ credential: `${device.deviceId}.${device.deviceSecret}`, owner: OWNER }).name, "laptop");
  assert.equal(store.enrollmentStatus(proof).status, "consumed");
  await assert.rejects(() => store.redeemEnrollment(proof), { code: "enrollment_consumed", status: 409 });
  assert.equal(store.list().length, 2);
});

test("an access request expires by its expiresAt, without a stored expired status", async (t) => {
  const { store, stateDir, time } = await setup(t);
  const approver = await approve(store);
  const request = await requested(store);
  const proof = { id: request.id, secret: request.secret, owner: OWNER };
  time.advance(ENROLLMENT_REQUEST_MS - 1);
  assert.equal(store.enrollmentStatus(proof).status, "pending");
  time.advance(1);
  assert.equal(store.enrollmentStatus(proof).status, "expired");
  assert.deepEqual(store.pendingRequests({ owner: OWNER }), []);
  await assert.rejects(
    () => store.decideEnrollment({ id: request.id, decision: "approve", owner: OWNER, approver: approver.deviceId }),
    { code: "enrollment_expired", status: 410 },
  );
  await assert.rejects(() => store.redeemEnrollment(proof), { code: "enrollment_expired", status: 410 });
  assert.equal(JSON.parse(await stateOf(stateDir)).requests[0].status, "pending");

  const approvedThenLate = await requested(store);
  await store.decideEnrollment({ id: approvedThenLate.id, decision: "approve", owner: OWNER, approver: LOCAL_ADMIN });
  time.advance(ENROLLMENT_REQUEST_MS);
  await assert.rejects(() => store.redeemEnrollment({ ...approvedThenLate, owner: OWNER }), { code: "enrollment_expired" });
});

test("pairing grants and open access requests share one budget of eight", async (t) => {
  const { store } = await setup(t);
  for (let issued = 0; issued < MAX_PENDING_GRANTS - 3; issued++)
    await store.issueGrant({ name: `grant ${issued}`, owner: OWNER });
  const requests = [];
  for (let made = 0; made < 3; made++) requests.push(await requested(store, { name: `request ${made}` }));
  await assert.rejects(() => requested(store), { code: "pairing_grant_limit", status: 429 });
  await assert.rejects(() => store.issueGrant({ name: "one more", owner: OWNER }), { code: "pairing_grant_limit" });

  await store.decideEnrollment({ id: requests[0].id, decision: "reject", owner: OWNER, approver: LOCAL_ADMIN });
  const replacement = await requested(store, { name: "replacement" });
  assert.ok(replacement.id);
  await assert.rejects(() => store.issueGrant({ name: "one more", owner: OWNER }), { code: "pairing_grant_limit" });
});

test("only the digest of a request secret reaches the disk", async (t) => {
  const { store, stateDir } = await setup(t);
  const request = await requested(store);
  const text = await stateOf(stateDir);
  assert.equal(text.includes(request.secret), false);
  assert.equal(text.includes(digestOf(request.secret)), true);
  assert.equal(text.includes(request.phrase), false);
});

test("concurrent redemptions of one approved request create exactly one device", async (t) => {
  const { store } = await setup(t);
  const request = await requested(store);
  await store.decideEnrollment({ id: request.id, decision: "approve", owner: OWNER, approver: LOCAL_ADMIN });
  const outcomes = await Promise.allSettled(
    Array.from({ length: 6 }, () => store.redeemEnrollment({ id: request.id, secret: request.secret, owner: OWNER })),
  );
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.ok(
    outcomes.filter((outcome) => outcome.status === "rejected").every((outcome) => outcome.reason.code === "enrollment_consumed"),
  );
  assert.equal(store.list().length, 1);
});

test("a request cannot be redeemed before approval, or after rejection", async (t) => {
  const { store } = await setup(t);
  const waiting = await requested(store);
  const proof = { id: waiting.id, secret: waiting.secret, owner: OWNER };
  await assert.rejects(() => store.redeemEnrollment(proof), { code: "enrollment_not_approved", status: 409 });
  await assert.rejects(() => store.redeemEnrollment({ ...proof, secret: "B".repeat(22) }), {
    code: "enrollment_unknown",
    status: 404,
  });
  assert.equal(store.list().length, 0);

  const rejected = await requested(store, { name: "stranger" });
  await store.decideEnrollment({ id: rejected.id, decision: "reject", owner: OWNER, approver: LOCAL_ADMIN });
  await assert.rejects(() => store.redeemEnrollment({ id: rejected.id, secret: rejected.secret, owner: OWNER }), {
    code: "enrollment_rejected",
    status: 403,
  });
  await assert.rejects(
    () => store.decideEnrollment({ id: rejected.id, decision: "approve", owner: OWNER, approver: LOCAL_ADMIN }),
    { code: "enrollment_decided", status: 409 },
  );
  assert.equal(store.list().length, 0);
});

test("a revoked approver cannot decide, and its approval no longer redeems", async (t) => {
  const { store } = await setup(t);
  const approver = await approve(store, { name: "old phone" });
  const request = await requested(store);
  const proof = { id: request.id, secret: request.secret, owner: OWNER };
  await store.decideEnrollment({ id: request.id, decision: "approve", owner: OWNER, approver: approver.deviceId });
  await store.revoke(approver.deviceId);

  assert.equal(store.enrollmentStatus(proof).status, "pending");
  assert.deepEqual(store.pendingRequests({ owner: OWNER }).map((row) => row.id), [request.id]);
  await assert.rejects(() => store.redeemEnrollment(proof), { code: "enrollment_not_approved" });
  const other = await requested(store, { name: "other" });
  await assert.rejects(
    () => store.decideEnrollment({ id: other.id, decision: "approve", owner: OWNER, approver: approver.deviceId }),
    { code: "device_required", status: 403 },
  );

  const current = await approve(store, { name: "new phone" });
  await store.decideEnrollment({ id: request.id, decision: "approve", owner: OWNER, approver: current.deviceId });
  const device = await store.redeemEnrollment(proof);
  assert.equal(store.authorize({ credential: `${device.deviceId}.${device.deviceSecret}`, owner: OWNER }).name, "laptop");
});

test("another owner can neither see, decide nor redeem a request", async (t) => {
  const { store } = await setup(t);
  const theirs = await approve(store, { owner: OTHER });
  const request = await requested(store);
  assert.deepEqual(store.pendingRequests({ owner: OTHER }), []);
  assert.throws(() => store.enrollmentStatus({ id: request.id, secret: request.secret, owner: OTHER }), {
    code: "enrollment_unknown",
  });
  await assert.rejects(
    () => store.decideEnrollment({ id: request.id, decision: "approve", owner: OTHER, approver: theirs.deviceId }),
    { code: "enrollment_unknown" },
  );
  await assert.rejects(
    () => store.decideEnrollment({ id: request.id, decision: "approve", owner: OWNER, approver: theirs.deviceId }),
    { code: "device_required" },
  );
  await store.decideEnrollment({ id: request.id, decision: "approve", owner: OWNER, approver: LOCAL_ADMIN });
  await assert.rejects(() => store.redeemEnrollment({ id: request.id, secret: request.secret, owner: OTHER }), {
    code: "enrollment_unknown",
  });
  assert.equal(store.list().length, 1);
});

test("status reads are bounded per request and per owner, and creation shares the pairing budget", async (t) => {
  const { store, time } = await setup(t);
  const first = await requested(store);
  const proof = { id: first.id, secret: first.secret, owner: OWNER };
  for (let read = 0; read < STATUS_LIMIT_PER_REQUEST; read++) store.enrollmentStatus(proof);
  assert.throws(() => store.enrollmentStatus(proof), { code: "enrollment_rate_limited", status: 429 });
  time.advance(STATUS_WINDOW_MS);
  assert.equal(store.enrollmentStatus(proof).status, "pending");

  time.advance(STATUS_WINDOW_MS);
  const others = [];
  for (let made = 0; made < 3; made++) others.push(await requested(store, { name: `other ${made}` }));
  let reads = 0;
  for (const request of [first, ...others])
    for (let read = 0; read < STATUS_LIMIT_PER_REQUEST && reads < STATUS_LIMIT_PER_OWNER; read++, reads++)
      store.enrollmentStatus({ id: request.id, secret: request.secret, owner: OWNER });
  assert.throws(() => store.enrollmentStatus({ id: others[2].id, secret: others[2].secret, owner: OWNER }), {
    code: "enrollment_rate_limited",
  });

  time.advance(PAIRING_WINDOW_MS);
  for (let made = 0; made < 4; made++) await requested(store, { name: `burst ${made}` });
  for (let attempt = 0; attempt < PAIRING_ATTEMPT_LIMIT - 4; attempt++)
    await assert.rejects(() => store.pair({ secret: "A".repeat(22), owner: OWNER }), { code: "pairing_grant_invalid" });
  await assert.rejects(() => requested(store), { code: "pairing_rate_limited", status: 429 });
});

test("a version 3 file migrates on the next write, and request rows are validated", async (t) => {
  const stateDir = await temporaryDir(t);
  const id = randomUUID();
  const device = {
    id, name: "phone", owner: OWNER, secretHash: digestOf(CROWDED_DEVICE_SECRET), createdAt: START, expiresAt: null, revokedAt: null,
  };
  await writeFile(path.join(stateDir, "devices.json"), JSON.stringify({ version: 3, devices: [device], grants: [] }), { mode: 0o600 });
  const store = await createDeviceStore({ stateDir, now: clock().now });
  assert.equal(store.authorize({ credential: `${id}.${CROWDED_DEVICE_SECRET}`, owner: OWNER }).deviceId, id);
  const request = await requested(store);
  const saved = JSON.parse(await stateOf(stateDir));
  assert.equal(saved.version, STATE_VERSION);
  assert.deepEqual(saved.devices, [device]);
  assert.equal(saved.requests[0].id, request.id);

  const row = {
    id: randomUUID(), owner: OWNER, name: "laptop", secretHash: digestOf("r"), createdAt: START, expiresAt: START + 1,
    status: "pending", approvedBy: null,
  };
  for (const broken of [
    { version: 3, devices: [], grants: [], requests: [] },
    { version: 4, devices: [], grants: [] },
    { version: 4, devices: [], grants: [], requests: [{ ...row, secret: "plaintext" }] },
    { version: 4, devices: [], grants: [], requests: [{ ...row, status: "expired" }] },
    { version: 4, devices: [], grants: [], requests: [{ ...row, status: "approved" }] },
    { version: 4, devices: [], grants: [], requests: [{ ...row, approvedBy: LOCAL_ADMIN }] },
    { version: 4, devices: [], grants: [], requests: [row, { ...row, secretHash: digestOf("s") }] },
  ]) {
    const dir = await temporaryDir(t, "devices-broken");
    await writeFile(path.join(dir, "devices.json"), JSON.stringify(broken), { mode: 0o600 });
    await assert.rejects(() => createDeviceStore({ stateDir: dir, now: clock().now }), { code: "device_state_invalid" }, JSON.stringify(broken));
  }
});

test("a request that would outgrow the state ceiling is refused without changing the file", async (t) => {
  const stateDir = await crowdedDir(t, crowdedDocument(40));
  const store = await createDeviceStore({ stateDir, now: clock().now });
  const saved = await stateOf(stateDir);
  await assert.rejects(() => requested(store), { code: "device_state_full", status: 429 });
  assert.equal(await stateOf(stateDir), saved);
  assert.deepEqual(store.pendingRequests({ owner: OWNER }), []);
});

// A holder of an issued secret is told why it failed. Anything else stays the
// generic "invalid", so the reasons are not a way to probe for secrets, and no
// reason carries the secret or the owner.
const refusal = (store, secret, owner = OWNER) => store.pair({ secret, owner }).then(() => null, (error) => error);

test("each way a pairing secret can fail has its own reason, and no message names the secret or the owner", async (t) => {
  const { store, time } = await setup(t);
  const expiredUnpruned = await store.issueGrant({ name: "a", owner: OWNER });
  const wrongOwner = await store.issueGrant({ name: "b", owner: OWNER });
  const used = await store.issueGrant({ name: "c", owner: OWNER });
  await store.pair({ secret: used.secret, owner: OWNER });

  const reasons = new Map([
    ["used", await refusal(store, used.secret)],
    ["wrongOwner", await refusal(store, wrongOwner.secret, OTHER)],
    ["invalid", await refusal(store, "A".repeat(22))],
  ]);
  time.advance(PAIRING_GRANT_MS);
  reasons.set("expired", await refusal(store, expiredUnpruned.secret));
  for (const [reason, error] of reasons) {
    assert.deepEqual([error.code, error.status], [PAIRING_REFUSALS[reason][0], 403], reason);
    for (const secret of [used.secret, wrongOwner.secret, expiredUnpruned.secret]) assert.equal(error.message.includes(secret), false, reason);
    for (const owner of [OWNER, OTHER, "example.com"]) assert.equal(error.message.includes(owner), false, reason);
  }
  assert.equal(new Set([...reasons.values()].map((error) => error.code)).size, 4, "four distinct codes");
});

test("a wrong-owner attempt does not spend the grant, and a malformed or unknown secret never gets a reason", async (t) => {
  const { store } = await setup(t);
  const grant = await store.issueGrant({ name: "phone", owner: OWNER });
  assert.equal((await refusal(store, grant.secret, OTHER)).code, "pairing_grant_wrong_owner");
  assert.equal((await refusal(store, "short")).code, "pairing_grant_invalid");
  assert.equal((await refusal(store, "B".repeat(22))).code, "pairing_grant_invalid");
  assert.ok((await store.pair({ secret: grant.secret, owner: OWNER })).deviceId);
});

test("an expired secret still reads as expired after the store pruned it, until the memory of it lapses", async (t) => {
  const { store, stateDir, time } = await setup(t);
  const grant = await store.issueGrant({ name: "phone", owner: OWNER });
  time.advance(PAIRING_GRANT_MS);
  await store.issueGrant({ name: "later", owner: OWNER });
  assert.equal(JSON.parse(await stateOf(stateDir)).grants.some((entry) => entry.name === "phone"), false, "the grant was pruned from state");
  assert.equal((await refusal(store, grant.secret)).code, "pairing_grant_expired");
  time.advance(RETIRED_GRANT_MS + 1);
  assert.equal((await refusal(store, grant.secret)).code, "pairing_grant_invalid");
});

test("a restart forgets why a secret failed, and it reads as invalid", async (t) => {
  const { store, stateDir, time } = await setup(t);
  const grant = await store.issueGrant({ name: "phone", owner: OWNER });
  await store.pair({ secret: grant.secret, owner: OWNER });
  assert.equal((await refusal(store, grant.secret)).code, "pairing_grant_used");
  const restarted = await createDeviceStore({ stateDir, now: time.now });
  assert.equal((await refusal(restarted, grant.secret)).code, "pairing_grant_invalid");
  assert.deepEqual(restarted.pairingRefusals(), []);
});

test("refusals of an issued secret are recorded as code and time only, oldest dropped, and unknown secrets are not", async (t) => {
  const { store, time } = await setup(t);
  const grant = await store.issueGrant({ name: "phone", owner: OWNER });
  await refusal(store, "A".repeat(22));
  assert.deepEqual(store.pairingRefusals(), []);
  await refusal(store, grant.secret, OTHER);
  assert.deepEqual(store.pairingRefusals(), [{ at: time.now(), code: "pairing_grant_wrong_owner" }]);
  for (let attempt = 0; attempt < 40; attempt++) {
    time.advance(PAIRING_WINDOW_MS);
    await refusal(store, grant.secret, OTHER);
  }
  const kept = store.pairingRefusals();
  assert.equal(kept.length, 20);
  assert.equal(kept.at(-1).at, time.now());
  assert.deepEqual(Object.keys(kept[0]), ["at", "code"]);
});

test("the attempt budget running out is a recorded refusal", async (t) => {
  const { store, time } = await setup(t);
  const grant = await store.issueGrant({ name: "phone", owner: OWNER });
  for (let attempt = 0; attempt < PAIRING_ATTEMPT_LIMIT; attempt++) await refusal(store, "A".repeat(22));
  assert.equal((await refusal(store, grant.secret)).code, "pairing_rate_limited");
  assert.deepEqual(store.pairingRefusals(), [{ at: time.now(), code: "pairing_rate_limited" }]);
});
