import type { AgentEvent } from "./types";

/**
 * Event ids over plain-HTTP tailnet URLs: `crypto.randomUUID` only exists in
 * secure contexts, so fall back to random bytes (getRandomValues works anywhere).
 */
export function newId(): string {
  const c = globalThis.crypto as (typeof crypto) | undefined;
  if (c?.randomUUID) return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  const h = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function inboxUnread(events: AgentEvent[]) {
  return events.filter((e) => e.kind === "blocked" && !e.resolved).length;
}

// Events persist, so ids must survive a reload; a session counter would
// reuse the ids of persisted events and collide on the Inbox keys.
export function makeEvent(
  agentId: string,
  kind: AgentEvent["kind"],
  text: string,
): AgentEvent {
  return {
    id: newId(),
    agentId,
    kind,
    text,
    at: Date.now(),
  };
}
