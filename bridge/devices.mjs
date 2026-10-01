import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { phraseOf } from "./enrollment-phrase.mjs";

// Persistent device approval. The bridge process is the only writer of this
// state: a pairing grant is consumed and its device created in one serialized
// atomic replacement, so a lost response can never replay the grant.

export const STATE_VERSION = 4;
// Versions 2 and 3 are read and migrated in place on the next write. Version 2
// differs in that every device carried a hard expiry; a null expiry is what
// version 3 adds, and version 4 adds enrollment requests.
export const READABLE_VERSIONS = new Set([2, 3, 4]);
export const PAIRING_GRANT_MS = 5 * 60 * 1000;
export const ENROLLMENT_REQUEST_MS = 5 * 60 * 1000;
// Status reads are cheap but unauthenticated beyond identity, so each request
// and each owner gets its own per-minute budget. A client polls every 2 s.
export const STATUS_WINDOW_MS = 60 * 1000;
export const STATUS_LIMIT_PER_REQUEST = 40;
export const STATUS_LIMIT_PER_OWNER = 120;
export const LOCAL_ADMIN = "local-admin";
export const DEFAULT_DEVICE_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;
export const REVOKED_DEVICE_RETENTION_MS = DEFAULT_DEVICE_LIFETIME_MS;
export const PAIRING_WINDOW_MS = 60 * 1000;
export const PAIRING_ATTEMPT_LIMIT = 10;
export const MAX_ACTIVE_DEVICES = 100;
/** Outstanding pairing grants and open enrollment requests share this budget. */
export const MAX_PENDING_GRANTS = 8;
export const MAX_STATE_BYTES = 1024 * 1024;
// A stored document must also leave room to stamp a revocation time on every
// device it still holds, so revoking can never outgrow what startup accepts.
export const REVOCATION_BYTES = 12;

const DAY_MS = 24 * 60 * 60 * 1000;
// Bounded so a term can never overflow a safe integer timestamp.
const MAX_EXPIRY_DAYS = 3650;
export const EXPIRY_TERM = `Give a whole number of days from 1 to ${MAX_EXPIRY_DAYS}, or "never".`;

/**
 * Terms cross the admin socket as text, which every field there must be, so
 * the milliseconds are derived on both sides rather than sent. Undefined means
 * the term was not one this bridge accepts.
 */
export function lifetimeOf(term) {
  if (term === "never") return null;
  if (typeof term !== "string" || !/^[0-9]+$/.test(term)) return undefined;
  const days = Number(term);
  return days >= 1 && days <= MAX_EXPIRY_DAYS ? days * DAY_MS : undefined;
}

export const STATE_FILE = "devices.json";
const MAX_NAME = 64;
const MAX_OWNER = 256;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_LENGTH = 36;
const HASH = /^[0-9a-f]{64}$/;
const HASH_LENGTH = 64;
const PAIRING_SECRET = /^[A-Za-z0-9_-]{22}$/;
const CREDENTIAL = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;
const CREDENTIAL_LENGTH = 80;
const DEVICE_KEYS = ["id", "name", "owner", "secretHash", "createdAt", "expiresAt", "revokedAt"];
const GRANT_KEYS = ["secretHash", "name", "owner", "expiresAt"];
const REQUEST_KEYS = ["id", "owner", "name", "secretHash", "createdAt", "expiresAt", "status", "approvedBy"];
const REQUEST_STATUSES = new Set(["pending", "approved", "rejected", "consumed"]);
const LEGACY_STATE_KEYS = ["version", "devices", "grants"];
const STATE_KEYS = ["version", "devices", "grants", "requests"];

/** Structured denial, shaped for an `{ error: { code, message } }` envelope. */
export class DeviceError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "DeviceError";
    this.status = status;
    this.code = code;
  }
}

const denied = () => new DeviceError(403, "device_required", "This device needs approval to connect.");

