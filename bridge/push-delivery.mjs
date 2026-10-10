import { readPrivateFile, writePrivateFile } from "./private-files.mjs";
import { RequestFilteringHttpsAgent } from "request-filtering-agent";

// Web Push endpoints the bridge will POST to. A browser's push service is
// always one of these; anything else names the exact host it refused, so an
// unknown provider shows up as a one-line addition here rather than as
// notifications that never arrive. This list is a string check, not the
// security boundary: the filtering agent below decides where a connection
// may actually go.
export const PUSH_HOSTS = Object.freeze(["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com"]);
export const PUSH_TIMEOUT_MS = 10_000;
const MAX_ENDPOINT = 2048;
const MAX_KEY = 256;
const MAX_REPORTED = 64;
const MAX_RESPONSE = 64 * 1024;

export class PushError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "PushError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Whether this bridge can send push at all. `MOSHPIT_PUSH_ENDPOINT` used to
 * relay each endpoint to a configured URL, and web-push drops its agent
 * whenever a proxy is set, so either route skips the address filtering.
 * Push stays off and says why instead of forwarding an unvalidated endpoint.
 */
export function pushAvailability(env) {
  if (env.MOSHPIT_PUSH_ENDPOINT)
    return {
      available: false,
      reason: "This host relays push through MOSHPIT_PUSH_ENDPOINT, which bypasses the bridge's address checks, so notifications are off. Unset it and restart the bridge.",
    };
  return { available: true };
}

const invalid = (message) => new PushError(400, "push_endpoint_invalid", message);

/** Parses an endpoint and refuses anything but a bare https URL at a push provider. */
export function checkPushEndpoint(raw) {
  if (typeof raw !== "string" || raw.length > MAX_ENDPOINT) throw invalid("Invalid push subscription.");
  const endpoint = URL.parse(raw);
  if (!endpoint) throw invalid("Invalid push subscription.");
  const host = endpoint.hostname;
  if (endpoint.protocol !== "https:") throw invalid(`Push endpoint for ${host || "that address"} must use https.`);
  if (endpoint.username || endpoint.password) throw invalid(`Push endpoint for ${host} must not carry credentials.`);
  if (raw.includes("#")) throw invalid(`Push endpoint for ${host} must not carry a fragment.`);
  if (endpoint.port) throw invalid(`Push endpoint for ${host} must use the default https port.`);
  if (!PUSH_HOSTS.includes(host))
    throw invalid(`Push endpoint host ${host} is not a known push service (${PUSH_HOSTS.join(", ")}).`);
  return endpoint;
}

/** Validates a browser's PushSubscription JSON and keeps only the fields sending needs. */
export function parsePushSubscription(sub) {
  if (sub === null || typeof sub !== "object" || Array.isArray(sub)) throw invalid("Invalid push subscription.");
  checkPushEndpoint(sub.endpoint);
  const keys = sub.keys;
  if (
    keys === null || typeof keys !== "object" ||
    typeof keys.p256dh !== "string" || typeof keys.auth !== "string" ||
    !keys.p256dh || !keys.auth || keys.p256dh.length > MAX_KEY || keys.auth.length > MAX_KEY
  )
    throw invalid("Invalid push subscription.");
  return {
    endpoint: sub.endpoint,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
    ...(typeof sub.expirationTime === "number" ? { expirationTime: sub.expirationTime } : {}),
  };
}

/**
 * How much of an alert a device's lock screen may show. Stored beside the
 * subscription; an entry saved before the setting existed, or one holding a
 * value this build does not know, reads as "full".
 */
export const PUSH_PRIVACY_LEVELS = Object.freeze(["full", "name", "generic"]);

/** Validates a level a client sent. Missing is the caller's business; anything else must be a known level. */
export function parsePushPrivacy(level) {
  if (typeof level === "string" && PUSH_PRIVACY_LEVELS.includes(level)) return level;
  throw new PushError(400, "push_privacy_invalid", `Notification text must be one of ${PUSH_PRIVACY_LEVELS.join(", ")}.`);
}

