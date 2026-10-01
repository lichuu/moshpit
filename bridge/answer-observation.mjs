import { randomUUID as systemRandomUUID } from "node:crypto";
import { inspectAnswerDialog } from "./prompt.mjs";

/**
 * Process-local observation cache for blocked dialogs, for herdr to use.
 *
 * herdr polls panes and hands each dump to `inspectAnswerDialog`; the cache
 * mints one UUID per distinct Codex card so the UI can gate a "consumed"
 * answer button per step. A terminal dump keeps a *consumed* entry, so a
 * card still on screen while the agent works through the answer does not
 * re-mint its token and re-offer an answered question. An unconsumed one is
 * dropped instead: the token outlives the card that earned it, and the pane
 * has moved on to something we cannot read, so spending it would put a digit
 * into whatever dialog is there now.
 *
 * Tokens are process-local and intentionally lost on restart. `forget` drops
 * the panes a snapshot no longer sees, so a long-lived bridge does not retain
 * a row per pane that ever asked a question.
 */
export function createAnswerObservations({ randomUUID = systemRandomUUID, now = () => Date.now() } = {}) {
  const targets = new Map();

  function copyOf(entry) {
    return entry ? structuredClone(entry) : null;
  }

  function revisionPart(revision) {
    return Number.isSafeInteger(revision) && revision > 0 ? revision : null;
  }

  function observe({ target, sessionId, harness, revision, dump } = {}) {
    if (!target) throw new TypeError("observe: `target` is required");
    const inspected = inspectAnswerDialog(harness, dump);
    let entry = targets.get(target);
    if (inspected.kind === "choose") {
      const key = [sessionId, inspected.family, inspected.signature, revisionPart(revision)].join("\u0000");
      if (!entry || entry.key !== key) {
        entry = {
          kind: "choose",
          key,
          token: randomUUID(),
          consumed: false,
          issuedAt: now(),
          sessionId,
          revision: revisionPart(revision),
          family: inspected.family,
          question: inspected.question,
          step: inspected.step,
          options: inspected.options,
          signature: inspected.signature,
        };
        targets.set(target, entry);
      }
    } else if (entry && !entry.consumed) {
      targets.delete(target);
      entry = null;
    }
    return copyOf(entry);
  }

  function consume(target, token, optionKey) {
    const entry = targets.get(target);
    if (!entry || entry.token !== token || entry.consumed) return null;
    if (optionKey !== undefined && !entry.options.some((o) => o.key === optionKey)) return null;
    entry.consumed = true;
    return copyOf(entry);
  }

  function peek(target) {
    return copyOf(targets.get(target));
  }

  function forget(live) {
    const keep = live instanceof Set ? live : new Set(live ?? []);
    for (const target of targets.keys()) if (!keep.has(target)) targets.delete(target);
  }

  function reset() {
    targets.clear();
  }

  return { observe, consume, peek, forget, reset };
}