/**
 * Why a pairing secret was refused. Only a caller holding a secret this bridge
 * issued can reach any reason but `invalid`, so a guess learns nothing about
 * what exists. No reason names the owner, the device or the secret.
 */
export const PAIRING_REFUSALS = {
  invalid: ["pairing_grant_invalid", "That pairing secret is not valid. Create a new one on the host."],
  expired: ["pairing_grant_expired", "That pairing secret expired. Create a new one on the host."],
  used: ["pairing_grant_used", "That pairing secret was already used. Create a new one on the host."],
  wrongOwner: [
    "pairing_grant_wrong_owner",
    "That pairing secret was issued for a different Tailscale account than this browser is signed in as. Open the link in a browser signed in as the host's owner.",
  ],
};
const grantRefused = (reason) => new DeviceError(403, ...PAIRING_REFUSALS[reason]);
// Spent and expired secrets are remembered, by hash and in memory only, so a
// holder can be told which it was. A restart forgets them and they read as invalid.
export const RETIRED_GRANT_MS = 60 * 60 * 1000;
const MAX_RETIRED_GRANTS = 64;
const MAX_REFUSALS = 20;
const unsafe = (message) => new DeviceError(500, "device_state_unsafe", message);
const invalid = (message) => new DeviceError(500, "device_state_invalid", message);
const full = () =>
  new DeviceError(
    429,
    "device_state_full",
    "This bridge is holding as much device history as it can store. Prune expired devices on the host first.",
  );

const digest = (secret) => createHash("sha256").update(secret, "utf8").digest();
const hashOf = (secret) => digest(secret).toString("hex");

function matchesSecret(secret, secretHash) {
  const expected = Buffer.from(secretHash, "hex");
  const actual = digest(secret);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

const printable = (value, max) =>
  typeof value === "string" && value.length > 0 && value.length <= max && !/\p{Cc}/u.test(value);
const isName = (value) => printable(value, MAX_NAME);
const isOwner = (value) => printable(value, MAX_OWNER);
const isTime = (value) => Number.isSafeInteger(value) && value > 0;
/** A null expiry never lapses while active; revoked rows remain useful tombstones for 90 days. */
const unexpired = (device, time) => device.expiresAt === null || device.expiresAt > time;
const retained = (device, time) =>
  device.expiresAt === null
    ? device.revokedAt === null || device.revokedAt + REVOKED_DEVICE_RETENTION_MS > time
    : device.expiresAt > time;
const isId = (value) => typeof value === "string" && value.length === UUID_LENGTH && UUID.test(value);
const isHash = (value) => typeof value === "string" && value.length === HASH_LENGTH && HASH.test(value);
const hasKeys = (value, keys) => {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
};

function parseDevice(value, file, version) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !hasKeys(value, DEVICE_KEYS))
    throw invalid(`${file} holds a device record with unexpected fields`);
  if (!isId(value.id) || !isName(value.name) || !isOwner(value.owner) || !isHash(value.secretHash))
    throw invalid(`${file} holds a device record with an invalid identity`);
  if (!isTime(value.createdAt)) throw invalid(`${file} holds a device record with an invalid lifetime`);
  if ((version === 2 && value.expiresAt === null) ||
      (value.expiresAt !== null && (!isTime(value.expiresAt) || value.expiresAt <= value.createdAt)))
    throw invalid(`${file} holds a device record with an invalid lifetime`);
  if (value.revokedAt !== null && !isTime(value.revokedAt))
    throw invalid(`${file} holds a device record with an invalid revocation time`);
  return Object.freeze({
    id: value.id,
    name: value.name,
    owner: value.owner,
    secretHash: value.secretHash,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    revokedAt: value.revokedAt,
  });
}

function parseGrant(value, file) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !hasKeys(value, GRANT_KEYS))
    throw invalid(`${file} holds a pairing grant with unexpected fields`);
  if (!isHash(value.secretHash) || !isName(value.name) || !isOwner(value.owner) || !isTime(value.expiresAt))
    throw invalid(`${file} holds an invalid pairing grant`);
  return Object.freeze({
    secretHash: value.secretHash,
    name: value.name,
    owner: value.owner,
    expiresAt: value.expiresAt,
  });
}

