import { stripAnsi } from "./ansi.ts";

/** Bounded, newest-first, per host+agent+session. In memory only. */
export const LINK_CAP = 100;

/** Key part for an agent whose session identity is not (yet) known. */
export const UNRESOLVED_SESSION = "unresolved";

export function sessionIdentity(
  sessionId: string | undefined,
  agentId: string,
  demo = false,
): string {
  return sessionId ?? (demo ? `demo:${agentId}` : UNRESOLVED_SESSION);
}

// NUL separator: host and agent (pane) ids may themselves contain ":".
export function linkKey(
  hostId: string,
  agentId: string,
  sessionId?: string,
  demo = false,
): string {
  return `${hostId}\u0000${agentId}\u0000${sessionIdentity(sessionId, agentId, demo)}`;
}

export function splitLinkKey(key: string): {
  hostId: string;
  agentId: string;
  session: string;
} | null {
  const i = key.lastIndexOf("\u0000");
  const j = i < 0 ? -1 : key.lastIndexOf("\u0000", i - 1);
  if (j < 0) return null;
  return { hostId: key.slice(0, j), agentId: key.slice(j + 1, i), session: key.slice(i + 1) };
}

/**
 * Drop entries whose host, agent, or session is gone from the snapshot. Runs
 * on the normal snapshot path, so a replaced session's list is retired without
 * a dedicated cleanup pass. Unchanged input comes back as the same reference
 * so a snapshot can skip the state write.
 */
export function pruneStaleLinks(
  links: Record<string, string[]>,
  hostId: string | null,
  agents: { id: string; sessionId?: string }[],
): Record<string, string[]> {
  if (!hostId) return links;
  const byAgent = new Map(agents.map((a) => [a.id, a.sessionId]));
  const next: Record<string, string[]> = {};
  let changed = false;
  for (const [key, urls] of Object.entries(links)) {
    const part = splitLinkKey(key);
    const agentSession = part ? byAgent.get(part.agentId) : undefined;
    const keep =
      part !== null &&
      part.hostId === hostId &&
      byAgent.has(part.agentId) &&
      (agentSession === undefined
        ? part.session === UNRESOLVED_SESSION
        : part.session === agentSession || part.session === UNRESOLVED_SESSION);
    if (keep) next[key] = urls;
    else changed = true;
  }
  return changed ? next : links;
}

// The transport is the limiting factor: herdr's pane read re-renders the
// visible cell grid and the only escapes it emits are SGR (measured across
// live panes). OSC 8 hyperlink targets therefore never arrive, so plain-text
// detection is the only channel, and a URL wrapped across rows by the pane
// width is a known limitation, not a search of full history.
const URL_RE = /https?:\/\/[^\s<>"']+/g;

// Terminal prose glues punctuation to a URL: backticks around a dev-server
// address, list markers, table pipes, sentence stops. Strip what is never
// part of a URL, then drop a closing bracket only while it is unbalanced —
// "…/wiki/Foo_(bar)" keeps its paren and "http://[::1]" its bracket, while
// "…com)" (prose) loses one. Loops because the two kinds interleave, as in
// "(`https://example.com`)".
const TRAILING = /[.,;:!`*|]+$/;
const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

function trimTrailing(raw: string): string {
  let candidate = raw;
  for (;;) {
    const stripped = candidate.replace(TRAILING, "");
    const last = stripped.at(-1) ?? "";
    const opener = CLOSERS[last];
    const next =
      opener && countChar(stripped, opener) < countChar(stripped, last)
        ? stripped.slice(0, -1)
        : stripped;
    if (next === candidate) return next;
    candidate = next;
  }
}

/**
 * Plain-text http(s) links in a terminal dump or row batch.
 *
 * Duplicates collapse to normalized URLs; malformed or unsafe candidates are
 * dropped silently — the dump is terminal text, not a document.
 */
export function extractLinks(dump: string): string[] {
  const found = new Set<string>();
  for (const match of stripAnsi(dump).matchAll(URL_RE)) {
    const candidate = trimTrailing(match[0]);
    try {
      const url = new URL(candidate);
      if (
        (url.protocol === "http:" || url.protocol === "https:") &&
        !url.username &&
        !url.password
      ) {
        found.add(url.href);
      }
    } catch {
      /* malformed terminal text */
    }
  }
  return [...found];
}

function countChar(s: string, ch: string) {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === ch) n++;
  return n;
}

/** Merge fresh links into a bounded newest-first list without duplicates. */
export function mergeLinks(
  prev: string[],
  fresh: string[],
  cap: number = LINK_CAP,
): string[] {
  const seen = new Set(prev);
  const added = fresh.filter((u) => !seen.has(u) && (seen.add(u), true));
  if (!added.length) return prev;
  return [...added, ...prev].slice(0, cap);
}