/** The level a saved entry sends at. */
export function pushPrivacyOf(entry) {
  return PUSH_PRIVACY_LEVELS.includes(entry?.privacy) ? entry.privacy : "full";
}

/**
 * Builds the payload a device at `level` receives from the full one. Fields
 * are copied, never blanked, so a withheld value is not in the encrypted body
 * at all. `type` only picks the wording; `url` is an opaque in-app address
 * that the worker opens on a tap and never displays. At "generic" the agent
 * id goes too, since the url already carries what a tap needs.
 */
export function pushPayloadFor(payload, level) {
  const { type, agent, name, prompt, url } = payload;
  const allowed =
    level === "generic" ? { type, url }
    : level === "name" ? { type, agent, name, url }
    : { type, agent, name, prompt, url };
  return Object.fromEntries(Object.entries(allowed).filter(([, value]) => value !== undefined));
}

const sameSubscription = (a, b) =>
  Boolean(a?.keys && b?.keys) && a.endpoint === b.endpoint && a.keys.p256dh === b.keys.p256dh && a.keys.auth === b.keys.auth;

/**
 * An https.Agent that checks the addresses DNS actually returned, every one
 * of them, at connect time, and refuses private, loopback, link-local and
 * reserved ranges. That defeats a public name that resolves inward. Tests
 * pass `lookup` to stand in for DNS.
 */
export function createPushAgent({ maxResponseBytes = MAX_RESPONSE, onOverflow, ...options } = {}) {
  return new PushAgent({ keepAlive: false, ...options }, maxResponseBytes, onOverflow);
}

// web-push reads the whole response body into a string, so the agent counts
// what each socket delivers and cuts one that exceeds the bound.
class PushAgent extends RequestFilteringHttpsAgent {
  constructor(options, maxResponseBytes, onOverflow) {
    super(options);
    this.maxResponseBytes = maxResponseBytes;
    this.onOverflow = onOverflow;
  }

  createConnection(options, connectionListener) {
    const socket = super.createConnection(options, connectionListener);
    let read = 0;
    socket.on("data", (chunk) => {
      read += chunk.length;
      if (read <= this.maxResponseBytes || socket.destroyed) return;
      const error = new Error("Push response too large");
      socket.destroy(error);
      this.onOverflow?.(error);
    });
    return socket;
  }
}

/**
 * Sends one notification through web-push with a fresh filtering agent. The
 * socket timeout covers an idle connection. The deadline settles the send by
 * itself, because web-push never settles when a socket dies mid-response.
 */
export function createPushSender({ webpush, agentOptions = {}, timeoutMs = PUSH_TIMEOUT_MS }) {
  return (subscription, payload) => {
    let agent;
    let deadline;
    const settled = new Promise((resolve, reject) => {
      agent = createPushAgent({ ...agentOptions, onOverflow: reject });
      deadline = setTimeout(() => reject(new Error("Socket timeout")), timeoutMs);
      let sending;
      try {
        // Never `proxy`: web-push ignores `agent` whenever a proxy is set.
        sending = webpush.sendNotification(subscription, payload, { agent, timeout: timeoutMs });
      } catch (error) {
        sending = Promise.reject(error);
      }
      sending.then(resolve, reject);
    });
    // However the send settles, the timer goes and the socket is closed, so a
    // request cut short by the deadline or the size bound keeps nothing open.
    return settled.finally(() => {
      clearTimeout(deadline);
      agent.destroy();
    });
  };
}

