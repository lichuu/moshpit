import { z } from "zod";

// C4: review comments on diff lines. They are staged with the draft and travel
// as plain text at the end of the next prompt, so the prompt is the only data
// model: this module writes that block and reads it back from a transcript.

export const REVIEW_COMMENT_LIMITS = {
  /** Comments staged for one agent at a time. */
  count: 30,
  /** Characters in one comment, after line breaks are normalised. */
  text: 500,
} as const;

export const reviewCommentSchema = z.object({
  id: z.string().min(1).max(64),
  /** The path the comment cites: the pre-rename path for an old-side line of a renamed file. */
  path: z.string().min(1).max(4096),
  line: z.number().int().positive(),
  /** Which side of the diff `line` counts on: the old file for a removed line, else the new one. */
  side: z.enum(["old", "new"]),
  text: z.string().min(1).max(REVIEW_COMMENT_LIMITS.text),
});
export type ReviewComment = z.infer<typeof reviewCommentSchema>;
/** What a transcript can tell: the comment as written, without the draft's own ID. */
export type SentComment = Omit<ReviewComment, "id">;

/** One comment per diff line: the same place is edited, never doubled. */
export const commentPlace = (comment: Pick<ReviewComment, "path" | "line" | "side">) =>
  JSON.stringify([comment.side, comment.path, comment.line]);

/**
 * A comment as it is kept: line breaks are \n, other control characters are
 * gone, and the ends are trimmed. Writing and parsing both rely on this being
 * a fixed point.
 */
export function cleanCommentText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f\u0085\u{2028}\u{2029}]/gu, "").trim();
}

/** The reason a comment cannot be saved, or null. */
export function commentProblem(text: string): string | null {
  const clean = cleanCommentText(text);
  if (!clean) return "Write a comment first.";
  if (clean.length > REVIEW_COMMENT_LIMITS.text) return `Comments are limited to ${REVIEW_COMMENT_LIMITS.text} characters.`;
  return null;
}

/** Where a comment points, as a person reads it: the path and line, with "(old)" for the file before the change. */
export const commentLocation = (comment: Pick<ReviewComment, "path" | "line" | "side">) =>
  `${comment.path}:${comment.line}${comment.side === "old" ? " (old)" : ""}`;

export const reviewCommentLabel = (count: number) => `${count} review ${count === 1 ? "comment" : "comments"}`;

// The block is the last thing in the prompt, after a blank line:
//
//   Review comments (2):
//   src/app.ts:12: Rename this.
//   src/app.ts:14 (old): Why was this removed?
//
// One line per comment. Backslash and line breaks in the text are written as
// \\ , \n and \r, so a comment can never add a line. The path is written as
// it is unless that would be ambiguous (it holds a line break or another
// control character, starts with a quote, or contains something that reads as
// ":12: "), and then as a JSON string. "(old)" marks a line number counted in
// the file before the change.
const HEADER = /^Review comments \((\d+)\):$/;
// eslint-disable-next-line no-control-regex
const UNSAFE_PATH = /^"|[\u0000-\u001f\u007f\u0085\u{2028}\u{2029}]|:\d+(?: \(old\))?: /u;
const PLAIN_ENTRY = /^([^"\n][^\n]*?):(\d+)( \(old\))?: ([^\n]+)$/;
const QUOTED_ENTRY = /^("(?:[^"\\\n]|\\.)*"):(\d+)( \(old\))?: ([^\n]+)$/;

const escapeText = (text: string) => text.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r");
const unescapeText = (text: string) => text.replace(/\\([\\nr])/g, (_, c: string) => (c === "n" ? "\n" : c === "r" ? "\r" : "\\"));

function writePath(path: string) {
  if (!UNSAFE_PATH.test(path)) return path;
  return JSON.stringify(path).replace(/[\u0085\u{2028}\u{2029}]/gu, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function writeEntry(comment: SentComment) {
  return `${writePath(comment.path)}:${comment.line}${comment.side === "old" ? " (old)" : ""}: ${escapeText(comment.text)}`;
}

/** The block for these comments, or an empty string when there are none. */
export function formatReviewComments(comments: readonly SentComment[]): string {
  if (!comments.length) return "";
  return [`Review comments (${comments.length}):`, ...comments.map(writeEntry)].join("\n");
}

/** The prompt to send: what was typed, a blank line, then the block. */
export function withReviewComments(text: string, comments: readonly SentComment[]): string {
  const block = formatReviewComments(comments);
  if (!block) return text;
  return text ? `${text}\n\n${block}` : block;
}

function readEntry(line: string): SentComment | null {
  const quoted = line.startsWith('"');
  const found = (quoted ? QUOTED_ENTRY : PLAIN_ENTRY).exec(line);
  if (!found) return null;
  let path: string;
  if (quoted) {
    try {
      const value: unknown = JSON.parse(found[1]);
      if (typeof value !== "string") return null;
      path = value;
    } catch {
      return null;
    }
  } else path = found[1];
  const number = Number(found[2]);
  const entry: SentComment = { path, line: number, side: found[3] ? "old" : "new", text: unescapeText(found[4]) };
  // Only what the writer would have written counts, byte for byte, so
  // anything merely similar stays plain text.
  if (!Number.isSafeInteger(number) || number < 1 || !path || path.length > 4096) return null;
  if (!entry.text || entry.text !== cleanCommentText(entry.text) || entry.text.length > REVIEW_COMMENT_LIMITS.text) return null;
  return writeEntry(entry) === line ? entry : null;
}

/**
 * Splits a sent message into what was typed and the review comments at its
 * end. Null unless the message ends in exactly the block `withReviewComments`
 * writes: the header with the right count, then that many entries, after a
 * blank line or at the very start. Trailing line breaks are tolerated.
 */
export function parseReviewComments(message: string): { body: string; comments: SentComment[] } | null {
  if (!message.includes("Review comments (")) return null;
  const lines = message.replace(/[\r\n]+$/, "").split("\n");
  const floor = Math.max(0, lines.length - 1 - REVIEW_COMMENT_LIMITS.count);
  for (let at = lines.length - 2; at >= floor; at -= 1) {
    const header = HEADER.exec(lines[at]);
    if (!header) continue;
    const count = Number(header[1]);
    if (String(count) !== header[1] || count !== lines.length - 1 - at || count > REVIEW_COMMENT_LIMITS.count) return null;
    if (at > 0 && (at < 2 || lines[at - 1] !== "")) return null;
    const comments: SentComment[] = [];
    for (const line of lines.slice(at + 1)) {
      const comment = readEntry(line);
      if (!comment) return null;
      comments.push(comment);
    }
    return { body: lines.slice(0, Math.max(0, at - 1)).join("\n"), comments };
  }
  return null;
}
