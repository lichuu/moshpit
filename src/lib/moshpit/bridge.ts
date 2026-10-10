import { z } from "zod";
import type { Agent, AgentDetail, Attachment, Host, PairPush, PushPrivacy, PushSetup, Shell } from "./types";
import { BRIDGE_PROBE_MS } from "./types";
import { breadcrumb } from "./blackbox";
import { accessError, credentials, identityHeaders, requireReady, saveCredentials, setHostAccess } from "./access";
import { parseScopedCommandsResponse, type CommandScope, type RemoteCatalog } from "./commands";

export { BRIDGE_PROBE_MS };

// A bridge response is untrusted input: it carries credentials and terminal
// tickets, and a host can be any address the user typed. Parse rather than
// cast, and name the endpoint so a malformed one is diagnosable.
async function parsed<T>(res: Response, schema: z.ZodType<T>, what: string): Promise<T> {
  const result = schema.safeParse(await res.json().catch(() => null));
  if (!result.success) throw new Error(`The bridge returned an unusable ${what} response.`);
  return result.data;
}

// A bridge from before push availability was reported sends push as it always
// did, so a missing field reads as available.
const PushAvailabilitySchema = z.object({ available: z.boolean(), reason: z.string().max(500).optional() });
const AuthInfoSchema = z.object({
  protocol: z.number().int(),
  requiredFactors: z.array(z.string()),
  push: PushAvailabilitySchema.optional(),
  // The caller's own Tailscale login; older bridges omit it.
  requesterLogin: z.string().max(256).nullable().optional(),
});
export type PushAvailability = z.infer<typeof PushAvailabilitySchema>;
const PairedSchema = z.object({ deviceId: z.string().min(1), deviceSecret: z.string().min(1), expiresAt: z.number().nullable() });
const TicketSchema = z.object({ ticket: z.string().min(1), expiresAt: z.number() });
const LoginSchema = z.object({ token: z.string().min(1), owner: z.string() });
const VapidSchema = z.object({ publicKey: z.string().min(1) });

export type Snapshot = {
  hostId: string;
  at: number;
  agents: Agent[];
  panes: { id: string; agentId: string }[];
  shells?: Shell[];
  kinds?: string[];
};

/**
 * One element of a keys action: a key name or single character as a string,
 * or literal text marked as { text }. The bridge refuses a longer string
 * rather than guessing whether it is a key name or a word.
 */
export type KeyInput = string | { text: string };

export type Action =
  | {
      kind: "prompt";
      target: string;
      text: string;
      attachment?: { name: string; type: string; data: string };
    }
  | { kind: "keys"; target: string; keys: KeyInput | KeyInput[]; sessionId?: string }
  | { kind: "answer"; target: string; token: string; optionKey: string }
  | { kind: "start"; cwd: string; agentKind: string; model?: string; checkout?: { baseRef: string; branch: string } }
  | { kind: "open-shell"; cwd: string }
  | { kind: "rename"; target: string; name?: string; clear?: boolean }
  | { kind: "close"; target: string };

export async function postLogout(url: string) {
  // Dropping the local token is the part the user asked for, so it happens
  // whether or not the bridge answers: a 403 from an origin change, a 5xx or a
  // dead network must not leave a 12-hour bearer sitting in localStorage.
  try {
    const res = await fetch(`${url}/api/logout`, { method: "POST", headers: identityHeaders(url), redirect: "error" });
    if (!res.ok && res.status !== 401) throw await accessError(res, url, "logout");
  } finally {
    saveCredentials(url, { sessionToken: undefined });
    setHostAccess(url, { status: "disconnected" });
  }
}

