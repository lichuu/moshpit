import { accessError } from "./access";
import { useEffect, useRef, useState } from "react";
import { headers } from "./bridge";
import { ReceiptSchema, SessionResponseSchema } from "./session-protocol";
import type { Question, Receipt, SessionCapabilities, SessionEntry, SessionResponse, Submission } from "./session-protocol";

type AvailableSession = Extract<SessionResponse, { kind: "available" }>;
type CachedSession = { value: SessionResponse; error: string | null; epoch: number };
const cache = new Map<string, CachedSession>();

function commit(key: string, value: SessionResponse, older: boolean): CachedSession {
  const previous = cache.get(key);
  const reset = value.kind !== "available" || previous?.value.kind !== "available" || value.reset || value.sessionId !== previous.value.sessionId;
  const next = { value: mergeSession(previous?.value, value, older), error: null, epoch: (previous?.epoch ?? 0) + Number(reset) };
  cache.set(key, next);
  return next;
}

const same = (a: string | undefined, b: string | undefined) => a === b;
const sameList = <T,>(a: readonly T[] | undefined, b: readonly T[] | undefined, equal: (x: T, y: T) => boolean) =>
  a === b || (a !== undefined && b !== undefined && a.length === b.length && a.every((x, i) => equal(x, b[i])));
const sameQuestion = (a: Question, b: Question) =>
  same(a.id, b.id) && same(a.header, b.header) && a.text === b.text && a.multi === b.multi &&
  sameList(a.options, b.options, (x, y) => x.label === y.label && same(x.description, y.description)) &&
  sameList(a.answers, b.answers, (x, y) => x === y);

// The entry schema is finite, so it is compared field by field rather than by
// display text: a resolved flag or a picked answer changes no text.
export function sameEntry(a: SessionEntry, b: SessionEntry): boolean {
  if (a.id !== b.id || a.turnId !== b.turnId || !same(a.at, b.at)) return false;
  switch (a.kind) {
    case "message": return b.kind === "message" && a.role === b.role && a.text === b.text;
    case "status": return b.kind === "status" && a.text === b.text;
    case "activity":
      return b.kind === "activity" && a.title === b.title && a.input === b.input && a.output === b.output && a.status === b.status && same(a.diff, b.diff);
    case "question":
      return b.kind === "question" && a.title === b.title && a.resolved === b.resolved && same(a.answer, b.answer) && sameList(a.questions, b.questions, sameQuestion);
  }
}

const sameCapabilities = (a: SessionCapabilities, b: SessionCapabilities) =>
  a.stop === b.stop && a.fit === b.fit && sameList(a.inputModes, b.inputModes, (x, y) => x === y);

export function mergeSession(previous: SessionResponse | undefined, next: SessionResponse, older = false): SessionResponse {
  if (next.kind !== "available" || previous?.kind !== "available" || previous.sessionId !== next.sessionId || next.reset) return next;
  // A poll that repeats entries the reader already has, content unchanged,
  // keeps each entry object and the list itself, so nothing downstream reads
  // it as new activity. Only the delta is compared, against entries by ID.
  const byId = new Map(previous.entries.map((entry) => [entry.id, entry]));
  const merged = new Map<string, SessionEntry>();
  const incoming = next.entries.map((entry) => {
    const held = byId.get(entry.id);
    return held && sameEntry(held, entry) ? held : entry;
  });
  for (const entry of older ? [...incoming, ...previous.entries] : [...previous.entries, ...incoming]) merged.set(entry.id, entry);
  const values = [...merged.values()];
  const entries = sameList(values, previous.entries, (x, y) => x === y) ? previous.entries : values;
  const cursor = older ? previous.cursor : next.cursor;
  const before = older ? next.before : previous.before;
  // Cursor, history bound or capabilities can move without any entry changing,
  // and the next poll must see them, so only a response equal in all of them
  // keeps the previous object.
  if (entries === previous.entries && cursor === previous.cursor && before === previous.before && sameCapabilities(previous.capabilities, next.capabilities)) return previous;
  return { ...next, entries, cursor, before, capabilities: sameCapabilities(previous.capabilities, next.capabilities) ? previous.capabilities : next.capabilities };
}

