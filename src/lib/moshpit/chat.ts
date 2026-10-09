import type { LineTone, PaneLine } from "./types";

export type ChatRole = "user" | "agent" | "system";
export type ChatAccent = "success" | "question";

export type ChatMessage = {
  role: ChatRole;
  text: string;
  accent?: ChatAccent;
};

type Mapped = { role: ChatRole; accent?: ChatAccent };

const CODEX_PLACEHOLDER = /^\s*(?:[›❯>]\s*)?ask codex to do anything[.…]*\s*$/iu;

export function filterChatChrome(messages: ChatMessage[]): ChatMessage[] {
  return messages.flatMap((message) => {
    const lines = message.text.split(/\r?\n/);
    let fence: string | undefined;
    const protectedLines = lines.map((line) => {
      const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
      const protectedLine = Boolean(fence || marker);
      if (marker && !fence) fence = marker;
      else if (marker && fence && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      return protectedLine;
    });
    const hidden = new Set<number>();
    lines.forEach((line, index) => {
      if (protectedLines[index]) return;
      if (CODEX_PLACEHOLDER.test(line)) hidden.add(index);
      if (message.role === "user") return;
      const footer = /^\s*↑[\d.,]+[km]?\s+↓[\d.,]+[km]?\s+[\d.]+%\/[\d.,]+[km]?\b/iu.test(line)
        || /^\s*bg\s+\d+\s+(?:done|running)\b.*(?:\/bg-clear|\/bg-update)/u.test(line);
      if (!footer) return;
      hidden.add(index);
      for (let before = index - 1; before >= 0 && !protectedLines[before]; before--) {
        const previous = lines[before];
        if (hidden.has(before) || /^\s*$/.test(previous) || /^\s*[─━]{20,}\s*$/.test(previous)
          || /^\s*(?:~\/|\/)[^\n]*\s+\([^\n()]+\)\s*$/.test(previous)) hidden.add(before);
        else break;
      }
    });
    const text = lines.filter((_, index) => !hidden.has(index)).join("\n");
    return text.trim() ? [{ ...message, text }] : [];
  });
}

function mapTone(tone: LineTone, blocked: boolean): Mapped {
  switch (tone) {
    case "in":
      return { role: "user" };
    case "dim":
      return { role: "system" };
    case "ok":
      return { role: "agent", accent: "success" };
    case "warn":
      return blocked
        ? { role: "agent", accent: "question" }
        : { role: "agent" };
    case "out":
    case "plain":
      return { role: "agent" };
    default: {
      const _exhaustive: never = tone;
      return _exhaustive;
    }
  }
}

function sameBubble(a: ChatMessage, b: Mapped) {
  return a.role === b.role;
}

export function linesToConversation(
  lines: PaneLine[],
  blocked = false,
): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const line of lines) {
    const last = out[out.length - 1];
    if (!line.text) {
      if (last) last.text += "\n";
      continue;
    }
    const mapped = mapTone(line.tone, blocked);
    if (last && sameBubble(last, mapped)) {
      last.text = `${last.text}\n${line.text}`;
      continue;
    }
    out.push({ role: mapped.role, text: line.text, accent: mapped.accent });
  }
  return out;
}

/**
 * A user message is long past 400 characters or five lines. The rule reads the
 * source text, not the rendered height, so a message never flips with the
 * width of the screen.
 */
export const isLongMessage = (text: string) => text.length > 400 || text.trimEnd().split(/\r?\n/).length > 5;