export async function discoverAccess(url: string) {
  const res = await fetch(`${url}/api/auth-info`, { cache: "no-store", signal: AbortSignal.timeout(BRIDGE_PROBE_MS) });
  if (!res.ok) throw await accessError(res, url, "auth info");
  const info = await parsed(res, AuthInfoSchema, "auth info");
  if (info.protocol !== 2) return setHostAccess(url, { status: "incompatible", requiredProtocol: info.protocol });
  const c = credentials(url);
  if (info.requiredFactors.includes("password") && !c.sessionToken) return setHostAccess(url, { status: "login-required" });
  if (!c.deviceId || !c.deviceSecret) return setHostAccess(url, { status: "pairing-required", reason: "new" });
  // Cached expiry is display metadata only. The bridge may have extended or
  // cleared it since this client last connected, so authorization decides.
  return setHostAccess(url, { status: "ready", deviceId: c.deviceId, deviceExpiresAt: c.deviceExpiresAt ?? null });
}

/** The Tailscale account this browser reaches the bridge as, or null when the bridge names none. */
export async function fetchRequesterLogin(url: string): Promise<string | null> {
  const res = await fetch(`${url}/api/auth-info`, { cache: "no-store", signal: AbortSignal.timeout(BRIDGE_PROBE_MS) });
  if (!res.ok) throw await accessError(res, url, "auth info");
  return (await parsed(res, AuthInfoSchema, "auth info")).requesterLogin ?? null;
}

/**
 * Redeems a grant the host issued from its admin socket. Identity alone cannot
 * mint one, so a browser never asks the bridge for its own secret; an omitted
 * name keeps the one the host chose.
 */
export async function consumePairing(url: string, secret: string, name?: string) {
  const res = await fetch(`${url}/api/devices/pairing`, { method: "POST", headers: identityHeaders(url), redirect: "error", body: JSON.stringify({ secret, ...(name === undefined ? {} : { name }) }) });
  if (!res.ok) throw await accessError(res, url, "pairing");
  const paired = await parsed(res, PairedSchema, "pairing");
  saveCredentials(url, { deviceId: paired.deviceId, deviceSecret: paired.deviceSecret, deviceExpiresAt: paired.expiresAt });
}

/**
 * Whether the stored device credential still authorizes this browser, before
 * any connect has marked the host ready. Rejects with the bridge's refusal.
 */
export async function checkDeviceCredential(url: string) {
  const res = await fetch(`${url}/api/devices`, { cache: "no-store", headers: identityHeaders(url), redirect: "error" });
  if (!res.ok) throw await accessError(res, url, "devices");
}

const DeviceRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  owner: z.string(),
  createdAt: z.number(),
  expiresAt: z.number().nullable(),
  revokedAt: z.number().nullable(),
  active: z.boolean(),
});
/** A device as the bridge reports it. A null expiry is one the host chose not to expire. */
export type DeviceRecord = z.infer<typeof DeviceRecordSchema>;

export async function listDevices(url: string, signal?: AbortSignal) {
  const res = await fetch(`${url}/api/devices`, { cache: "no-store", headers: headers(url), redirect: "error", signal });
  if (!res.ok) throw await accessError(res, url, "devices", signal);
  return await parsed(res, z.array(DeviceRecordSchema), "devices");
}

export async function revokeDevice(url: string, deviceId: string) {
  const res = await fetch(`${url}/api/devices/revoke`, { method: "POST", headers: headers(url), redirect: "error", body: JSON.stringify({ deviceId }) });
  if (!res.ok) throw await accessError(res, url, "revoke device");
  const revoked = await parsed(res, DeviceRecordSchema, "revoke device");
  if (credentials(url).deviceId === deviceId) {
    saveCredentials(url, { deviceId: undefined, deviceSecret: undefined, deviceExpiresAt: undefined });
    setHostAccess(url, { status: "pairing-required", reason: "revoked" });
  }
  return revoked;
}

/** `term` is "never" or a whole number of days, parsed by the bridge. */
export async function setDeviceExpiry(url: string, deviceId: string, term: string) {
  const res = await fetch(`${url}/api/devices/expiry`, { method: "POST", headers: headers(url), redirect: "error", body: JSON.stringify({ deviceId, term }) });
  if (!res.ok) throw await accessError(res, url, "device expiry");
  return await parsed(res, DeviceRecordSchema, "device expiry");
}

export async function terminalTicket(url: string, target: string) {
  const res = await fetch(`${url}/api/terminal-ticket`, { method: "POST", headers: headers(url), redirect: "error", body: JSON.stringify({ target }) });
  if (!res.ok) throw await accessError(res, url, "terminal ticket");
  return await parsed(res, TicketSchema, "terminal ticket");
}