function parseRequest(value, file) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !hasKeys(value, REQUEST_KEYS))
    throw invalid(`${file} holds an enrollment request with unexpected fields`);
  if (!isId(value.id) || !isName(value.name) || !isOwner(value.owner) || !isHash(value.secretHash))
    throw invalid(`${file} holds an enrollment request with an invalid identity`);
  if (!isTime(value.createdAt) || !isTime(value.expiresAt) || value.expiresAt <= value.createdAt)
    throw invalid(`${file} holds an enrollment request with an invalid lifetime`);
  if (!REQUEST_STATUSES.has(value.status)) throw invalid(`${file} holds an enrollment request with an invalid status`);
  const decided = value.status === "approved" || value.status === "consumed";
  if (decided ? value.approvedBy !== LOCAL_ADMIN && !isId(value.approvedBy) : value.approvedBy !== null)
    throw invalid(`${file} holds an enrollment request with an invalid approver`);
  return Object.freeze({
    id: value.id,
    owner: value.owner,
    name: value.name,
    secretHash: value.secretHash,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    status: value.status,
    approvedBy: value.approvedBy,
  });
}

function parseState(text, file) {
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    throw invalid(`${file} is not valid JSON`);
  }
  if (Array.isArray(document))
    throw new DeviceError(
      500,
      "device_state_legacy",
      `${file} holds a protocol 1 device list; back it up and migrate it before starting protocol 2`,
    );
  if (!document || typeof document !== "object") throw invalid(`${file} is not a device state document`);
  if (!READABLE_VERSIONS.has(document.version))
    throw invalid(`${file} has version ${JSON.stringify(document.version)}, expected ${[...READABLE_VERSIONS].join(" or ")}`);
  if (!hasKeys(document, document.version < 4 ? LEGACY_STATE_KEYS : STATE_KEYS))
    throw invalid(`${file} is not a device state document`);
  const listed = document.version < 4 ? [] : document.requests;
  if (!Array.isArray(document.devices) || !Array.isArray(document.grants) || !Array.isArray(listed))
    throw invalid(`${file} is not a device state document`);
  const devices = document.devices.map((record) => parseDevice(record, file, document.version));
  const grants = document.grants.map((record) => parseGrant(record, file));
  const requests = listed.map((record) => parseRequest(record, file));
  const ids = new Set([...devices, ...requests].map((record) => record.id));
  const hashes = new Set([...devices, ...grants, ...requests].map((record) => record.secretHash));
  if (ids.size !== devices.length + requests.length || hashes.size !== devices.length + grants.length + requests.length)
    throw invalid(`${file} holds duplicate device identities`);
  return { version: STATE_VERSION, devices, grants, requests };
}

const capacityBytes = (document) =>
  Buffer.byteLength(JSON.stringify(document)) +
  REVOCATION_BYTES * document.devices.filter((device) => device.revokedAt === null).length;

function requireOwnership(info, target) {
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid) throw unsafe(`${target} belongs to another user`);
}

const openDirectory = (directory) =>
  open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);

async function ensureDirectory(directory) {
  let handle;
  try {
    handle = await openDirectory(directory);
  } catch (error) {
    if (error.code === "ELOOP") throw unsafe(`${directory} is a symbolic link`);
    if (error.code === "ENOTDIR") throw unsafe(`${directory} is not a directory`);
    if (error.code !== "ENOENT") throw error;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    handle = await openDirectory(directory);
  }
  try {
    const info = await handle.stat();
    requireOwnership(info, directory);
    if ((info.mode & 0o777) !== 0o700) await handle.chmod(0o700);
  } finally {
    await handle.close();
  }
}

