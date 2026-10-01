import QRCode from "qrcode";

// Versioned host share code: a display name plus the externally reachable
// bridge origin, and nothing else. No device tokens, credentials, or keys —
// a code grants no access by itself; scanning only prefills the Add host
// form, whose existing validation, probe, and explicit confirmation are the
// real gate (Tailscale and device pairing unchanged).
export const HOST_CODE_TYPE = "moshpit-host";
export const HOST_CODE_VERSION = 1;

export type HostCode = { name: string; url: string };

function assertBridgeOrigin(input: string): URL {
  const url = new URL(input);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("Host codes only carry the bridge's base address.");
  return url;
}

/**
 * The origin of a saved host's bridge URL, or null when it is not a URL.
 *
 * Hosts are rehydrated from local storage and nothing validates tailnetUrl on
 * the way in, so a value written by an older build — or edited by hand — can
 * be any string. Throwing here took out whichever caller was running: the
 * duplicate check runs inside a scan or a paste, so one bad saved host broke
 * both entry paths.
 */
export function hostOrigin(raw: string | undefined | null): string | null {
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

export function makeHostCode(input: { name: string; url: string }): string {
  const name = input.name.trim();
  if (name.length > 100) throw new Error("Host name is too long for a code.");
  const url = assertBridgeOrigin(input.url);
  return JSON.stringify({
    type: HOST_CODE_TYPE,
    version: HOST_CODE_VERSION,
    name,
    url: url.origin,
  });
}

export function parseHostCode(raw: string): HostCode {
  if (raw.length > 4096) throw new Error("Host code is too large.");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("That is not a moshpit host code.");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("type" in value) ||
    value.type !== HOST_CODE_TYPE ||
    !("version" in value) ||
    value.version !== HOST_CODE_VERSION ||
    !("name" in value) ||
    typeof value.name !== "string" ||
    value.name.length > 100 ||
    !("url" in value) ||
    typeof value.url !== "string"
  ) {
    throw new Error("Unsupported host code.");
  }
  const url = assertBridgeOrigin(value.url);
  return { name: (value.name as string).trim(), url: url.origin };
}

export async function hostCodeQrDataUrl(text: string): Promise<string> {
  return QRCode.toDataURL(text, { margin: 2 });
}