// A provider token such as Apple's `BadJwtToken`, read from the JSON body only
// when it has that shape. The body itself is never logged.
function reasonToken(body) {
  if (typeof body !== "string" || body.length > 1024) return undefined;
  try {
    const reason = JSON.parse(body)?.reason;
    return typeof reason === "string" && /^[A-Za-z]{1,64}$/.test(reason) ? reason : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Turns a send failure into something safe to log: a status, a category and,
 * where the provider gives one, its reason code. 403 alone does not say
 * whether the VAPID subject, the key or the provider is at fault, so the
 * provider's own code is kept when there is one.
 */
export function describePushFailure(error) {
  const status = error?.statusCode ?? error?.status;
  if (typeof status === "number") {
    const reason = reasonToken(error?.body);
    const category =
      status === 404 || status === 410 ? "subscription gone"
      : status === 401 || status === 403 ? "sender rejected"
      : status === 413 ? "payload too large"
      : status === 429 ? "rate limited"
      : status >= 500 ? "provider error"
      : status >= 400 ? "request rejected"
      : "unexpected status";
    return { status, category, ...(reason ? { reason } : {}) };
  }
  const message = typeof error?.message === "string" ? error.message : "";
  if (/^DNS lookup .* is not allowed/.test(message)) return { status: null, category: "refused a non-public address" };
  if (message === "Socket timeout") return { status: null, category: "timed out" };
  if (message === "Push response too large") return { status: null, category: "response too large" };
  const code = typeof error?.code === "string" && /^E[A-Z_]{1,40}$/.test(error.code) ? error.code : undefined;
  return { status: null, category: "network error", ...(code ? { reason: code } : {}) };
}

/**
 * Says each distinct failure once per provider host rather than on every
 * poll. The memory of what was said is bounded; forgetting it only means a
 * failure may be reported again.
 */
export function createPushReporter(log = (line) => console.error(line)) {
  const said = new Set();
  return {
    failed(endpoint, error) {
      const host = URL.parse(endpoint)?.hostname ?? "unknown host";
      const { status, category, reason } = describePushFailure(error);
      const key = `${status}:${category}:${reason ?? ""}:${host}`;
      if (said.has(key)) return;
      if (said.size >= MAX_REPORTED) said.clear();
      said.add(key);
      log(`push send failed ${status ?? "-"} ${category}${reason ? ` (${reason})` : ""} to ${host}`);
    },
    refused(endpoint, error) {
      const host = URL.parse(endpoint)?.hostname ?? "unknown host";
      const key = `refused:${host}`;
      if (said.has(key)) return;
      if (said.size >= MAX_REPORTED) said.clear();
      said.add(key);
      log(`push skipped for ${host}: ${error instanceof PushError ? error.message : "invalid subscription"}`);
    },
  };
}

/**
 * The saved subscriptions, one per device, held in memory so a send can
 * recheck the current one synchronously. Every change is serialized and
 * written to a private temp file that then replaces the old one.
 */
// Far above what one subscription per device needs; a larger file was not
// written by this bridge.
const MAX_PUSH_STATE_BYTES = 1024 * 1024;

export async function openPushStore(file, { onCorrupt } = {}) {
  let state = {};
  // The file is a cache of subscriptions browsers resend when they
  // reconnect, so a torn one starts empty rather than stopping the bridge.
  // Dropping it cannot widen anyone's access.
  try {
    const saved = await readPrivateFile(file, { maxBytes: MAX_PUSH_STATE_BYTES });
    if (saved !== null) {
      const parsed = JSON.parse(saved);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) state = parsed;
      else onCorrupt?.();
    }
  } catch (error) {
    if (error instanceof SyntaxError) onCorrupt?.();
    else throw error;
  }
  let lane = Promise.resolve();
  async function save(next) {
    await writePrivateFile(file, `${JSON.stringify(next)}\n`);
    state = next;
  }
  return {
    get(deviceId) {
      return Object.hasOwn(state, deviceId) ? state[deviceId] ?? null : null;
    },
    /**
     * Runs `mutate(copy)` in the lane and saves what it returns; returning
     * `undefined` skips the write. A mutation that throws changes nothing.
     */
    update(mutate) {
      const run = async () => {
        const next = await mutate({ ...state });
        if (next !== undefined) await save(next);
      };
      const done = lane.then(run, run);
      lane = done.catch(() => {});
      return done;
    },
    /** Clears one device's subscription, if it has one. */
    remove(deviceId) {
      return this.update((next) => {
        if (!next[deviceId]) return undefined;
        delete next[deviceId];
        return next;
      });
    },
    /** Clears `endpoint` only if it is still that device's subscription. */
    removeIfCurrent(deviceId, subscription) {
      return this.update((next) => {
        if (!sameSubscription(next[deviceId], subscription)) return undefined;
        delete next[deviceId];
        return next;
      });
    },
    /** Drops every entry whose device `keep` rejects: revoked, expired, or unknown. */
    retain(keep) {
      return this.update((next) => {
        let changed = false;
        for (const deviceId of Object.keys(next)) {
          if (next[deviceId] && keep(deviceId)) continue;
          delete next[deviceId];
          changed = true;
        }
        return changed ? next : undefined;
      });
    },
  };
}

/**
 * Remembers each agent's last status and reports the transitions that wake a
 * phone: newly blocked, and a finished turn. The first sighting of an agent
 * is not a transition.
 */
export function createTransitionTracker() {
  let last = new Map();
  return (agents) => {
    const next = new Map(agents.map((agent) => [agent.id, agent.status]));
    const newly = [];
    for (const [id, status] of next) {
      const prev = last.get(id);
      if (!prev) continue;
      if (status === "blocked" && prev !== "blocked") newly.push({ id, type: "block" });
      else if (prev === "working" && (status === "idle" || status === "done")) newly.push({ id, type: "turn" });
    }
    last = next;
    return newly;
  };
}

/**
 * Delivers payloads to every active device's subscription, one request at a
 * time. Recipients are queued as `{deviceId, owner, subscription}`, and each
 * is rechecked synchronously just before its request is created: a device
 * revoked or expired, or a subscription replaced, while earlier sends were in
 * flight gets no request. A request already sent cannot be recalled.
 */
export function createPushDelivery({ pushStore, devices, activeDevice, send, reporter }) {
  function current(recipient) {
    try {
      activeDevice({ deviceId: recipient.deviceId, owner: recipient.owner });
    } catch {
      return false;
    }
    return sameSubscription(pushStore.get(recipient.deviceId), recipient.subscription);
  }

  return async function deliver(payloads) {
    const recipients = [];
    for (const device of devices()) {
      if (!device.active) continue;
      const subscription = pushStore.get(device.id);
      if (!subscription) continue;
      // Subscriptions saved before the allowlist existed meet it here.
      try {
        parsePushSubscription(subscription);
      } catch (error) {
        reporter.refused(subscription.endpoint, error);
        continue;
      }
      recipients.push({ deviceId: device.id, owner: device.owner, subscription });
    }
    const gone = new Set();
    let sent = 0;
    for (const payload of payloads) {
      for (const recipient of recipients) {
        if (gone.has(recipient)) continue;
        // Nothing may await between this check and the request web-push
        // creates synchronously inside send().
        if (!current(recipient)) continue;
        // Read at send time, so a device that raised its privacy while earlier
        // sends were in flight gets the stricter payload.
        const body = JSON.stringify(pushPayloadFor(payload, pushPrivacyOf(pushStore.get(recipient.deviceId))));
        try {
          sent += 1;
          await send(recipient.subscription, body);
        } catch (error) {
          const status = error?.statusCode ?? error?.status;
          if (status === 404 || status === 410) gone.add(recipient);
          else reporter.failed(recipient.subscription.endpoint, error);
        }
      }
    }
    // A 410 for a subscription the device has since replaced must not clear
    // the replacement, so each removal checks it is still the current one.
    for (const recipient of gone) await pushStore.removeIfCurrent(recipient.deviceId, recipient.subscription);
    return { sent, gone: gone.size };
  };
}
