// The one shape every `--json` command prints, on stdout, as a single line:
//
//   { schemaVersion: 1, command, ok, exitCode, result?, error? }
//
// `ok` is exactly `exitCode === 0`. `result` is the command's own object and
// may accompany an error (a failed setup still lists its steps). `error` is
// `{ code, message }` and is present exactly when `ok` is false. A change that
// removes or renames a field bumps `schemaVersion`; adding a field does not.

export const JSON_SCHEMA_VERSION = 1;

/** The envelope for one finished command. Pass `error` only for a nonzero `exitCode`. */
export function envelope(command, { exitCode, result, error }) {
  const ok = exitCode === 0;
  if (ok === Boolean(error)) throw new TypeError(`${command}: an envelope carries an error exactly when it failed`);
  return { schemaVersion: JSON_SCHEMA_VERSION, command, ok, exitCode, ...(result === undefined ? {} : { result }), ...(error ? { error } : {}) };
}

/** Writes the envelope as one newline-terminated line. */
export function writeEnvelope(io, command, parts) {
  io.stdout.write(`${JSON.stringify(envelope(command, parts))}\n`);
}

/**
 * The error for a step-walk outcome (setup, status, update, rollback,
 * uninstall): the first failed or blocked step names it, and a run that
 * stopped without one says what state it stopped in.
 */
export function stepError(result) {
  const stuck = result.steps.find((entry) => entry.status === "failed" || entry.status === "blocked");
  if (stuck) return { code: stuck.id, message: stuck.detail };
  return { code: "incomplete", message: result.next ?? `Stopped at: ${result.state}.` };
}

/** Envelope parts for `{ result, exitCode }` from a step walk. */
export function stepParts({ result, exitCode }) {
  const { ok: _ok, ...rest } = result;
  return { exitCode, result: rest, ...(exitCode === 0 ? {} : { error: stepError(result) }) };
}

/** Undoes the envelope for a release's `version --json`, which an older release printed bare. */
export function unwrapVersion(parsed) {
  return parsed?.schemaVersion === JSON_SCHEMA_VERSION && parsed.command === "version" ? parsed.result : parsed;
}
