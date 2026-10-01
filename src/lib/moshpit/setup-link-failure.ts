import type { ConnectError } from "./types";

const AGAIN = "Run moshpit setup on the host for a new link.";
const TITLE = "Setup link not accepted";

/**
 * Why the host refused a setup link, by the code the bridge answered with. The
 * bridge names the reason only to a browser that holds an issued secret, so
 * none of this text needs to (or can) name the secret or the account.
 */
const REFUSED: Record<string, ConnectError> = {
  pairing_grant_expired: { title: TITLE, detail: `This setup link expired. Links last five minutes. ${AGAIN}` },
  pairing_grant_used: { title: TITLE, detail: `This setup link was already used. Each link works once. ${AGAIN}` },
  pairing_grant_wrong_owner: {
    title: TITLE,
    detail: "This setup link was made for a different Tailscale account than this browser is signed in as. Open it in a browser signed in as the account that owns the host.",
  },
  pairing_rate_limited: {
    title: TITLE,
    detail: "This browser tried too many times in a minute and the host stopped counting attempts for now. Wait a minute, then open the link again.",
  },
  pairing_grant_invalid: {
    title: TITLE,
    detail: `This setup link is not valid: it may be mistyped, cut short, or from before the host restarted. ${AGAIN}`,
  },
};

const UNREACHABLE: ConnectError = {
  title: "Could not reach the host",
  detail: "This browser could not reach the host, so the setup link was not used and is still valid until it expires. Check that this device is on the tailnet, then open the link again.",
};

const UNKNOWN: ConnectError = { title: TITLE, detail: `The host did not accept this setup link. ${AGAIN}` };

/** The failure to show for whatever `consumePairing` rejected with. A network failure has no code or status. */
export function setupLinkFailure(error: unknown): ConnectError {
  const { code, status } = (error ?? {}) as { code?: unknown; status?: unknown };
  if (typeof code === "string" && Object.hasOwn(REFUSED, code)) return REFUSED[code];
  if (typeof status !== "number") return UNREACHABLE;
  return UNKNOWN;
}
