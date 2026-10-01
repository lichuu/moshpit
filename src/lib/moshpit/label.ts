import type { Agent } from "./types";

/**
 * Naming a pane so a human can find it.
 *
 * Herdr identifies panes as `wF:t8`, which is the least useful thing it knows
 * about them. The terminal title is the most useful — "Ghostty-web lag" — but
 * some harnesses reuse one title across every pane they own (five panes all
 * reading "π - moshpit"), so a title alone is not an identifier. Fall back to
 * the agent name, and only spend the tab id when a label is genuinely
 * ambiguous.
 */

/** Last path segment of a cwd: "/home/me/projects/moshpit" -> "moshpit". */
export function projectOf(cwd: string): string {
  const trimmed = cwd.replace(/\/+$/, "");
  const seg = trimmed.split("/").pop() ?? "";
  return seg || trimmed || "";
}

/** "wF:t8" -> "t8"; already-short tabs pass through. */
function tabSuffix(tab: string): string {
  return tab.includes(":") ? (tab.split(":").pop() ?? tab) : tab;
}

function baseName(agent: Agent): string {
  return agent.title?.trim() || agent.name;
}

export type PaneLabel = { name: string; detail: string };

export function paneLabel(agent: Agent, all: Agent[]): PaneLabel {
  const base = baseName(agent);
  const ambiguous = all.some((a) => a.id !== agent.id && baseName(a) === base);
  const project = projectOf(agent.cwd);
  const kind = agent.kind ?? agent.name;
  return {
    name: ambiguous ? `${base} · ${tabSuffix(agent.tab)}` : base,
    detail: project ? `${kind} · ${project}` : kind,
  };
}
