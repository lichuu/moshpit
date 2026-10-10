// What may be uploaded as a file, and how its path is written into a message.
// The bridge enforces these rules and the app checks them first so most
// refusals need no round trip; both import this module, so they cannot drift.

/** The largest file the bridge accepts, the same bound an attached image has. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** UTF-8 bytes of the stored name. Most file systems stop at 255; encrypted home directories stop lower. */
export const MAX_FILE_NAME_BYTES = 200;

// Windows device names, with or without an extension (con.txt is still con).
const DEVICE_NAME = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i;
// Control characters, line and paragraph separators, byte order mark, and the
// bidirectional controls that make "gpj.exe" display as "exe.jpg".
const HIDDEN = /[\p{Cc}\u2028\u2029\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069\ufeff]/u;

/**
 * The name to store a file under, or the reason it is refused. The name is
 * never trimmed to a final component: one with a separator in it is refused,
 * so what the user confirmed is exactly what is stored. Unicode letters stay;
 * the name is composed to NFC.
 */
export function cleanFileName(raw) {
  if (typeof raw !== "string" || !raw.isWellFormed()) return { error: "The file name is not valid text." };
  const name = raw.normalize("NFC");
  if (!name.trim()) return { error: "The file has no name." };
  if (HIDDEN.test(name)) return { error: "The file name has a control or hidden character in it." };
  // Compatibility forms too: a fullwidth slash must not become a separator later.
  if (/[/\\]/.test(name) || /[/\\]/.test(name.normalize("NFKC"))) return { error: "The file name has a path separator in it." };
  if (name.startsWith(".")) return { error: "A file name may not start with a dot, so nothing lands hidden." };
  if (name !== name.trim() || name.endsWith(".")) return { error: "A file name may not start or end with a space, or end with a dot." };
  if (new TextEncoder().encode(name).length > MAX_FILE_NAME_BYTES) return { error: `The file name must be ${MAX_FILE_NAME_BYTES} bytes or shorter.` };
  if (DEVICE_NAME.test(name)) return { error: "That file name is reserved." };
  return { name };
}

/**
 * The text as one shell word: single quotes, with each embedded single quote
 * written as '\'' (close, escaped quote, reopen). Nothing inside single quotes
 * is special to a POSIX shell, so spaces, $, backticks and double quotes need
 * no escape; a reader that is not a shell still sees one quoted string.
 */
export function quoteShellWord(text) {
  return `'${String(text).replaceAll("'", `'\\''`)}'`;
}
