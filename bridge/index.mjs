#!/usr/bin/env node
import { createServer as createNetServer } from "node:net";
import { createPrivateLog, PrivateFileError, readPrivateFile, writePrivateFile } from "./private-files.mjs";
import { createDeviceStore, DEFAULT_DEVICE_LIFETIME_MS, DeviceError, EXPIRY_TERM, lifetimeOf } from "./devices.mjs";
import { createTickets, TicketError } from "./terminal-tickets.mjs";
import { commandFor } from "./command-name.mjs";
import { decodeAdminMessage, dispatchAdminRequest, SOCKET_FILE, MAX_REQUEST_BYTES, REQUEST_TIMEOUT_MS } from "./admin.mjs";
import { createServer, STATUS_CODES } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { mkdir, lstat, unlink, chmod } from "node:fs/promises";
import { isSea } from "node:sea";
import path from "node:path";
import { fileURLToPath } from "node:url";
import webpush from "web-push";
import { createPushDelivery, createPushReporter, createPushSender, createTransitionTracker, openPushStore, parsePushSubscription, PushError, pushAvailability } from "./push-delivery.mjs";
import { createHerdr, herdrInput, isHerdrKind } from "./herdr.mjs";
import { listAgentCommands } from "./commands.mjs";
import { createPiCommands } from "./pi-commands.mjs";
import { createDiagnosticLimiter, DiagnosticError, MAX_DIAGNOSTIC_BYTES, parseDiagnostic } from "./diagnostics.mjs";
import { createUploads, MAX_PROMPT_BODY, RequestError, readUploadedImage } from "./upload.mjs";
import { safeJoin } from "./paths.mjs";
import { createSessionReader } from "./sessions.mjs";
import { createSubmissions } from "./submissions.mjs";
import { createBrowserBoundary, createIdentitySecurity, isApiPath } from "./security.mjs";
import { createWorktreeAgent, mainWorktreeRoot, WorktreeInputError } from "./worktrees.mjs";
import { DEFAULT_STATE_DIR, loadHostConfig } from "./host-config.mjs";
import { diskSpa, embeddedSpa } from "./spa-source.mjs";