async function loadState(file) {
  let handle;
  try {
    // O_NONBLOCK keeps a FIFO planted at this path from stalling startup.
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error.code === "ENOENT") return { version: STATE_VERSION, devices: [], grants: [], requests: [] };
    if (error.code === "ELOOP") throw unsafe(`${file} is a symbolic link`);
    if (error.code === "ENXIO") throw unsafe(`${file} is not a regular file`);
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw unsafe(`${file} is not a regular file`);
    requireOwnership(info, file);
    if (info.size > MAX_STATE_BYTES) throw invalid(`${file} is larger than this bridge writes`);
    if ((info.mode & 0o777) !== 0o600) await handle.chmod(0o600);
    const document = parseState(await handle.readFile("utf8"), file);
    if (capacityBytes(document) > MAX_STATE_BYTES)
      throw new DeviceError(
        500,
        "device_state_full",
        `${file} leaves no room to revoke the devices it holds; remove expired or revoked records before starting the bridge`,
      );
    return document;
  } finally {
    await handle.close();
  }
}

const viewOf = (device, time) => ({
  id: device.id,
  name: device.name,
  owner: device.owner,
  createdAt: device.createdAt,
  expiresAt: device.expiresAt,
  revokedAt: device.revokedAt,
  active: device.revokedAt === null && unexpired(device, time),
});

const accessOf = (device) => ({
  deviceId: device.id,
  owner: device.owner,
  name: device.name,
  expiresAt: device.expiresAt,
});

