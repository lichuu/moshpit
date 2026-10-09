import { useSyncExternalStore } from "react";
import { bridgeUrl } from "./bridge";
import { useMoshpitStore } from "./store";
import type { ContextUsage, RateWindow } from "./session-protocol";

export type ContextLevel = "ok" | "warn" | "high" | "unknown";

/** Amber from 75% of the window, red from 90%. Without a capacity there is no level to speak of. */
export const WARN_AT = 0.75;
export const HIGH_AT = 0.9;

/** Harnesses whose session files carry usage; the composer reserves the meter's line for them. */
const MEASURED_KINDS = new Set(["codex", "claude", "claude-code", "pi"]);
export const hasContextMeter = (kind: string) => MEASURED_KINDS.has(kind);

export function contextRatio(context: ContextUsage): number | undefined {
  return context.capacity ? context.used / context.capacity : undefined;
}

export function contextLevel(context: ContextUsage): ContextLevel {
  const ratio = contextRatio(context);
  if (ratio === undefined) return "unknown";
  return ratio >= HIGH_AT ? "high" : ratio >= WARN_AT ? "warn" : "ok";
}

/** Whole percent, never above 100 and never rounded down to a "0%" for a window that is in use. */
export function contextPercent(context: ContextUsage): number | undefined {
  const ratio = contextRatio(context);
  return ratio === undefined ? undefined : Math.min(100, Math.max(1, Math.round(ratio * 100)));
}

export function formatTokens(count: number): string {
  if (count < 1000) return String(Math.round(count));
  if (count < 10_000) return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export function contextLabel(context: ContextUsage): string {
  const percent = contextPercent(context);
  return percent === undefined ? `${formatTokens(context.used)} tokens in context` : `${percent}% of context`;
}

function windowName(minutes: number | undefined): string {
  if (!minutes) return "Plan";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  return hours <= 48 ? `${Math.round(hours)}h` : `${Math.round(hours / 24)}d`;
}

/** The viewer's own clock and locale: a time within a day, a weekday and time beyond it. */
function resetText(resetsAt: number, now: number): string {
  const at = new Date(resetsAt * 1000);
  const time = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return resetsAt * 1000 - now < 86_400_000 ? time : `${at.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

/**
 * One short line for the window closest to its cap, such as
 * "5h window 62% · resets 3:10 PM". A window whose reset time has passed is
 * left out: the figure describes a window that no longer exists.
 */
export function limitLine(limits: ContextUsage["limits"], now = Date.now()): string | undefined {
  const live = [limits?.primary, limits?.secondary].filter((window): window is RateWindow => Boolean(window) && !(window!.resetsAt && window!.resetsAt * 1000 <= now));
  const worst = live.reduce<RateWindow | undefined>((best, window) => (!best || window.usedPercent > best.usedPercent ? window : best), undefined);
  if (!worst) return undefined;
  const name = windowName(worst.windowMinutes);
  return `${name === "Plan" ? "Plan" : `${name} window`} ${Math.round(worst.usedPercent)}%${worst.resetsAt ? ` · resets ${resetText(worst.resetsAt, now)}` : ""}`;
}

// What the session reader last measured for each agent, kept apart from the
// cached conversation so the header and the agent list can read it without
// polling. `live` is true only while a reader is polling that session: a
// figure from a session nobody is reading any more is not shown.
type Held = { context: ContextUsage | undefined; live: boolean };
const held = new Map<string, Held>();
const listeners = new Set<() => void>();

function put(key: string, next: Held) {
  const previous = held.get(key);
  if (previous && previous.live === next.live && previous.context === next.context) return;
  held.set(key, next);
  for (const listener of listeners) listener();
}
export function publishContext(key: string, context: ContextUsage | undefined) {
  put(key, { context, live: held.get(key)?.live ?? false });
}
export function setContextLive(key: string, live: boolean) {
  put(key, { context: held.get(key)?.context, live });
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

/** The live measurement for one agent, or undefined when none is being read. */
export function useAgentContext(agentId: string): ContextUsage | undefined {
  const url = useMoshpitStore((s) => {
    const host = s.hosts.find((h) => h.id === s.connectedHostId);
    return host && !host.demo && s.herdrRunning ? bridgeUrl(host) : "";
  });
  const key = JSON.stringify([url, agentId]);
  const entry = useSyncExternalStore(subscribe, () => held.get(key));
  return url && entry?.live ? entry.context : undefined;
}