export function useSession(url: string, agentId: string, demo?: AvailableSession) {
  const key = JSON.stringify([url, agentId]);
  const [state, setState] = useState<{ key: string; value?: SessionResponse; error: string | null }>(() => ({ key, ...cache.get(key), error: cache.get(key)?.error ?? null }));
  const [loadingOlder, setLoadingOlder] = useState(false);
  const lifecycle = useRef<AbortController | null>(null);
  const current = state.key === key ? state : cache.get(key);

  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    lifecycle.current = controller;
    setLoadingOlder(false);
    let timer: ReturnType<typeof setTimeout>;
    let busy = false;
    async function refresh() {
      if (busy || document.hidden || controller.signal.aborted) return;
      busy = true;
      try {
        const cached = cache.get(key);
        const epoch = cached?.epoch;
        const previous = cached?.value;
        const after = previous?.kind === "available" ? previous.cursor : undefined;
        const value = await readSession(url, agentId, { after }, controller.signal);
        if (controller.signal.aborted || cache.get(key)?.epoch !== epoch) return;
        const next = commit(key, value, false);
        // An unchanged poll must not re-render, but it still has to clear a
        // banner left by an earlier failure, so identity is kept only when
        // there is no error to retract.
        setState((held) => (held.key === key && held.value === next.value && held.error === null ? held : { key, ...next }));
      } catch (error) {
        if (!controller.signal.aborted) setState({ key, value: cache.get(key)?.value, error: error instanceof Error ? error.message : "Connection interrupted" });
      } finally {
        busy = false;
        if (!controller.signal.aborted && !document.hidden) timer = setTimeout(() => void refresh(), 500);
      }
    }
    function visible() { clearTimeout(timer); void refresh(); }
    document.addEventListener("visibilitychange", visible);
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); document.removeEventListener("visibilitychange", visible); };
  }, [url, agentId, key]);

  async function loadOlder() {
    const cached = cache.get(key);
    const previous = cached?.value;
    const epoch = cached?.epoch;
    const controller = lifecycle.current;
    if (!url || loadingOlder || !controller || controller.signal.aborted || previous?.kind !== "available" || !previous.before) return;
    setLoadingOlder(true);
    try {
      const value = await readSession(url, agentId, { before: previous.before }, controller.signal);
      if (controller.signal.aborted || cache.get(key)?.epoch !== epoch) return;
      const next = commit(key, value, true);
      setState({ key, ...next });
    } catch (error) {
      if (!controller.signal.aborted && cache.get(key)?.epoch === epoch)
        setState({ key, value: cache.get(key)?.value, error: error instanceof Error ? error.message : "Could not load history" });
    } finally { if (!controller.signal.aborted) setLoadingOlder(false); }
  }
  // `epoch` counts stream resets, so a reader can drop state for entries gone.
  return { value: url ? current?.value : demo, error: current?.error, epoch: current && "epoch" in current ? current.epoch : 0, loadOlder, loadingOlder };
}

async function readSession(url: string, target: string, cursor: { before?: string; after?: string }, signal?: AbortSignal) {
  const query = new URLSearchParams({ target });
  if (cursor.before) query.set("before", cursor.before);
  if (cursor.after) query.set("after", cursor.after);
  const response = await fetch(`${url}/api/session?${query}`, { headers: headers(url), redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000), cache: "no-store" });
  if (!response.ok) throw await accessError(response, url, "session");
  return SessionResponseSchema.parse(await response.json());
}

export async function submitSession(url: string, request: Submission): Promise<Receipt> {
  try {
    const response = await fetch(`${url}/api/submit`, { method: "POST", headers: headers(url), redirect: "error", body: JSON.stringify(request), signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw await accessError(response, url, "submission");
    const value: unknown = await response.json();
    const receipt = ReceiptSchema.safeParse(value);
    if (receipt.success) return receipt.data;
    return { id: request.id, state: response.ok ? "unknown" : "failed", message: `Submission ${response.status}. Your draft is saved.` };
  } catch (error) {
    if (error instanceof Error && "status" in error)
      return { id: request.id, state: "failed", message: error.message };
    return { id: request.id, state: "unknown", message: "Delivery could not be confirmed. Check the session before sending again." };
  }
}
