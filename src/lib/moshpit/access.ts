import type { HostAccess } from "./types";

type Credential = { deviceId?: string; deviceSecret?: string; sessionToken?: string; owner?: string; deviceExpiresAt?: number | null };
const states = new Map<string, HostAccess>();
const listeners = new Set<(origin: string, access: HostAccess) => void>();
export function credentials(url: string): Credential {
  try {
    const value = JSON.parse(localStorage.getItem(new URL(url).origin) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return {
      deviceId: typeof value.deviceId === "string" ? value.deviceId : undefined,
      deviceSecret: typeof value.deviceSecret === "string" ? value.deviceSecret : undefined,
      sessionToken: typeof value.sessionToken === "string" ? value.sessionToken : undefined,
      owner: typeof value.owner === "string" ? value.owner : undefined,
      // A stored null is a device the host chose not to expire; either way
      // there is no moment to compare against.
      deviceExpiresAt: typeof value.deviceExpiresAt === "number" ? value.deviceExpiresAt : undefined,
    };
  } catch { return {}; }
}
export function saveCredentials(url: string, patch: Credential) {
  localStorage.setItem(new URL(url).origin, JSON.stringify({ ...credentials(url), ...patch }));
}
export function hostAccess(url: string): HostAccess {
  return states.get(new URL(url).origin) ?? { status: "disconnected" };
}
export function setHostAccess(url: string, access: HostAccess) {
  const origin = new URL(url).origin;
  states.set(origin, access);
  listeners.forEach((listener) => listener(origin, access));
  return access;
}
export function watchAccess(listener: (origin: string, access: HostAccess) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function requireReady(url: string) {
  if (hostAccess(url).status !== "ready") throw new Error("Connect and pair this host before continuing.");
}
export function identityHeaders(url: string) {
  const c = credentials(url);
  const h: Record<string, string> = { "content-type": "application/json" };
  if (c.sessionToken) h.authorization = `Bearer ${c.sessionToken}`;
  if (c.deviceId && c.deviceSecret) h["x-moshpit-device"] = `${c.deviceId}.${c.deviceSecret}`;
  return h;
}
export async function accessError(res: Response, url: string, name: string, signal?: AbortSignal) {
  const body = await res.json().catch(() => null);
  signal?.throwIfAborted();
  const code = body?.error?.code;
  if (res.status === 401 && (code === "identity_required" || code === "password_required")) {
    saveCredentials(url, { sessionToken: undefined });
    setHostAccess(url, { status: "login-required" });
  } else if (code === "device_required" && res.status === 403) {
    setHostAccess(url, { status: "pairing-required", reason: "new" });
  } else if (code === "device_revoked" || code === "device_expired") {
    saveCredentials(url, { deviceId: undefined, deviceSecret: undefined, deviceExpiresAt: undefined });
    setHostAccess(url, { status: "pairing-required", reason: code === "device_revoked" ? "revoked" : "expired" });
  }
  return Object.assign(new Error(body?.error?.message ?? `${name} ${res.status}`), { status: res.status, code });
}