try {
  const hostEnv = await loadHostConfig(process.env);
  if (hostEnv) Object.assign(process.env, hostEnv);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const PORT = Number(process.env.MOSHPIT_PORT ?? 8787);
const STATE_DIR = process.env.MOSHPIT_STATE_DIR ?? DEFAULT_STATE_DIR;
// How long a paired device stays approved. "never" keeps devices until they
// are revoked, the way a tailnet can disable key expiry; a bad value is a
// startup failure rather than a silent fallback to the default.
const DEVICE_LIFETIME_MS = readDeviceLifetime(process.env.MOSHPIT_DEVICE_LIFETIME_DAYS);
const ENROLLMENT_REQUEST_MS = readTestRequestLifetime(process.env.MOSHPIT_TEST_ENROLLMENT_REQUEST_MS);
const BIND = process.env.MOSHPIT_BIND ?? "127.0.0.1";

/** Test-only: shortens access requests so a browser test can watch one expire. */
function readTestRequestLifetime(raw) {
  if (raw === undefined) return undefined;
  if (process.env.MOSHPIT_DEV_INSECURE === "1" && /^[1-9][0-9]{0,6}$/.test(raw)) return Number(raw);
  console.error("MOSHPIT_TEST_ENROLLMENT_REQUEST_MS is for tests only: set it to milliseconds, with MOSHPIT_DEV_INSECURE=1.");
  process.exit(1);
}
const PAIR_HEADER = "x-moshpit-device";

function readDeviceLifetime(raw) {
  if (raw === undefined) return DEFAULT_DEVICE_LIFETIME_MS;
  const lifetimeMs = lifetimeOf(raw);
  if (lifetimeMs !== undefined) return lifetimeMs;
  console.error('MOSHPIT_DEVICE_LIFETIME_DAYS must be a whole number of days from 1 to 3650, or "never".');
  process.exit(1);
}
const POLL_MS = Number(process.env.MOSHPIT_POLL_MS ?? 2000);
const PTY_POLL_MS = Number(process.env.MOSHPIT_PTY_POLL_MS ?? 100);
const SIZE_EVERY = 20; // re-read pane geometry every 20th pump tick
const INPUT_REFUSED = JSON.stringify({
  error: { code: "terminal_input_http", message: "Terminal input is sent over HTTP. Reload the app to type into this pane." },
});
const PUSH = pushAvailability(process.env);
const LOOPBACK = new Set(["127.0.0.1", "::1"]);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SPA = path.join(ROOT, "dist", "spa");
const spa = isSea() ? embeddedSpa() : diskSpa(SPA);
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

if (!LOOPBACK.has(BIND)) {
  console.error("bridge binds loopback only (127.0.0.1 or ::1)");
  process.exit(1);
}

let boundary, identity, store;
const tickets = createTickets();
try {
  boundary = createBrowserBoundary(process.env);
  identity = await createIdentitySecurity({ env: process.env });
  store = await createDeviceStore({ stateDir: STATE_DIR, deviceLifetimeMs: DEVICE_LIFETIME_MS, requestLifetimeMs: ENROLLMENT_REQUEST_MS });
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

// Every open terminal, keyed to the target it opened. Output for one target
// reaches only the connections that asked for it.
const socketTargets = new Map();
const socketAccess = new Map();
const herdr = createHerdr({
  onLine(target, line) {
    const payload = JSON.stringify({ target, line });
    for (const [socket, opened] of socketTargets) {
      if (opened === target) sendFrame(socket, payload);
    }
  },
});
const uploads = await createUploads({ stateDir: STATE_DIR });
const diagnosticLimiter = createDiagnosticLimiter();
const sessionReader = createSessionReader();
const piCommands = createPiCommands();
const submissions = createSubmissions({
  stateDir: STATE_DIR,
  herdr,
  canonical: (target) => herdr.paneId?.(target) ?? target,
  async prepareAttachment(image, request) {
    const saved = await uploads.save(image);
    const text = request.mode === "terminal" ? request.text : request.text.trim();
    return `${text || "Please inspect this image."}\n\nAttached image on this machine: ${JSON.stringify(saved.path)}\nOpen this file to view the image.`;
  },
});
await mkdir(STATE_DIR, { recursive: true });
const pushPath = path.join(STATE_DIR, "push.json");
const auditPath = path.join(STATE_DIR, "audit.jsonl");
const vapidPath = path.join(STATE_DIR, "vapid.json");

const auditLog = createPrivateLog(auditPath);
const clientLog = createPrivateLog(path.join(STATE_DIR, "client.log"));

async function loadVapid() {
  const saved = await readPrivateFile(vapidPath, { maxBytes: 64 * 1024 });
  if (saved !== null) {
    const keys = JSON.parse(saved);
    if (typeof keys?.publicKey !== "string" || typeof keys?.privateKey !== "string")
      throw new PrivateFileError(`${vapidPath} does not hold a VAPID key pair`);
    return keys;
  }
  const keys = webpush.generateVAPIDKeys();
  await writePrivateFile(vapidPath, `${JSON.stringify(keys)}\n`);
  return keys;
}

// An unsafe state or log file refuses startup with guidance, the way an
// unsafe device store does, instead of failing on the first request.
let vapid, pushStore;
try {
  await auditLog.check();
  await clientLog.check();
  vapid = await loadVapid();
  pushStore = await openPushStore(pushPath, {
    onCorrupt: () => console.error("push.json was unreadable; starting with no push subscriptions until browsers re-register"),
  });
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
// Apple returns 403 BadJwtToken unless the VAPID subject is a routable mailto
// or https URL, so a placeholder silently drops every iOS push. A Tailscale
// login is usually an email, but SSO ones (dan@github) are not.
const VAPID_SUBJECT = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(identity.owner)
  ? `mailto:${identity.owner}`
  : "https://github.com/lichuu/moshpit";
webpush.setVapidDetails(VAPID_SUBJECT, vapid.publicKey, vapid.privateKey);
// Subscriptions left behind by a revocation whose cleanup failed, or by
// devices that expired or were pruned, are dropped before any send.
await pushStore.retain((deviceId) => store.list().some((device) => device.id === deviceId && device.active));
if (!PUSH.available) console.error(`push unavailable: ${PUSH.reason}`);
const deliverPush = createPushDelivery({
  pushStore,
  devices: () => store.list(),
  activeDevice: (recipient) => store.activeDevice(recipient),
  send: createPushSender({ webpush }),
  reporter: createPushReporter(),
});

async function audit(entry) {
  await auditLog.append(JSON.stringify({ at: Date.now(), ...entry }));
}

async function requireAccess(req) {
  const access = await identity.requireIdentity(req);
  const device = store.authorize({ credential: req.headers[PAIR_HEADER], owner: access.owner });
  return { deviceId: device.deviceId, owner: access.owner, authSessionId: access.authSessionId };
}

function dropSockets(field, value) {
  for (const [ws, access] of socketAccess) {
    if (access[field] === value) {
      access.stop();
      ws.terminate();
    }
  }
}
async function updateDeviceExpiry({ deviceId, lifetimeMs }) {
  const result = await store.setExpiry({ deviceId, lifetimeMs });
  await audit({ kind: "expiry", deviceId, expiresAt: result.expiresAt });
  return result;
}

async function setDeviceExpiry(deviceId, term) {
  // The term arrives from a browser, so it is parsed here and never trusted
  // as milliseconds. The admin socket revalidates the same strings.
  const lifetimeMs = lifetimeOf(term);
  if (lifetimeMs === undefined) throw new DeviceError(400, "device_expiry_invalid", EXPIRY_TERM);
  return updateDeviceExpiry({ deviceId, lifetimeMs });
}

async function decideEnrollment(args) {
  const result = await store.decideEnrollment(args);
  await audit({ kind: "enrollment-decision", requestId: result.id, decision: args.decision, approver: args.approver });
  return result;
}

async function revokeDevice(deviceId) {
  const result = await store.revoke(deviceId);
  tickets.dropForDevice(deviceId);
  dropSockets("deviceId", deviceId);
  diagnosticLimiter.forget(deviceId);
  // Revocation is already committed; a failed cleanup here is retried by the
  // startup reconciliation, and delivery rechecks the device before sending.
  await pushStore.remove(deviceId).catch(() => console.error("push cleanup after revocation failed"));
  await audit({ kind: "revoke", deviceId });
  return result;
}

function json(res, status, body) {
  if (typeof body?.error === "string") body = { ...body, error: { code: status === 500 ? "internal_error" : "request_invalid", message: body.error } };
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(data),
  });
  res.end(data);
}

async function body(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) { req.resume(); throw new RequestError(413, "Request too large."); }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  let parsed;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new RequestError(400, "Invalid JSON."); }
  // Every caller reads properties off the result. A bare `null` or a scalar
  // would turn a malformed request into a 500 that echoes an internal
  // TypeError, so anything that is not an object is not a body.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RequestError(400, "Invalid JSON.");
  }
  return parsed;
}

