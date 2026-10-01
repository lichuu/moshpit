import { z } from "zod";
import { accessError, identityHeaders, requireReady, saveCredentials } from "./access";

// Access requests: a browser with identity but no device asks, an approved
// device (or `moshpit devices approve` on the host) decides, and the asking
// browser redeems once. The request secret travels only in the bodies of
// status and redeem, never in a URL or header.

const CreatedSchema = z.object({ id: z.string().min(1), secret: z.string().min(1), phrase: z.string(), expiresAt: z.number() });
const StatusSchema = z.object({
  id: z.string(),
  name: z.string(),
  phrase: z.string(),
  status: z.enum(["pending", "approved", "rejected", "consumed", "expired"]),
  expiresAt: z.number(),
});
const PendingSchema = z.array(
  z.object({ id: z.string(), name: z.string(), phrase: z.string(), createdAt: z.number(), ageMs: z.number(), expiresAt: z.number() }),
);
const PairedSchema = z.object({ deviceId: z.string().min(1), deviceSecret: z.string().min(1), expiresAt: z.number().nullable() });

export type HeldRequest = z.infer<typeof CreatedSchema> & { name: string };
export type RequestStatus = z.infer<typeof StatusSchema>["status"];
export type PendingRequest = z.infer<typeof PendingSchema>[number];

async function parsed<T>(res: Response, schema: z.ZodType<T>, what: string): Promise<T> {
  const result = schema.safeParse(await res.json().catch(() => null));
  if (!result.success) throw new Error(`The bridge returned an unusable ${what} response.`);
  return result.data;
}

const post = (url: string, route: string, body: unknown, headers = identityHeaders(url)) =>
  fetch(`${url}${route}`, { method: "POST", headers, redirect: "error", cache: "no-store", body: JSON.stringify(body) });

// Session storage so a same-tab reload resumes; another tab or an installed
// PWA starts its own request.
const storageKey = (url: string) => `moshpit-enrollment:${new URL(url).origin}`;

export function heldRequest(url: string): HeldRequest | null {
  try {
    const held = CreatedSchema.extend({ name: z.string() }).safeParse(JSON.parse(sessionStorage.getItem(storageKey(url)) ?? "null"));
    return held.success ? held.data : null;
  } catch {
    return null;
  }
}

export function forgetRequest(url: string) {
  try {
    sessionStorage.removeItem(storageKey(url));
  } catch {
    /* nothing held */
  }
}

export async function requestAccess(url: string, name: string): Promise<HeldRequest> {
  const res = await post(url, "/api/enrollment/request", { name });
  if (!res.ok) throw await accessError(res, url, "access request");
  const held = { ...(await parsed(res, CreatedSchema, "access request")), name };
  try {
    sessionStorage.setItem(storageKey(url), JSON.stringify(held));
  } catch {
    /* the request still works in this page, it just cannot resume */
  }
  return held;
}

/** The request's status, or "unknown" once the bridge no longer holds it. */
export async function requestStatus(url: string, held: HeldRequest): Promise<RequestStatus | "unknown" | "busy"> {
  const res = await post(url, "/api/enrollment/status", { id: held.id, secret: held.secret });
  if (res.status === 404) return "unknown";
  if (res.status === 429) return "busy";
  if (!res.ok) throw await accessError(res, url, "access request status");
  return (await parsed(res, StatusSchema, "access request status")).status;
}

/** Redeems once and stores the credential. The caller validates it before connecting. */
export async function redeemRequest(url: string, held: HeldRequest) {
  const res = await post(url, "/api/enrollment/redeem", { id: held.id, secret: held.secret });
  if (!res.ok) throw await accessError(res, url, "access redemption");
  const paired = await parsed(res, PairedSchema, "access redemption");
  forgetRequest(url);
  saveCredentials(url, { deviceId: paired.deviceId, deviceSecret: paired.deviceSecret, deviceExpiresAt: paired.expiresAt });
}

/** A protected read with the new credential, before the app connects with it. */
export async function validateCredential(url: string) {
  const res = await fetch(`${url}/api/devices`, { cache: "no-store", headers: identityHeaders(url), redirect: "error" });
  if (!res.ok) throw await accessError(res, url, "devices");
}

export async function listAccessRequests(url: string, signal?: AbortSignal) {
  requireReady(url);
  const res = await fetch(`${url}/api/enrollment/requests`, { cache: "no-store", headers: identityHeaders(url), redirect: "error", signal });
  if (!res.ok) throw await accessError(res, url, "access requests", signal);
  return await parsed(res, PendingSchema, "access requests");
}

export async function decideAccessRequest(url: string, id: string, decision: "approve" | "reject") {
  requireReady(url);
  const res = await post(url, "/api/enrollment/decision", { id, decision });
  if (!res.ok) throw await accessError(res, url, "access decision");
  return await parsed(res, StatusSchema, "access decision");
}
