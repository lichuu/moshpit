import { useSyncExternalStore } from "react";
import type { Agent } from "./types";

// C8: an optional sound while the app is open and looking at the host. Two
// short synthesised tones, no files. Browsers only start audio from a user
// gesture, so the context is created or resumed in the click that turns the
// setting on (and in the first tap after each page load); a cue that finds it
// not running is dropped, never held back to play late.

export type CueKind = "blocked" | "finished";

/** Open blocked rows, by agent: a block with one is already known to the Inbox. */
export function openBlockedIds(events: { agentId: string; kind: string; resolved?: unknown }[]) {
  return new Set(
    events.filter((e) => e.kind === "blocked" && !e.resolved).map((e) => e.agentId),
  );
}

/**
 * The cue a snapshot earns. `prior` is the agents from the last snapshot of
 * this host, or null when this one is the first (connect, reconnect), which is
 * never a transition. A block is new when the agent was not blocked and has no
 * open Inbox row, so it agrees with the row `applySnapshot` opens for it; a
 * finish is working to idle or done, the rule the live poll writes its "turn"
 * rows by. Blocked outranks finished, and several of either are one cue.
 */
export function cueTransition(
  prior: Pick<Agent, "id" | "status">[] | null,
  agents: Pick<Agent, "id" | "status">[],
  openBlocked: Set<string>,
  onScreen: (agentId: string) => boolean,
): CueKind | null {
  if (!prior) return null;
  const was = new Map(prior.map((a) => [a.id, a.status]));
  const blocked = agents.some(
    (a) => a.status === "blocked" && was.get(a.id) !== "blocked" && !openBlocked.has(a.id),
  );
  if (blocked) return "blocked";
  const finished = agents.some(
    (a) =>
      was.get(a.id) === "working" &&
      (a.status === "idle" || a.status === "done") &&
      !onScreen(a.id),
  );
  return finished ? "finished" : null;
}

/** At most one cue in this long, however many snapshots earn one. */
export const CUE_GAP_MS = 1000;

type Tone = { hz: number; at: number; length: number; peak: number };

// Under 300 ms each. Blocked is a soft rising pair; finished is one lower,
// quieter note.
const TONES: Record<CueKind, Tone[]> = {
  blocked: [
    { hz: 660, at: 0, length: 0.12, peak: 0.1 },
    { hz: 880, at: 0.12, length: 0.14, peak: 0.1 },
  ],
  finished: [{ hz: 523, at: 0, length: 0.16, peak: 0.04 }],
};

type Context = Pick<
  AudioContext,
  "state" | "currentTime" | "destination" | "resume" | "createOscillator" | "createGain" | "addEventListener"
>;

export type AudioStatus = "waiting" | "ready" | "unsupported";

let context: Context | null = null;
let unsupported = false;
let lastCueAt = 0;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function status(): AudioStatus {
  if (unsupported) return "unsupported";
  return context?.state === "running" ? "ready" : "waiting";
}

/** The audio state for the Settings note: waiting for a tap, ready, or unavailable. */
export function useAudioStatus(): AudioStatus {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    status,
    () => "waiting",
  );
}

/**
 * Creates the context if there is none and asks it to run. Call from a user
 * gesture. Resolves true when the context is running; never rejects.
 */
export async function armAudio(): Promise<boolean> {
  try {
    if (!context) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) {
        unsupported = true;
        notify();
        return false;
      }
      context = new Ctor();
      context.addEventListener("statechange", notify);
      notify();
    }
    if (context.state !== "running") await context.resume();
  } catch {
    // A context that cannot start leaves the setting on and waiting for a tap.
  }
  notify();
  return context?.state === "running";
}

function sound(kind: CueKind) {
  const ctx = context;
  if (!ctx || ctx.state !== "running") return false;
  try {
    const start = ctx.currentTime + 0.01;
    for (const tone of TONES[kind]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = tone.hz;
      const from = start + tone.at;
      // A short fade in and a long fade out, or the tone clicks.
      gain.gain.setValueAtTime(0.0001, from);
      gain.gain.exponentialRampToValueAtTime(tone.peak, from + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, from + tone.length);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(from);
      osc.stop(from + tone.length + 0.02);
    }
    return true;
  } catch {
    return false;
  }
}

/** The Test sound button: arms the context in its click, then plays the blocked cue. */
export async function playTestCue() {
  if (await armAudio()) sound("blocked");
}

/**
 * Plays a cue if the setting is on, the page is visible, the last cue was over
 * a second ago and the context is running. Anything else drops it silently.
 */
export function playCue(kind: CueKind, enabled: boolean) {
  if (!enabled || document.visibilityState !== "visible") return;
  const now = Date.now();
  if (now - lastCueAt < CUE_GAP_MS) return;
  if (sound(kind)) lastCueAt = now;
}