// ws owns the handshake and framing. Messages over 64 KiB are closed with
// 1009 by the library; compression is off so a small frame cannot inflate.
const MAX_TERMINAL_MESSAGE = 64 * 1024;
const MAX_TERMINAL_BUFFERED = 256 * 1024;
const TERMINAL_SOCKETS_PER_DEVICE = 4;
const TERMINAL_SOCKETS = 32;
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_TERMINAL_MESSAGE, perMessageDeflate: false });

// Terminal capacity, reserved synchronously when an upgrade consumes its
// ticket and counted until the socket closes, so concurrent upgrades cannot
// pass the caps. release() is idempotent: rejection, close and error all
// call it.
const terminalSlots = new Map();
let terminalSlotsInUse = 0;
function reserveTerminal(deviceId) {
  const held = terminalSlots.get(deviceId) ?? 0;
  if (held >= TERMINAL_SOCKETS_PER_DEVICE)
    throw new TicketError(429, "terminal_device_limit", `This device already has ${TERMINAL_SOCKETS_PER_DEVICE} terminals open. Close one first.`);
  if (terminalSlotsInUse >= TERMINAL_SOCKETS)
    throw new TicketError(503, "terminal_limit", `This bridge already has ${TERMINAL_SOCKETS} terminals open. Try again shortly.`);
  terminalSlots.set(deviceId, held + 1);
  terminalSlotsInUse++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    terminalSlotsInUse--;
    const left = (terminalSlots.get(deviceId) ?? 1) - 1;
    if (left > 0) terminalSlots.set(deviceId, left);
    else terminalSlots.delete(deviceId);
  };
}

// A consumer that cannot keep up is disconnected with 1013 rather than
// allowed to grow the bridge's memory: the next payload is checked against
// what is already buffered before it is queued.
function sendFrame(ws, payload) {
  if (ws.readyState !== WebSocket.OPEN) return;
  if (ws.bufferedAmount + Buffer.byteLength(payload) > MAX_TERMINAL_BUFFERED) {
    ws.close(1013, "slow consumer");
    return;
  }
  ws.send(payload);
}

function acceptPty(req, ws, taken, release) {
  ws.once("close", release);
  // The target is fixed for the life of the connection. A frame cannot move
  // input or output to another pane.
  const target = taken.target;
  socketTargets.set(ws, target);
  socketAccess.set(ws, { ...taken, stop });
  ws.once("close", () => socketAccess.delete(ws));
  let lastLines = null;
  let lastSize = "";
  let ticks = 0;
  let pumping = true;
  async function authorized() {
    try {
      await identity.requireActiveTicketOwner(req, taken);
      store.activeDevice({ deviceId: taken.deviceId, owner: taken.owner });
      return true;
    } catch {
      stop();
      ws.close(1008, "not authorized");
      return false;
    }
  }
  function stop() {
    pumping = false;
    socketTargets.delete(ws);
  }
  const open = () => pumping && ws.readyState === WebSocket.OPEN;
  // ponytail: poll the pane and ship changed rows. byte stream if herdr grows one.
  // A read costs ~2ms, so PTY_POLL_MS is the whole of the perceived latency.
  async function pump() {
    if (!open()) return;
    try {
      if (!(await authorized()) || !pumping) return;
      // Geometry only moves when the user re-splits, so don't pay for it every tick.
      if (ticks++ % SIZE_EVERY === 0) {
        const size = await herdr.geometry(target).catch(() => null);
        const key = size ? `${size.cols}x${size.rows}` : "";
        const changed = key && key !== lastSize;
        if (changed) {
          lastSize = key;
          lastLines = null; // geometry moved; the client repaints from a full dump
          sendFrame(ws, JSON.stringify({ size }));
        }
      }
      // Split on CRLF: a trailing \r would send the client's cursor back to
      // column 0 and its erase-to-end-of-line would wipe the row just painted.
      const lines = (await herdr.dump(target)).split(/\r?\n/);
      if (!lastLines) {
        sendFrame(ws, JSON.stringify({ dump: lines.join("\n") }));
      } else {
        const changed = [];
        const n = Math.max(lines.length, lastLines.length);
        for (let i = 0; i < n; i++) {
          if (lines[i] !== lastLines[i]) changed.push([i, lines[i] ?? ""]);
        }
        if (changed.length) sendFrame(ws, JSON.stringify({ lines: changed }));
      }
      lastLines = lines;
    } catch {
      // A failed read is usually transient. A terminal that no longer exists
      // is not: close the socket, as the control session's terminal.closed
      // used to, so the client shows the pane as gone.
      const current = await herdr.terminal(target).catch(() => undefined);
      if (current === null && pumping) {
        stop();
        ws.close(1000, "terminal closed");
        return;
      }
    }
    if (open()) setTimeout(pump, PTY_POLL_MS);
  }
  pump();
  ws.on("message", (data, isBinary) => {
    if (!pumping) return;
    // A text protocol: binary input is refused outright.
    if (isBinary) {
      stop();
      ws.close(1003, "text frames only");
      return;
    }
    // The socket only views the pane. herdr acknowledges no input on the
    // control pipe, so keys go over HTTP through the pane's write lane,
    // where they are ordered and re-authorized. A frame addressing another
    // pane still closes the connection; any input is refused, never
    // forwarded and never retried over HTTP.
    let parsed = null;
    try {
      parsed = JSON.parse(String(data));
    } catch {
      /* raw keys from an old client */
    }
    if (parsed && typeof parsed === "object" && parsed.target !== undefined && parsed.target !== target) {
      stop();
      ws.close(1008, "wrong target");
      return;
    }
    sendFrame(ws, INPUT_REFUSED);
  });
  ws.on("close", stop);
  ws.on("error", stop);
}

