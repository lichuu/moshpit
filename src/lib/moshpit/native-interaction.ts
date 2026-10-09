import { useSyncExternalStore } from "react";
import { useMoshpitStore } from "@/lib/moshpit/store";

/**
 * One native interaction per pane: the agent's live pane shown inside Chat,
 * for the menus and prompts a command opens. The record is transient. It
 * names what the panel is attached to and never owns a sender or a draft.
 */
export type NativeInteraction = {
  /** The session the panel was attached to; undefined until herdr reports one. */
  nativeSessionId?: string;
  visible: boolean;
  /** Counts attachments, so a reattach mounts a fresh surface with a new ticket. */
  attachment: number;
  /** The submission that last went out with the panel open. */
  initiatingRequestId?: string;
};

const records = new Map<string, NativeInteraction>();
const listeners = new Set<() => void>();

const parse = (key: string) => JSON.parse(key) as [hostId: string, paneId: string];

export const interactionKey = (hostId: string, paneId: string) => JSON.stringify([hostId, paneId]);

function set(key: string, next: NativeInteraction | undefined) {
  if (next) records.set(key, next);
  else records.delete(key);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useNativeInteraction(key: string | undefined) {
  return useSyncExternalStore(subscribe, () => (key ? records.get(key) : undefined), () => undefined);
}

/** Opens the panel, or reattaches it to the session the pane runs now. */
export function attachInteraction(key: string, nativeSessionId: string | undefined) {
  const previous = records.get(key);
  set(key, { nativeSessionId, visible: true, attachment: (previous?.attachment ?? 0) + 1, initiatingRequestId: previous?.initiatingRequestId });
}

/** Hides the panel and keeps what it was attached to. Sends nothing. */
export function hideInteraction(key: string) {
  const record = records.get(key);
  if (record?.visible) set(key, { ...record, visible: false });
}

export function showInteraction(key: string) {
  const record = records.get(key);
  if (record && !record.visible) set(key, { ...record, visible: true, attachment: record.attachment + 1 });
}

export function noteInteractionDelivery(key: string, requestId: string) {
  const record = records.get(key);
  if (record) set(key, { ...record, initiatingRequestId: requestId });
}

/**
 * True when the pane now runs a different session from the one the panel was
 * attached to. A stale panel shows no pane and sends nothing until the user
 * reattaches it.
 */
export function interactionStale(record: NativeInteraction, nativeSessionId: string | undefined) {
  return record.nativeSessionId !== undefined && record.nativeSessionId !== nativeSessionId;
}

// Below this the transcript and the pane cannot both be read, so the pane
// takes the transcript's place while it is open.
const SPLIT_QUERY = "(min-height: 1000px)";

function subscribeSplit(listener: () => void) {
  const query = window.matchMedia(SPLIT_QUERY);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}

/** True when the screen is tall enough to show the transcript above the pane. */
export function useRoomForTranscript() {
  return useSyncExternalStore(subscribeSplit, () => window.matchMedia(SPLIT_QUERY).matches, () => false);
}

// Each snapshot settles the records for the connected host: a pane that is
// gone takes its interaction with it, and a session herdr had not reported at
// attach time is recorded once it is known.
useMoshpitStore.subscribe((state, previous) => {
  if (!records.size || state.agents === previous.agents || !state.connectedHostId || !state.herdrRunning) return;
  for (const [key, record] of records) {
    const [hostId, paneId] = parse(key);
    if (hostId !== state.connectedHostId) continue;
    const agent = state.agents.find((candidate) => candidate.id === paneId);
    if (!agent) set(key, undefined);
    else if (record.nativeSessionId === undefined && agent.sessionId) set(key, { ...record, nativeSessionId: agent.sessionId });
  }
});