export function encodeImage(
  file: Attachment,
): Promise<{ name: string; type: string; data: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("Could not read the image"));
        return;
      }
      resolve({
        name: file.name,
        type: file.type,
        data: reader.result.slice(reader.result.indexOf(",") + 1),
      });
    };
    reader.onerror = () => reject(new Error("Could not read the image"));
    reader.readAsDataURL(file);
  });
}

// Every fetch that sends these headers also sets redirect: "error". A browser
// keeps custom headers across a redirect, so a bridge answering 3xx would
// otherwise hand the device secret and bearer to wherever it pointed.
export function headers(url: string) {
  requireReady(url);
  return identityHeaders(url);
}

export function bridgeUrl(host: Host) {
  return host.tailnetUrl?.replace(/\/$/, "") ?? "";
}

export async function fetchSnapshot(url: string) {
  const res = await fetch(`${url}/api/snapshot`, { headers: headers(url), redirect: "error" });
  if (!res.ok) throw await accessError(res, url, "snapshot");
  return (await res.json()) as Snapshot;
}

export async function fetchRepoRoot(url: string, cwd: string): Promise<string> {
  const res = await fetch(`${url}/api/repo-root?cwd=${encodeURIComponent(cwd)}`, { headers: headers(url), redirect: "error" });
  if (!res.ok) throw await accessError(res, url, "repo root");
  const value: unknown = await res.json();
  const root = value && typeof value === "object" ? (value as { root?: unknown }).root : null;
  // Client-boundary validation: only a non-empty string is a usable root.
  if (typeof root !== "string" || !root) throw new Error("invalid repo root");
  return root;
}

export async function postLogin(
  url: string,
  password: string,
): Promise<{ token: string; owner: string }> {
  const res = await fetch(`${url}/api/login`, {
    method: "POST",
    headers: identityHeaders(url),
    redirect: "error",
    body: JSON.stringify({ password }),
  });
  if (!res.ok) throw await accessError(res, url, "login");
  const login = await parsed(res, LoginSchema, "login");
  saveCredentials(url, { sessionToken: login.token, owner: login.owner });
  return login;
}

export async function fetchCommands(
  url: string,
  scope: CommandScope,
  signal?: AbortSignal,
): Promise<RemoteCatalog> {
  const res = await fetch(
    `${url}/api/commands?target=${encodeURIComponent(scope.target)}&sessionId=${encodeURIComponent(scope.sessionId)}`,
    { headers: headers(url), redirect: "error", cache: "no-store", signal },
  );
  if (!res.ok) throw await accessError(res, url, "commands", signal);
  return parseScopedCommandsResponse(await res.json(), scope);
}

export async function fetchAgentDetail(
  url: string,
  agentId: string,
  signal: AbortSignal,
): Promise<AgentDetail> {
  const res = await fetch(
    `${url}/api/agent-detail?target=${encodeURIComponent(agentId)}`,
    { signal, cache: "no-store", headers: headers(url), redirect: "error" },
  );
  if (!res.ok) throw await accessError(res, url, "agent detail");
  const value: unknown = await res.json();
  if (!value || typeof value !== "object")
    throw new Error("invalid agent detail");
  const detail = value as Partial<AgentDetail>;
  if (
    detail.agentId !== agentId ||
    typeof detail.output !== "string" ||
    typeof detail.revision !== "number" ||
    !detail.conversation ||
    (detail.conversation.kind !== "available" &&
      detail.conversation.kind !== "unavailable")
  ) {
    throw new Error("invalid agent detail");
  }
  return detail as AgentDetail;
}

export async function fetchVapid(url: string) {
  const res = await fetch(`${url}/api/vapid`, { headers: { "content-type": "application/json" } });
  if (!res.ok) throw new Error(`vapid ${res.status}`);
  return await parsed(res, VapidSchema, "vapid");
}