async function serveSpa(req, res, url) {
  const file = safeJoin(SPA, url.pathname);
  if (!file) {
    res.writeHead(400);
    res.end();
    return;
  }
  let rel = path.relative(SPA, file);
  let entry = await spa.find(rel);
  if (!entry) {
    rel = path.join(rel, "index.html");
    entry = await spa.find(rel);
  }
  if (!entry) {
    rel = "index.html";
    entry = await spa.find(rel);
  }
  if (!entry) {
    res.writeHead(404);
    res.end("spa not built");
    return;
  }
  const ext = path.extname(rel);
  // Asset filenames carry a content hash, so they are safe to cache forever.
  // index.html, the worker and the manifest are not: caching them pins the
  // install to whichever bundle those files happened to name, and a rebuild
  // never reaches the device.
  const hashed = /\/assets\/.+-[A-Za-z0-9_-]{8,}\.[a-z]+$/.test(`/${rel}`);
  res.writeHead(200, {
    "content-type": MIME[ext] || "application/octet-stream",
    "cache-control": hashed
      ? "public, max-age=31536000, immutable"
      : "no-cache, must-revalidate",
    etag: entry.etag,
  });
  // The header is already out, so a read fault has no status left to report:
  // destroy the response and let the client see a truncated body rather than
  // letting the stream's 'error' escape as an uncaught exception.
  const stream = entry.stream();
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

const observeAgents = createTransitionTracker();
// setInterval does not wait for the previous poll, and a slow push provider
// can hold one for seconds, so a poll that finds another running skips.
let polling = false;

async function pollBlocked() {
  if (polling) return;
  polling = true;
  try {
    const snap = await herdr.snapshot();
    const agents = snap.agents ?? [];
    const titles = new Map(agents.map((a) => [a.id, a.title || a.name || a.id]));
    const newly = observeAgents(agents);
    if (!newly.length || !PUSH.available) return;
    await deliverPush(
      newly.map(({ id, type }) => ({
        type,
        agent: id,
        name: titles.get(id),
        prompt: type === "turn" ? "Finished its turn." : undefined,
        url: `/?tab=steer&agent=${id}`,
      })),
    );
  } catch {
    /* poll continues */
  } finally {
    polling = false;
  }
}

const server = createServer(async (req, res) => {
  try {
    // Headers set before admission: a refused request (403 origin, 415 media
    // type) is still a browser response and gets nosniff and no-referrer, and
    // every SPA response carries the CSP whether or not the build exists. API
    // responses carry credentials, tickets and agent output, so no cache keeps
    // them, errors included; the static app shell keeps its own caching.
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    if (isApiPath(new URL(req.url ?? "/", "http://127.0.0.1").pathname)) res.setHeader("cache-control", "no-store");
    else
      res.setHeader("content-security-policy", boundary.contentSecurityPolicy);
    // Origin, authority and content-type policy decide admission before any
    // route, body read or identity check runs.
    const { pathname, headers, preflight } = boundary.check(req, "http");
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    if (preflight) {
      res.writeHead(204);
      res.end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && pathname === "/api/auth-info") {
      // requesterLogin differs per caller; every /api/ answer is already no-store.
      json(res, 200, { ...identity.authInfo(), push: PUSH, connectOrigins: boundary.connectOrigins, requesterLogin: identity.requesterLogin(req) });
      return;
    }
    if (req.method === "GET" && pathname === "/api/vapid") {
      json(res, 200, { publicKey: vapid.publicKey });
      return;
    }
    if (req.method === "POST" && pathname === "/api/login") {
      try {
        const result = await identity.login(req, (await body(req))?.password);
        await audit({ kind: "login", authSessionId: result.authSessionId });
        json(res, 200, result);
      } catch (error) {
        await audit({ kind: "login-failure" });
        throw error;
      }
      return;
    }
    if (req.method === "POST" && pathname === "/api/logout") {
      try {
        const ctx = await identity.logout(req);
        tickets.dropForSession(ctx.authSessionId);
        dropSockets("authSessionId", ctx.authSessionId);
        await audit({ kind: "logout", authSessionId: ctx.authSessionId });
      } catch (error) {
        if (!["password_required", "logout_unsupported"].includes(error.code)) throw error;
      }
      json(res, 200, { ok: true });
      return;
    }
    // Identity alone never authorizes a new device: a revoked browser keeps its
    // identity, so self-issuance would let it pair straight back. Grants come
    // only from the private admin socket; the browser redeems one here.
    if (req.method === "POST" && pathname === "/api/devices/pair") {
      const ctx = await identity.requireIdentity(req);
      await audit({ kind: "pair-refused", owner: ctx.owner });
      throw new DeviceError(
        403,
        "enrollment_authorization_required",
        `This bridge approves new devices from the host. Run ${commandFor("admin")} pair --name "This device" there and enter the secret it prints.`,
      );
    }
    if (req.method === "POST" && pathname === "/api/devices/pairing") {
      const ctx = await identity.requireIdentity(req);
      const payload = await body(req);
      const result = await store.pair({ secret: payload.secret, name: payload.name, owner: ctx.owner });
      await audit({ kind: "pair", deviceId: result.deviceId });
      json(res, 200, { deviceId: result.deviceId, deviceSecret: result.deviceSecret, expiresAt: result.expiresAt });
      return;
    }
    // A browser with identity alone may ask for access and redeem an approval
    // it holds the request secret for. Listing and deciding need an approved
    // device, below, so identity never approves anything.
    if (req.method === "POST" && pathname === "/api/enrollment/request") {
      const ctx = await identity.requireIdentity(req);
      const result = await store.requestEnrollment({ name: (await body(req)).name, owner: ctx.owner });
      await audit({ kind: "enrollment-request", requestId: result.id });
      json(res, 200, result);
      return;
    }
    if (req.method === "POST" && pathname === "/api/enrollment/status") {
      const ctx = await identity.requireIdentity(req);
      const { id, secret } = await body(req);
      json(res, 200, store.enrollmentStatus({ id, secret, owner: ctx.owner }));
      return;
    }
    if (req.method === "POST" && pathname === "/api/enrollment/redeem") {
      const ctx = await identity.requireIdentity(req);
      const { id, secret } = await body(req);
      const result = await store.redeemEnrollment({ id, secret, owner: ctx.owner });
      await audit({ kind: "enrollment-redeem", requestId: id, deviceId: result.deviceId });
      json(res, 200, { deviceId: result.deviceId, deviceSecret: result.deviceSecret, expiresAt: result.expiresAt });
      return;
    }
    // Static navigation must load before the browser has credentials.
    const ctx = isApiPath(pathname) ? await requireAccess(req) : null;
    if (req.method === "GET" && pathname === "/api/devices") {
      json(res, 200, store.list());
      return;
    }
    if (req.method === "POST" && pathname === "/api/devices/revoke") {
      json(res, 200, await revokeDevice((await body(req)).deviceId));
      return;
    }
    if (req.method === "POST" && pathname === "/api/devices/expiry") {
      const { deviceId, term } = await body(req);
      json(res, 200, await setDeviceExpiry(deviceId, term));
      return;
    }
    if (req.method === "GET" && pathname === "/api/enrollment/requests") {
      json(res, 200, store.pendingRequests({ owner: ctx.owner }));
      return;
    }
    if (req.method === "POST" && pathname === "/api/enrollment/decision") {
      const { id, decision } = await body(req);
      json(res, 200, await decideEnrollment({ id, decision, owner: ctx.owner, approver: ctx.deviceId }));
      return;
    }
    if (req.method === "POST" && pathname === "/api/terminal-ticket") {
      const { target } = await body(req);
      if (typeof target !== "string" || !target || target.startsWith("-") || target.length > 128)
        throw new TicketError(400, "ticket_request_invalid", "Name the terminal to open.");
      const detail = await herdr.detail(target);
      const result = tickets.issue({ ...ctx, target: detail.terminal_id, paneId: detail.agentId });
      await audit({ kind: "ticket", deviceId: ctx.deviceId, target: detail.terminal_id });
      json(res, 200, result);
      return;
    }
    if (req.method === "GET" && pathname === "/api/snapshot") {
      json(res, 200, await herdr.snapshot());
      return;
    }
    if (req.method === "GET" && pathname === "/api/agent-detail") {
      const target = url.searchParams.get("target");
      if (!target) {
        json(res, 400, { error: "target is required" });
        return;
      }
      json(res, 200, await herdr.detail(target));
      return;
    }
    if (req.method === "GET" && pathname === "/api/session") {
      const target = url.searchParams.get("target");
      if (!target) {
        json(res, 400, { error: "target is required" });
        return;
      }
      const snapshot = await herdr.snapshot();
      const agent = snapshot.agents.find((candidate) => candidate.id === target);
      if (!agent) {
        json(res, 404, { error: "Unknown agent." });
        return;
      }
      const value = await sessionReader(agent, {
        after: url.searchParams.get("after") ?? undefined,
        before: url.searchParams.get("before") ?? undefined,
      });
      if (value.kind === "available" && herdr.capabilities) value.capabilities = await herdr.capabilities(agent);
      json(res, 200, value);
      return;
    }
    if (req.method === "GET" && pathname === "/api/upload") {
      const { bytes, type } = await readUploadedImage(url.searchParams.get("path"), STATE_DIR);
      res.writeHead(200, {
        "content-type": type,
        "content-length": bytes.length,
      });
      res.end(bytes);
      return;
    }
    if (req.method === "GET" && pathname === "/api/commands") {
      // Read-only, kind-validated catalog read: the client supplies the agent
      // kind only; the bridge resolves it to a fixed skill directory.
      const kind = url.searchParams.get("agent") ?? "";
      const catalog = await listAgentCommands(kind);
      // A pi pane can be asked for its live list (extension commands exist
      // only there). The client names the pane, never a path: the directory
      // comes from herdr's snapshot. The client asks for this after showing
      // the disk catalog, so a slow or missing pi only costs the upgrade.
      const target = url.searchParams.get("target");
      if (kind === "pi" && target) {
        const snapshot = await herdr.snapshot();
        const agent = snapshot.agents.find((candidate) => candidate.id === target);
        if (!agent) {
          json(res, 404, { error: "Unknown agent." });
          return;
        }
        if (agent.kind === "pi") {
          try {
            const commands = await piCommands.list(agent.cwd);
            json(res, 200, { ...catalog, commands, coverage: "full", live: true });
            return;
          } catch {
            json(res, 200, { ...catalog, live: false });
            return;
          }
        }
      }
      json(res, 200, catalog);
      return;
    }
    if (req.method === "GET" && pathname === "/api/repo-root") {
      // Read-only; same trusted-only guard as /api/snapshot. Returns the same
      // anchor the start action uses for the destination — the main worktree —
      // so a subdirectory or linked-worktree project previews where the
      // checkout really lands.
      const cwd = url.searchParams.get("cwd");
      if (!cwd) {
        json(res, 400, { error: "cwd is required" });
        return;
      }
      try {
        json(res, 200, { root: await mainWorktreeRoot(cwd) });
      } catch (err) {
        json(res, 400, { error: err instanceof WorktreeInputError ? err.message : "Repository root unavailable." });
      }
      return;
    }
    if (req.method === "POST" && pathname === "/api/push-subscription") {
      const payload = await body(req);
      const clear = payload.clearPush === true;
      const subscription = clear || payload.pushSubscription == null ? null : parsePushSubscription(payload.pushSubscription);
      // Clearing always works; saving a new subscription on a bridge that
      // cannot send would only let the browser believe it is subscribed.
      if (subscription && !PUSH.available) throw new PushError(503, "push_unavailable", PUSH.reason);
      await pushStore.update((list) => {
        const device = store.list().find((candidate) => candidate.id === ctx.deviceId);
        if (!device) throw new DeviceError(404, "device_unknown", "No device has that identifier.");
        if (!device.active)
          throw new DeviceError(403, device.revokedAt !== null ? "device_revoked" : "device_expired", "Pair it again to reconnect.");
        if (clear) delete list[ctx.deviceId];
        else if (subscription) list[ctx.deviceId] = subscription;
        else return undefined;
        return list;
      });
      json(res, 200, { ok: true });
      return;
    }
    // Client black box. The phone has no devtools, so errors and the actions
    // just before them are posted here and appended to client.log.
    if (req.method === "POST" && pathname === "/api/log") {
      diagnosticLimiter.take(ctx.deviceId);
      const entry = await body(req, MAX_DIAGNOSTIC_BYTES).catch((error) => {
        if (error.status === 413) throw new DiagnosticError(413, "diagnostic_too_large", `A diagnostic entry must be ${MAX_DIAGNOSTIC_BYTES} bytes or smaller.`);
        throw new DiagnosticError(400, "diagnostic_invalid", "The diagnostic entry is not a JSON object.");
      });
      const record = parseDiagnostic(entry);
      await clientLog.append(JSON.stringify({ ...record, deviceId: ctx.deviceId, at: new Date().toISOString(), ua: String(req.headers["user-agent"] ?? "").slice(0, 300) }));
      // The black box posts with keepalive. Chromium never reports a keepalive
      // request finished when a no-store response has a body, so a page that
      // logged anything never reads as network-idle; an empty 204 does.
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "POST" && pathname === "/api/action") {
      const action = await body(req, MAX_PROMPT_BODY);
      // Re-run inside the pane's lane, right before each write.
      const recheck = () => requireAccess(req);
      if (!action || typeof action !== "object") throw new RequestError(400, "An action is required.");
      if (action.kind === "start") {
        if (typeof action.cwd !== "string" || !action.cwd.trim()) throw new RequestError(400, "A project path is required.");
        if (!isHerdrKind(action.agentKind)) throw new RequestError(400, "Unknown agent kind.");
        const model = typeof action.model === "string" && action.model.trim() ? action.model.trim() : undefined;
        if (action.checkout !== undefined) {
          if (
            !action.checkout || typeof action.checkout !== "object" ||
            typeof action.checkout.baseRef !== "string" || !action.checkout.baseRef.trim() ||
            typeof action.checkout.branch !== "string" || !action.checkout.branch.trim()
          ) throw new RequestError(400, "Worktree launch needs a base ref and a branch.");
          let result;
          try {
            result = await createWorktreeAgent({
              repoCwd: action.cwd.trim(),
              baseRef: action.checkout.baseRef,
              branch: action.checkout.branch,
              agentKind: action.agentKind,
              model,
              startAgent: (args) => herdr.startAgent(args),
            });
          } catch (err) {
            if (err instanceof WorktreeInputError) throw new RequestError(400, err.message);
            throw err;
          }
          if (result.state === "created-agent-failed") {
            await audit({ kind: "action", action: "start-worktree", cwd: action.cwd, agentKind: action.agentKind, partial: true, path: result.path, branch: result.branch });
            // 422 + partial: the worktree is kept, so the client retries by
            // starting the agent in the retained directory — never re-running git.
            json(res, 422, { error: result.error, partial: { state: "created-agent-failed", path: result.path, branch: result.branch } });
            return;
          }
          await audit({ kind: "action", action: "start-worktree", cwd: action.cwd, agentKind: action.agentKind, paneId: result.paneId, path: result.path, branch: result.branch });
          json(res, 200, { ok: true, paneId: result.paneId, checkout: { path: result.path, branch: result.branch } });
          return;
        }
        const { paneId } = await herdr.startAgent({ cwd: action.cwd, agentKind: action.agentKind, model });
        await audit({ kind: "action", action: "start", cwd: action.cwd, agentKind: action.agentKind, paneId });
        json(res, 200, { ok: true, paneId });
        return;
      }
      if (action.kind === "open-shell") {
        if (typeof action.cwd !== "string" || !action.cwd.trim()) throw new RequestError(400, "A project path is required.");
        const { paneId } = await herdr.openShell({ cwd: action.cwd });
        await audit({ kind: "action", action: "open-shell", cwd: action.cwd, paneId });
        json(res, 200, { ok: true, paneId });
        return;
      }
      // A target reaches herdr as an argv element (pane rename/close), so a
      // leading dash would be read as a flag rather than a pane id. Same guard
      // the rename label gets below.
      if (typeof action.target !== "string" || !action.target) throw new RequestError(400, "An agent target is required.");
      if (action.target.startsWith("-")) throw new RequestError(400, "An agent target may not start with a dash.");
      let attachment;
      if (action.kind === "prompt") {
        if (typeof action.text !== "string" || action.text.length > 32768 || (!action.text.trim() && !action.attachment)) throw new RequestError(400, "A message or image is required. Messages must be under 32,768 characters.");
        if (action.attachment !== undefined) attachment = await uploads.save(action.attachment);
        const text = attachment
          ? `${action.text.trim() || "Please inspect this image."}\n\nAttached image on this machine: ${JSON.stringify(attachment.path)}\nOpen this file to view the image.`
          : action.text;
        await submissions.prompt(action.target, text, recheck);
      }
      else if (action.kind === "keys") {
        const keys = Array.isArray(action.keys) ? action.keys : [action.keys];
        if (!keys.length || keys.length > 16) throw new RequestError(400, "Send 1 to 16 keys.");
        // Every element is checked before the first is sent, so a refused
        // key never leaves the ones before it half-delivered.
        keys.forEach((key) => herdrInput(key));
        for (const key of keys) await submissions.write(action.target, key, recheck);
      }
      else if (action.kind === "answer") {
        if (typeof action.token !== "string" || !action.token) throw new RequestError(400, "An answer token is required.");
        if (typeof action.optionKey !== "string" || !action.optionKey) throw new RequestError(400, "An option key is required.");
        await submissions.answer(action.target, action.token, action.optionKey, recheck);
      }
      else if (action.kind === "block") await herdr.block(action.target);
      else if (action.kind === "rename") {
        if (action.clear !== true) {
          if (typeof action.name !== "string" || !action.name.trim() || action.name.length > 100) throw new RequestError(400, "A label is required. Labels must be under 100 characters.");
          if (action.name.trim().startsWith("-")) throw new RequestError(400, "A label may not start with a dash.");
        }
        await herdr.rename(action.target, action.name, action.clear === true);
        await audit({ kind: "action", action: "rename", target: action.target, clear: action.clear === true });
        json(res, 200, { ok: true });
        return;
      }
      else if (action.kind === "close") {
        await herdr.close(action.target);
        await audit({ kind: "action", action: "close", target: action.target });
        json(res, 200, { ok: true });
        return;
      }
      else {
        json(res, 400, { error: "unknown action" });
        return;
      }
      await audit({ kind: "action", action: action.kind, target: action.target, ...(attachment ? { attachment: { name: attachment.name, size: attachment.size, type: attachment.type } } : {}) });
      json(res, 200, { ok: true, ...(attachment ? { attachment } : {}) });
      return;
    }
    if (req.method === "POST" && pathname === "/api/submit") {
      const request = await body(req, MAX_PROMPT_BODY);
      let receipt;
      try {
        receipt = await submissions.submit(request, ctx.deviceId, () => requireAccess(req));
      } catch (error) {
        if (error instanceof RequestError) {
          json(res, error.status, { error: error.message });
          return;
        }
        throw error;
      }
      await audit({ kind: "submit", target: request?.target, mode: request?.mode, state: receipt.state });
      json(res, 200, receipt);
      return;
    }
    if (isApiPath(pathname)) {
      json(res, 404, { error: "not found" });
      return;
    }
    await serveSpa(req, res, url);
  } catch (err) {
    if (err.retryAfter) res.setHeader("retry-after", err.retryAfter);
    json(res, err.status ?? 500, { error: { code: err.code ?? (err.status ? "request_invalid" : "internal_error"), message: err.message ?? String(err) } });
  }
});

// The upgrade listener is synchronous and has no response object, so every
// denial — including one from the awaited registry read — has to reach the raw
// socket instead of escaping as an uncaught rejection.
function rejectUpgrade(socket, error) {
  if (socket.destroyed) return;
  const status = error.status ?? 500;
  const data = JSON.stringify({ error: { code: error.code ?? "request_invalid", message: error.message } });
  socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(data)}\r\n\r\n${data}`);
}

// The client sends exactly one ticket and nothing else. searchParams.get
// would silently take the first of two tickets, so repeats and unknown
// parameters are refused before any ticket is spent.
function ticketParameter(url) {
  const names = [...url.searchParams.keys()];
  if (names.length !== 1 || names[0] !== "ticket")
    throw new TicketError(400, "terminal_query_invalid", "A terminal URL carries exactly one ticket and nothing else.");
  return url.searchParams.get("ticket");
}

async function openTerminal(req, socket, head) {
  boundary.check(req, "websocket");
  const ticket = ticketParameter(new URL(req.url ?? "/", "http://127.0.0.1"));
  // Consumed before the first await and final whatever happens next.
  const taken = tickets.take(ticket);
  if (!taken) throw new TicketError(401, "ticket_invalid", "This terminal ticket is invalid or expired.");
  const release = reserveTerminal(taken.deviceId);
  try {
    // A pane that closed, or a terminal now in another pane, since the ticket
    // was issued must not attach the socket to whatever replaced it.
    const current = await herdr.terminal(taken.target);
    if (!current) throw new TicketError(404, "terminal_not_found", "This terminal has closed.");
    if (taken.paneId !== undefined && current.paneId !== taken.paneId)
      throw new TicketError(409, "terminal_target_stale", "This terminal changed since it was opened. Open it again.");
    const owner = await identity.requireActiveTicketOwner(req, taken);
    store.activeDevice({ deviceId: taken.deviceId, owner: owner.owner });
    if (socket.destroyed) throw new RequestError(400, "The connection closed during the upgrade.");
  } catch (error) {
    release();
    throw error;
  }
  // handleUpgrade answers a malformed handshake itself (400) and never calls
  // back, so the reservation is released on the socket's close as well.
  socket.once("close", release);
  wss.handleUpgrade(req, socket, head, (ws) => acceptPty(req, ws, taken, release));
}

server.on("upgrade", (req, socket, head) => {
  // Node drops its own socket error handler before emitting 'upgrade', and
  // ws only attaches one after the handshake. Every denial answers on a bare
  // socket, so a peer that resets the connection mid-write would otherwise
  // take the bridge down with an uncaught ECONNRESET.
  socket.on("error", () => {});
  openTerminal(req, socket, head).catch((err) => rejectUpgrade(socket, err));
});

async function startAdmin() {
  const file = path.join(STATE_DIR, SOCKET_FILE);
  try {
    const info = await lstat(file);
    if (!info.isSocket() || info.uid !== process.getuid()) throw new Error(`${file} is not a socket owned by this user`);
    await unlink(file);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const admin = createNetServer((socket) => {
    let bytes = Buffer.alloc(0);
    let replied = false;
    socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy());
    socket.on("error", () => {});
    socket.on("data", async (chunk) => {
      if (replied) return;
      bytes = Buffer.concat([bytes, chunk]);
      const newline = bytes.indexOf(10);
      if (newline === -1 && bytes.length <= MAX_REQUEST_BYTES) return;
      replied = true;
      const decoded = decodeAdminMessage(bytes.subarray(0, newline === -1 ? bytes.length : newline).toString("utf8"));
      const result = decoded.error ? decoded : await dispatchAdminRequest(decoded.message, {
        devices: {
          issueGrant: (args) => store.issueGrant(args),
          list: () => store.list(),
          revoke: revokeDevice,
          setExpiry: updateDeviceExpiry,
          pendingRequests: (args) => store.pendingRequests(args),
          decideEnrollment,
        },
        owner: identity.owner,
      });
      socket.end(`${JSON.stringify(result)}\n`);
    });
  });
  await new Promise((resolve, reject) => {
    admin.once("error", reject);
    const mask = process.umask(0o177);
    try {
      admin.listen(file, () => chmod(file, 0o600).then(resolve, reject));
    } finally {
      process.umask(mask);
    }
  });
}

server.listen(PORT, BIND, async () => {
  try {
    await startAdmin();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  console.log(`moshpit-bridge ${BIND}:${PORT}`);
  pollBlocked();
  setInterval(pollBlocked, POLL_MS);
  setInterval(() => store.prune().catch(() => {}), 60 * 60 * 1000).unref();
});
