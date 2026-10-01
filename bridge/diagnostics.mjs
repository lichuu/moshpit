// The client black box posts what it saw just before a phone tab died. Only
// the fields it actually sends are kept, each bounded, so client.log never
// becomes a place to park prompts, terminal output or credentials.

export const MAX_DIAGNOSTIC_BYTES = 16 * 1024;
export const DIAGNOSTICS_PER_MINUTE = 60;
const WINDOW_MS = 60_000;

const KINDS = new Set(["start", "beat", "hidden", "pagehide", "error", "rejection"]);
const TEXT = { message: 400, source: 300, stack: 900 };
const NUMBERS = ["nodes", "w", "h"];
const TRAIL = 25;
const CRUMB = 200;

export class DiagnosticError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const invalid = (what) => new DiagnosticError(400, "diagnostic_invalid", `The diagnostic entry has ${what}.`);
const finite = (value) => typeof value === "number" && Number.isFinite(value);

/** A sanitized copy of `entry`, or a diagnostic_invalid error naming the field. */
export function parseDiagnostic(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw invalid("no object body");
  const record = {};
  for (const [key, value] of Object.entries(entry)) {
    if (key === "kind") {
      if (!KINDS.has(value)) throw invalid("an unknown kind");
      record.kind = value;
    } else if (Object.hasOwn(TEXT, key)) {
      if (typeof value !== "string") throw invalid(`a non-text ${key}`);
      record[key] = value.slice(0, TEXT[key]);
    } else if (NUMBERS.includes(key)) {
      if (!finite(value)) throw invalid(`a non-numeric ${key}`);
      record[key] = value;
    } else if (key === "heapMB") {
      if (value !== null && !finite(value)) throw invalid("a non-numeric heapMB");
      record.heapMB = value;
    } else if (key === "trail") {
      if (!Array.isArray(value) || value.length > TRAIL) throw invalid("an unusable trail");
      record.trail = value.map((crumb) => {
        if (!crumb || typeof crumb !== "object" || !finite(crumb.t) || typeof crumb.what !== "string" || Object.keys(crumb).length !== 2)
          throw invalid("an unusable trail entry");
        return { t: crumb.t, what: crumb.what.slice(0, CRUMB) };
      });
    } else {
      throw invalid("an unexpected field");
    }
  }
  if (!record.kind) throw invalid("no kind");
  return record;
}

/** A rolling one-minute allowance per device. `take` throws once it is spent. */
export function createDiagnosticLimiter({ limit = DIAGNOSTICS_PER_MINUTE, now = Date.now } = {}) {
  const recent = new Map();
  return {
    take(deviceId) {
      const time = now();
      const kept = (recent.get(deviceId) ?? []).filter((at) => time - at < WINDOW_MS);
      if (kept.length >= limit) {
        recent.set(deviceId, kept);
        const error = new DiagnosticError(429, "diagnostic_rate_limited", "Too many diagnostic entries; try again in a minute.");
        error.retryAfter = Math.max(1, Math.ceil((kept[0] + WINDOW_MS - time) / 1000));
        throw error;
      }
      kept.push(time);
      recent.set(deviceId, kept);
    },
    forget(deviceId) {
      recent.delete(deviceId);
    },
  };
}