function urlBase64ToUint8Array(base64: string) {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** What the bridge says about its own push delivery, from public discovery. */
export async function fetchPushAvailability(url: string): Promise<PushAvailability> {
  const res = await fetch(`${url}/api/auth-info`, { cache: "no-store", signal: AbortSignal.timeout(BRIDGE_PROBE_MS) });
  if (!res.ok) throw await accessError(res, url, "auth info");
  return (await parsed(res, AuthInfoSchema, "auth info")).push ?? { available: true };
}

/**
 * Whether this browser can receive push and, when `bridge` is given, whether
 * that host can send it. A host with push turned off is reported with its
 * own reason rather than as a browser that failed to subscribe.
 */
export function inspectPushSupport(bridge?: PushAvailability):
  | Extract<PushSetup, { status: "unavailable" | "denied" | "off" }>
  | { status: "ready" } {
  if (typeof window === "undefined" || typeof Notification === "undefined")
    return { status: "unavailable", reason: "no-notification" };
  if (!("PushManager" in window))
    return { status: "unavailable", reason: "no-push-manager" };
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator))
    return { status: "unavailable", reason: "no-sw" };
  if (bridge && !bridge.available)
    return { status: "unavailable", reason: "bridge", message: bridge.reason ?? "This host has notifications turned off." };
  if (Notification.permission === "denied") return { status: "denied" };
  if (Notification.permission !== "granted") return { status: "off" };
  return { status: "ready" };
}

/** Drives a checkbox, so the exceptional states go in the note, not the value. */
export function pushControl(setup: PushSetup): {
  checked: boolean;
  disabled: boolean;
  note: string | null;
} {
  switch (setup.status) {
    case "on":
      return { checked: true, disabled: false, note: null };
    case "off":
      return { checked: false, disabled: false, note: null };
    case "pending":
      return { checked: true, disabled: true, note: "Turning on…" };
    case "denied":
      return {
        checked: false,
        disabled: true,
        note: "Denied. Allow notifications for moshpit in your browser settings.",
      };
    case "failed":
      return { checked: false, disabled: false, note: "Couldn’t turn on. Tap to retry." };
    case "local":
      return {
        checked: true,
        disabled: false,
        note: "This device only. Connect a host to get notified while moshpit is closed.",
      };
    case "unavailable":
      return {
        checked: false,
        disabled: true,
        note:
          setup.reason === "bridge"
            ? setup.message
            : setup.reason === "no-notification"
            ? "Add moshpit to your Home Screen, then open it from there. This tab can’t receive system notifications."
            : "This browser can’t receive system notifications here.",
      };
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(null);
      },
    );
  });
}

const registerInflight = new Map<string, Promise<PushSetup>>();

/** Coalesced per url, so two hosts never share one result. */
export function registerPush(url: string, privacy?: PushPrivacy): Promise<PushSetup> {
  try { requireReady(url); } catch (error) { return Promise.resolve({ status: "failed", message: (error as Error).message }); }
  const inflight = registerInflight.get(url);
  if (inflight) return inflight;
  // The entry is dropped in a chained finally, not a detached one, so it is
  // gone before any awaiting caller resumes and a retry cannot reuse it.
  const running = (async (): Promise<PushSetup> => {
    const browser = inspectPushSupport();
    if (browser.status !== "ready") return browser;
    let bridge: PushAvailability;
    try {
      bridge = await fetchPushAvailability(url);
    } catch (err) {
      return { status: "failed", message: err instanceof Error ? err.message : "push availability unknown" };
    }
    // A host that cannot send must not leave the switch looking on, and the
    // browser is not subscribed for nothing.
    const support = inspectPushSupport(bridge);
    if (support.status !== "ready") return support;
    const reg = await withTimeout(navigator.serviceWorker.ready, BRIDGE_PROBE_MS);
    if (!reg) return { status: "failed", message: "service worker not ready" };
    try {
      const { publicKey } = await fetchVapid(url);
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
      const subscription = sub.toJSON();
      if (!subscription.endpoint)
        return { status: "failed", message: "no subscription endpoint" };
      await updatePushSubscription(url, { action: "set", subscription, privacy });
      return { status: "on" };
    } catch (err) {
      return {
        status: "failed",
        message: err instanceof Error ? err.message : "register failed",
      };
    }
  })().finally(() => registerInflight.delete(url));
  registerInflight.set(url, running);
  void running.then((setup) => {
    if (setup.status === "failed") breadcrumb(`push register ${setup.message}`);
  });
  return running;
}