export async function createDeviceStore({
  stateDir,
  now = Date.now,
  deviceLifetimeMs = DEFAULT_DEVICE_LIFETIME_MS,
  requestLifetimeMs = ENROLLMENT_REQUEST_MS,
} = {}) {
  if (deviceLifetimeMs !== null && !(Number.isSafeInteger(deviceLifetimeMs) && deviceLifetimeMs > 0))
    throw new TypeError("createDeviceStore needs a positive device lifetime, or null for no expiry");
  if (!(Number.isSafeInteger(requestLifetimeMs) && requestLifetimeMs > 0))
    throw new TypeError("createDeviceStore needs a positive enrollment request lifetime");
  if (typeof stateDir !== "string" || !stateDir) throw new TypeError("createDeviceStore needs a stateDir path");
  const directory = path.resolve(stateDir);
  const file = path.join(directory, STATE_FILE);
  await ensureDirectory(directory);

  let state = await loadState(file);
  let lane = Promise.resolve();
  let unavailable = null;
  let attempts = 0;
  let windowEnds = 0;
  const retiredGrants = new Map();
  const refusals = [];
  const statusReads = new Map();
  let statusWindowEnds = 0;

  function available() {
    if (unavailable) throw unavailable;
  }

  function serialize(action) {
    const operation = lane.catch(() => {}).then(action);
    lane = operation.catch(() => {});
    return operation;
  }

  /** Pairing redemptions and enrollment creation and redemption share one per-minute budget. */
  function countAttempt(time) {
    if (time >= windowEnds) {
      attempts = 0;
      windowEnds = time + PAIRING_WINDOW_MS;
    }
    if (attempts >= PAIRING_ATTEMPT_LIMIT) {
      noteRefusal(time, "pairing_rate_limited");
      throw new DeviceError(429, "pairing_rate_limited", "Too many pairing attempts. Try again in a minute.");
    }
    attempts++;
  }

  /** Recent refusals for the host operator: a time and a code, never a secret or an owner. */
  function noteRefusal(time, code) {
    refusals.push({ at: time, code });
    if (refusals.length > MAX_REFUSALS) refusals.shift();
  }

  function retireGrant(secretHash, reason, time) {
    for (const [hash, entry] of retiredGrants) if (entry.until <= time) retiredGrants.delete(hash);
    retiredGrants.delete(secretHash);
    if (retiredGrants.size >= MAX_RETIRED_GRANTS) retiredGrants.delete(retiredGrants.keys().next().value);
    retiredGrants.set(secretHash, { reason, until: time + RETIRED_GRANT_MS });
  }

  function refuseGrant(time, reason) {
    const error = grantRefused(reason);
    if (reason !== "invalid") noteRefusal(time, error.code);
    return error;
  }

  function countStatusRead(time, id, owner) {
    if (time >= statusWindowEnds) {
      statusReads.clear();
      statusWindowEnds = time + STATUS_WINDOW_MS;
    }
    const perRequest = `request:${id}`;
    const perOwner = `owner:${owner}`;
    if ((statusReads.get(perRequest) ?? 0) >= STATUS_LIMIT_PER_REQUEST || (statusReads.get(perOwner) ?? 0) >= STATUS_LIMIT_PER_OWNER)
      throw new DeviceError(429, "enrollment_rate_limited", "This request was checked too often. Wait a minute and try again.");
    statusReads.set(perRequest, (statusReads.get(perRequest) ?? 0) + 1);
    statusReads.set(perOwner, (statusReads.get(perOwner) ?? 0) + 1);
  }

  /** The grants and requests still inside their lifetime. */
  function live(time) {
    return {
      grants: state.grants.filter((grant) => grant.expiresAt > time),
      requests: state.requests.filter((request) => request.expiresAt > time),
    };
  }

  function requirePendingRoom(time) {
    const { grants, requests } = live(time);
    const open = requests.filter((request) => ["pending", "approved"].includes(statusOf(request, time)));
    if (grants.length + open.length >= MAX_PENDING_GRANTS)
      throw new DeviceError(
        429,
        "pairing_grant_limit",
        `Only ${MAX_PENDING_GRANTS} pairing secrets and access requests can wait at once. Use or expire one first.`,
      );
  }

  const approverActive = (approvedBy, owner, time) =>
    approvedBy === LOCAL_ADMIN ||
    state.devices.some(
      (device) => device.id === approvedBy && device.owner === owner && device.revokedAt === null && unexpired(device, time),
    );

  /**
   * Expired is computed, never stored. An approval whose approving device has
   * since been revoked or lapsed reads as pending again, so it cannot redeem.
   */
  function statusOf(request, time) {
    if (request.status === "consumed" || request.status === "rejected") return request.status;
    if (request.expiresAt <= time) return "expired";
    if (request.status === "approved" && !approverActive(request.approvedBy, request.owner, time)) return "pending";
    return request.status;
  }

  const publicRequest = (request, time) => ({
    id: request.id,
    name: request.name,
    phrase: phraseOf(request.id),
    status: statusOf(request, time),
    expiresAt: request.expiresAt,
  });

  const unknownRequest = () =>
    new DeviceError(404, "enrollment_unknown", "That access request is not known here. Start a new request.");

  /** Finds a request by id, secret and owner. Every mismatch is the same unknown. */
  function provenRequest({ id, secret, owner }) {
    if (!isId(id) || typeof secret !== "string" || !PAIRING_SECRET.test(secret) || !isOwner(owner)) throw unknownRequest();
    const request = state.requests.find((candidate) => candidate.id === id);
    if (!request || !matchesSecret(secret, request.secretHash) || request.owner !== owner) throw unknownRequest();
    return request;
  }

  /** A new device row for `owner`, refused when the active quota is full. */
  function mintDevice(time, devices, name, owner) {
    if (devices.filter((candidate) => candidate.revokedAt === null).length >= MAX_ACTIVE_DEVICES)
      throw new DeviceError(
        429,
        "device_limit",
        `This bridge already has ${MAX_ACTIVE_DEVICES} approved devices. Revoke one first.`,
      );
    const deviceSecret = randomBytes(32).toString("base64url");
    const device = Object.freeze({
      id: randomUUID(),
      name,
      owner,
      secretHash: hashOf(deviceSecret),
      createdAt: time,
      expiresAt: deviceLifetimeMs === null ? null : time + deviceLifetimeMs,
      revokedAt: null,
    });
    return { device, deviceSecret };
  }

  /** Replaces the fields given and keeps the rest of the current state. */
  async function commit(changes) {
    const next = { ...state, ...changes, version: STATE_VERSION };
    if (capacityBytes(next) > MAX_STATE_BYTES) throw full();
    const temporary = path.join(directory, `${STATE_FILE}.${randomUUID()}.tmp`);
    try {
      const handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.chmod(0o600);
        await handle.writeFile(JSON.stringify(next));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, file);
      const parent = await openDirectory(directory);
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    } catch (error) {
      await unlink(temporary).catch(() => {});
      unavailable = new DeviceError(
        503,
        "device_state_unavailable",
        `Device approval is unavailable: ${file} could not be saved. Fix the state directory and restart the bridge.`,
      );
      unavailable.cause = error;
      throw unavailable;
    }
    const time = now();
    for (const grant of state.grants)
      if (grant.expiresAt <= time && !next.grants.includes(grant)) retireGrant(grant.secretHash, "expired", time);
    state = next;
  }

  return {
    /** Local approval step: a single-use secret the operator carries to the browser. */
    issueGrant({ name, owner }) {
      return serialize(async () => {
        available();
        const time = now();
        if (!isName(name)) throw new DeviceError(400, "pairing_request_invalid", "Name the device in 1 to 64 characters.");
        if (!isOwner(owner))
          throw new DeviceError(400, "pairing_request_invalid", "A pairing secret needs the authenticated owner.");
        requirePendingRoom(time);
        const { grants, requests } = live(time);
        const secret = randomBytes(16).toString("base64url");
        const expiresAt = time + PAIRING_GRANT_MS;
        const grant = Object.freeze({ secretHash: hashOf(secret), name, owner, expiresAt });
        const devices = state.devices.filter((device) => retained(device, time));
        await commit({ devices, grants: [...grants, grant], requests });
        return { secret, name, owner, expiresAt };
      });
    },

    /** Consumes the grant and creates the device in one replacement. The secret is returned once. */
    pair({ secret, name, owner }) {
      return serialize(async () => {
        available();
        const time = now();
        countAttempt(time);
        if (!isOwner(owner))
          throw new DeviceError(400, "pairing_request_invalid", "Pairing needs the authenticated owner.");
        if (name !== undefined && !isName(name))
          throw new DeviceError(400, "pairing_request_invalid", "Name the device in 1 to 64 characters.");
        if (typeof secret !== "string" || !PAIRING_SECRET.test(secret)) throw refuseGrant(time, "invalid");
        const grants = state.grants.filter((grant) => grant.expiresAt > time);
        const grant = grants.find((candidate) => matchesSecret(secret, candidate.secretHash));
        if (!grant) {
          if (state.grants.some((candidate) => matchesSecret(secret, candidate.secretHash))) throw refuseGrant(time, "expired");
          const retired = retiredGrants.get(hashOf(secret));
          throw refuseGrant(time, retired && retired.until > time ? retired.reason : "invalid");
        }
        if (grant.owner !== owner) throw refuseGrant(time, "wrongOwner");
        const devices = state.devices.filter((candidate) => retained(candidate, time));
        const { device, deviceSecret } = mintDevice(time, devices, name ?? grant.name, owner);
        await commit({
          devices: [...devices, device],
          grants: grants.filter((candidate) => candidate !== grant),
        });
        retireGrant(grant.secretHash, "used", time);
        return { deviceId: device.id, deviceSecret, name: device.name, expiresAt: device.expiresAt };
      });
    },

    /**
     * A browser with identity but no device asks to be approved. Its secret is
     * returned once; only the digest is stored.
     */
    requestEnrollment({ name, owner }) {
      return serialize(async () => {
        available();
        const time = now();
        countAttempt(time);
        if (!isName(name)) throw new DeviceError(400, "enrollment_request_invalid", "Name the device in 1 to 64 characters.");
        if (!isOwner(owner))
          throw new DeviceError(400, "enrollment_request_invalid", "An access request needs the authenticated owner.");
        requirePendingRoom(time);
        const { grants, requests } = live(time);
        const secret = randomBytes(16).toString("base64url");
        const request = Object.freeze({
          id: randomUUID(),
          owner,
          name,
          secretHash: hashOf(secret),
          createdAt: time,
          expiresAt: time + requestLifetimeMs,
          status: "pending",
          approvedBy: null,
        });
        const devices = state.devices.filter((device) => retained(device, time));
        await commit({ devices, grants, requests: [...requests, request] });
        return { id: request.id, secret, phrase: phraseOf(request.id), expiresAt: request.expiresAt };
      });
    },

    /** Public status for the browser holding the request secret. */
    enrollmentStatus({ id, secret, owner }) {
      available();
      const time = now();
      countStatusRead(time, isId(id) ? id : "", isOwner(owner) ? owner : "");
      return publicRequest(provenRequest({ id, secret, owner }), time);
    },

    /** The owner's requests still waiting for a decision. Never secrets or digests. */
    pendingRequests({ owner }) {
      available();
      const time = now();
      return state.requests
        .filter((request) => request.owner === owner && statusOf(request, time) === "pending")
        .map((request) => ({
          id: request.id,
          name: request.name,
          phrase: phraseOf(request.id),
          createdAt: request.createdAt,
          ageMs: time - request.createdAt,
          expiresAt: request.expiresAt,
        }));
    },

    /**
     * Approves or rejects a pending request. `approver` is a device id, which is
     * rechecked here inside the serialized mutation, or LOCAL_ADMIN for the
     * admin socket.
     */
    decideEnrollment({ id, decision, owner, approver }) {
      return serialize(async () => {
        available();
        const time = now();
        if (decision !== "approve" && decision !== "reject")
          throw new DeviceError(400, "enrollment_request_invalid", 'Decide with "approve" or "reject".');
        if (!approverActive(approver, owner, time)) throw denied();
        const request = isId(id) ? state.requests.find((candidate) => candidate.id === id) : undefined;
        if (!request || request.owner !== owner) throw unknownRequest();
        const status = statusOf(request, time);
        if (status === "expired")
          throw new DeviceError(410, "enrollment_expired", "That access request expired. The new device must ask again.");
        if (status !== "pending")
          throw new DeviceError(409, "enrollment_decided", `That access request is already ${status}.`);
        const decided = Object.freeze({
          ...request,
          status: decision === "approve" ? "approved" : "rejected",
          approvedBy: decision === "approve" ? approver : null,
        });
        await commit({ requests: state.requests.map((candidate) => (candidate === request ? decided : candidate)) });
        return publicRequest(decided, time);
      });
    },

    /**
     * Consumes an approved request and creates its device in one replacement,
     * so a lost response can never replay the approval.
     */
    redeemEnrollment({ id, secret, owner }) {
      return serialize(async () => {
        available();
        const time = now();
        countAttempt(time);
        const request = provenRequest({ id, secret, owner });
        const status = statusOf(request, time);
        if (status === "expired")
          throw new DeviceError(410, "enrollment_expired", "This access request expired. Start a new request.");
        if (status === "rejected") throw new DeviceError(403, "enrollment_rejected", "This access request was rejected.");
        if (status === "consumed")
          throw new DeviceError(409, "enrollment_consumed", "This access request was already used. Start a new request.");
        if (status !== "approved")
          throw new DeviceError(409, "enrollment_not_approved", "This access request is still waiting for approval.");
        const devices = state.devices.filter((candidate) => retained(candidate, time));
        const { device, deviceSecret } = mintDevice(time, devices, request.name, owner);
        const consumed = Object.freeze({ ...request, status: "consumed" });
        await commit({
          devices: [...devices, device],
          requests: state.requests.map((candidate) => (candidate === request ? consumed : candidate)),
        });
        return { deviceId: device.id, deviceSecret, name: device.name, expiresAt: device.expiresAt };
      });
    },

    /** Checks an `ID.SECRET` credential. Identity is the caller's, already verified. */
    authorize({ credential, owner }) {
      available();
      if (typeof credential !== "string" || credential.length !== CREDENTIAL_LENGTH) throw denied();
      const parsed = CREDENTIAL.exec(credential);
      if (!parsed || !isOwner(owner)) throw denied();
      const [, id, secret] = parsed;
      const device = state.devices.find((candidate) => candidate.id === id);
      if (!device || !matchesSecret(secret, device.secretHash) || device.owner !== owner) throw denied();
      if (device.revokedAt !== null)
        throw new DeviceError(403, "device_revoked", "This device was revoked. Pair it again to reconnect.");
      if (!unexpired(device, now()))
        throw new DeviceError(403, "device_expired", "This device approval expired. Pair it again to reconnect.");
      return accessOf(device);
    },

    /** Recheck for callers that already proved the secret, such as a terminal ticket. */
    activeDevice({ deviceId, owner }) {
      available();
      if (typeof deviceId !== "string" || !UUID.test(deviceId) || !isOwner(owner)) throw denied();
      const device = state.devices.find((candidate) => candidate.id === deviceId);
      if (!device || device.owner !== owner || device.revokedAt !== null || !unexpired(device, now())) throw denied();
      return accessOf(device);
    },

    /**
     * Changes one device's expiry, or clears it. Tailscale calls the null case
     * disabling key expiry; the device stays revocable either way.
     */
    setExpiry({ deviceId, lifetimeMs }) {
      return serialize(async () => {
        available();
        const unknown = new DeviceError(404, "device_unknown", "No device has that identifier.");
        if (typeof deviceId !== "string" || !UUID.test(deviceId)) throw unknown;
        if (lifetimeMs !== null && !(Number.isSafeInteger(lifetimeMs) && lifetimeMs > 0))
          throw new DeviceError(400, "device_expiry_invalid", "Give a positive number of days, or never.");
        const device = state.devices.find((candidate) => candidate.id === deviceId);
        if (!device) throw unknown;
        if (device.revokedAt !== null)
          throw new DeviceError(409, "device_revoked", "That device was revoked. Pair it again instead.");
        const time = now();
        // Measured from now rather than from createdAt, so extending a device
        // that already lapsed brings it back for the full term.
        const expiresAt = lifetimeMs === null ? null : time + lifetimeMs;
        const updated = Object.freeze({ ...device, expiresAt });
        await commit({ devices: state.devices.map((candidate) => (candidate === device ? updated : candidate)) });
        return viewOf(updated, time);
      });
    },

    list() {
      available();
      const time = now();
      return state.devices.map((device) => viewOf(device, time));
    },

    revoke(deviceId) {
      return serialize(async () => {
        available();
        const unknown = new DeviceError(404, "device_unknown", "No device has that identifier.");
        if (typeof deviceId !== "string" || !UUID.test(deviceId)) throw unknown;
        const device = state.devices.find((candidate) => candidate.id === deviceId);
        if (!device) throw unknown;
        if (device.revokedAt !== null) return viewOf(device, now());
        const revoked = Object.freeze({ ...device, revokedAt: now() });
        await commit({ devices: state.devices.map((candidate) => (candidate === device ? revoked : candidate)) });
        return viewOf(revoked, now());
      });
    },

    /** Recent refused redemptions, oldest first: `{at, code}` only. */
    pairingRefusals() {
      return refusals.map((entry) => ({ ...entry }));
    },

    /** Drops expired rows and revoked never-expiring tombstones after 90 days. */
    prune() {
      return serialize(async () => {
        available();
        const time = now();
        const devices = state.devices.filter((device) => retained(device, time));
        const { grants, requests } = live(time);
        const removed = {
          devices: state.devices.length - devices.length,
          grants: state.grants.length - grants.length,
          requests: state.requests.length - requests.length,
        };
        if (removed.devices || removed.grants || removed.requests) await commit({ devices, grants, requests });
        return removed;
      });
    },
  };
}
