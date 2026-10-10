import { cleanFileName, MAX_FILE_BYTES, quoteShellWord } from "./file-names.mjs";
import { IMAGE_TYPES } from "./image";

export { MAX_FILE_BYTES };

/** Where a file lands in demo mode: a made-up path, so no request is made and nothing real is shown. */
export const DEMO_FILE_DIRECTORY = "/srv/moshpit/files/3f9a1c";

/** An image takes the attachment path; everything else is copied to the host. */
export const isImageFile = (file: File) => IMAGE_TYPES.includes(file.type);

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Why the bridge would refuse this file, so most refusals need no round trip; null when it would not. */
export function validateFile(file: File): string | null {
  const cleaned = cleanFileName(file.name);
  if (cleaned.error !== undefined) return cleaned.error;
  if (!file.size) return "That file is empty.";
  if (file.size > MAX_FILE_BYTES) return `Files must be ${MAX_FILE_BYTES / 1024 / 1024} MB or smaller.`;
  return null;
}

/**
 * The text with the host path of an uploaded file put in at the selection,
 * quoted so a shell or an agent reads it as one word. A space goes before it
 * when the character just before is not already a space, and after it when the
 * next character is not whitespace. The caret ends up after the path.
 */
export function insertQuotedPath(text: string, start: number, end: number, hostPath: string) {
  const from = Math.min(start, text.length);
  const to = Math.min(Math.max(end, from), text.length);
  const before = text.slice(0, from);
  const after = text.slice(to);
  const quoted = quoteShellWord(hostPath);
  const lead = before && !/\s$/.test(before) ? " " : "";
  const tail = after && !/^\s/.test(after) ? " " : "";
  const inserted = lead + quoted;
  return { text: before + inserted + tail + after, caret: before.length + inserted.length };
}