export async function unregisterPush(url: string): Promise<void> {
  // The bridge holds the endpoint that actually wakes the phone, so drop it
  // first. A local unsubscribe that then fails cannot revive delivery.
  await updatePushSubscription(url, { action: "clear" });
  if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
    const registration = await navigator.serviceWorker.getRegistration();
    const sub = await registration?.pushManager.getSubscription();
    await sub?.unsubscribe();
  }
}

export async function updatePushSubscription(url: string, push: PairPush) {
  const body: Record<string, unknown> = {};
  if (push.action === "set") {
    body.pushSubscription = push.subscription;
    if (push.privacy) body.pushPrivacy = push.privacy;
  }
  if (push.action === "privacy") body.pushPrivacy = push.privacy;
  if (push.action === "clear") body.clearPush = true;
  const res = await fetch(`${url}/api/push-subscription`, { method: "POST", headers: headers(url), redirect: "error", body: JSON.stringify(body) });
  if (!res.ok) throw await accessError(res, url, "push subscription");
}

export async function postAction(url: string, action: Action) {
  const res = await fetch(`${url}/api/action`, { method: "POST", headers: headers(url), redirect: "error", body: JSON.stringify(action) });
  if (!res.ok) throw await accessError(res, url, "action");
  return res;
}

export type BridgeDiagnosis = "up" | "not-bridge" | "unreachable" | "unknown";

// One probe splits the failure space: the door is down (network, machine,
// serve registration), the door is up but not a moshpit bridge, or the
// bridge is up and the failure is elsewhere (herdr, auth).
export async function diagnoseBridge(origin: string): Promise<BridgeDiagnosis> {
  try {
    const res = await fetch(`${origin}/api/auth-info`, {
      cache: "no-store",
      signal: AbortSignal.timeout(BRIDGE_PROBE_MS),
    });
    const isJson = (res.headers.get("content-type") ?? "").includes("application/json");
    if (res.ok && isJson) return "up";
    if (res.status === 404) return "not-bridge";
    return "unknown";
  } catch {
    return "unreachable";
  }
}

const ConnectListSchema = z.object({ connectOrigins: z.array(z.string()).max(256) });

/**
 * Why this page cannot reach `origin`, or null when it can or cannot tell.
 * A bridge that serves the app publishes the other bridges its CSP allows;
 * the browser blocks anything else before a request leaves, which would
 * otherwise surface as an unexplained network failure.
 */
export async function connectRefusal(origin: string): Promise<string | null> {
  if (origin === window.location.origin) return null;
  try {
    const res = await fetch("/api/auth-info", { cache: "no-store", signal: AbortSignal.timeout(4000) });
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("application/json")) return null;
    const listed = ConnectListSchema.safeParse(await res.json());
    // A bridge from before the list existed allows every https destination.
    if (!listed.success || listed.data.connectOrigins.includes(origin)) return null;
    return `This app, served from ${window.location.host}, may connect only to the bridges its host lists. Add ${origin} to MOSHPIT_CONNECT_ORIGINS on that host and restart its bridge, or open ${origin} in the browser directly.`;
  } catch {
    return null;
  }
}

export async function probeBridgeUrl(origin: string): Promise<boolean> {
  return (await diagnoseBridge(origin)) === "up";
}

// True when this page is served by the moshpit bridge itself (same origin).
// /api/auth-info is public discovery: JSON on 200,
// HTML 404 on static hosts.
export async function probeBridgeOrigin(): Promise<string | null> {
  try {
    const res = await fetch("/api/auth-info", { cache: "no-store", signal: AbortSignal.timeout(4000) });
    const isBridge =
      res.ok &&
      (res.headers.get("content-type") ?? "").includes("application/json");
    return isBridge ? window.location.origin : null;
  } catch {
    return null;
  }
}
