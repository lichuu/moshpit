import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, rmdir, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { cleanFileName, MAX_FILE_BYTES } from "../src/lib/moshpit/file-names.mjs";
import { RequestError } from "./upload.mjs";

// Files sent to an agent (C12). The bytes are opaque: written once under a
// name that was checked, in a directory of their own, and never read back,
// served, executed or unpacked by the bridge. They stay on the host until an
// operator removes them, so a full store refuses a new file rather than
// deleting one an agent may still be using.

export { MAX_FILE_BYTES };
export const FILE_STORE_BYTES = 1024 * 1024 * 1024;
export const FILE_STORE_COUNT = 500;
export const FILES_PER_MINUTE = 20;
const WINDOW_MS = 60_000;
// Names no real upload can have: a stored name never starts with a dot.
const PART = ".part-";

const tooLarge = () => new RequestError(413, `Files must be ${MAX_FILE_BYTES / 1024 / 1024} MB or smaller.`, "file_too_large");
const interrupted = () => new RequestError(400, "The upload was interrupted. Nothing was kept.", "file_interrupted");
const unsafe = () => new RequestError(500, "The bridge's files directory is not private to its user. Fix its owner and mode (0700) and try again.", "file_storage_unsafe");

/** A rolling one-minute allowance per device. `take` throws once it is spent. */
export function createFileLimiter({ limit = FILES_PER_MINUTE, now = Date.now } = {}) {
  const recent = new Map();
  return {
    take(deviceId) {
      const time = now();
      const kept = (recent.get(deviceId) ?? []).filter((at) => time - at < WINDOW_MS);
      if (kept.length >= limit) {
        recent.set(deviceId, kept);
        const error = new RequestError(429, "Too many files sent in the last minute; try again shortly.", "file_rate_limited");
        error.retryAfter = Math.max(1, Math.ceil((kept[0] + WINDOW_MS - time) / 1000));
        throw error;
      }
      kept.push(time);
      recent.set(deviceId, kept);
    },
    forget(deviceId) {
      recent.delete(deviceId);
    },
  };
}

const invalidRequest = () => new RequestError(400, "Name the pane and the file only.", "file_request_invalid");

/**
 * The pane, the file name and the declared size of an upload. The pane and the
 * name are query parameters, each given once, and nothing else is accepted: the
 * body is the file and has no other fields to hide in.
 */
export function parseFileRequest(params, headers) {
  for (const key of new Set(params.keys())) {
    if (key !== "target" && key !== "name") throw invalidRequest();
  }
  const targets = params.getAll("target");
  const names = params.getAll("name");
  if (targets.length !== 1 || names.length > 1) throw invalidRequest();
  const [target] = targets;
  if (!target || target.length > 512 || target.startsWith("-")) throw invalidRequest();
  const declared = headers["content-length"];
  if (declared !== undefined && !/^[0-9]{1,15}$/.test(declared)) throw invalidRequest();
  return { target, name: names[0], length: declared === undefined ? undefined : Number(declared) };
}

/** Refuses a pane herdr does not report: an upload is for a live pane, and its place does not depend on the pane. */
export function fileTarget(snapshot, target) {
  const known = snapshot?.agents?.some((agent) => agent.id === target || agent.paneId === target)
    || snapshot?.shells?.some((shell) => shell.id === target);
  if (!known) throw new RequestError(404, "That pane is not running.", "file_target_unknown");
}

// A directory this process made or was told to use: a real directory (never a
// link), its own, and closed to everyone else. An unsafe one is refused, not
// repaired.
async function requirePrivateDirectory(directory) {
  const info = await lstat(directory);
  const owner = process.getuid?.();
  if (!info.isDirectory() || (owner !== undefined && info.uid !== owner) || (info.mode & 0o077) !== 0) throw unsafe();
}

// Bytes and uploads already on disk. A crash can leave a half-written ".part-"
// file or an empty directory; neither is anyone's file, so they are removed.
async function scan(root) {
  let used = 0;
  let count = 0;
  let entries;
  try {
    entries = await readdir(root);
  } catch (error) {
    if (error.code === "ENOENT") return { used, count };
    throw error;
  }
  for (const entry of entries) {
    const directory = path.join(root, entry);
    const info = await lstat(directory).catch(() => null);
    if (!info?.isDirectory()) continue;
    let kept = 0;
    for (const name of await readdir(directory).catch(() => [])) {
      const file = path.join(directory, name);
      const found = await lstat(file).catch(() => null);
      if (!found?.isFile()) continue;
      if (name.startsWith(PART)) await unlink(file).catch(() => { kept++; used += found.size; });
      else { kept++; used += found.size; }
    }
    if (kept) count++;
    else await rmdir(directory).catch(() => {});
  }
  return { used, count };
}

/**
 * Saves files under one aggregate bound of bytes and of uploads. Usage starts
 * from what is on disk, and each save reserves its size synchronously before
 * the first byte is written, so concurrent uploads cannot overshoot. A failed
 * save releases its reservation only once nothing of it remains on disk.
 *
 * Layout: <stateDir>/files/<random>/<name>. Both directories are 0700 and the
 * file 0600. The bytes go to a temporary name in the new directory and are
 * linked to the final name, which fails if anything is already there, so a
 * final name never holds a partial file and an existing file is never replaced.
 */
export async function createFiles({
  stateDir,
  quotaBytes = FILE_STORE_BYTES,
  maxFiles = FILE_STORE_COUNT,
  maxFileBytes = MAX_FILE_BYTES,
  randomId = () => randomBytes(12).toString("hex"),
}) {
  const root = path.resolve(stateDir, "files");
  let { used, count } = await scan(root);
  return {
    get usedBytes() {
      return used;
    },
    get fileCount() {
      return count;
    },
    /**
     * `chunks` is the request body; `length` is its declared size, when it
     * declared one. Resolves to the stored file, or throws a RequestError
     * after removing everything this save created.
     */
    async save({ name: raw, length, chunks }) {
      const cleaned = cleanFileName(raw);
      if (cleaned.error) throw new RequestError(400, cleaned.error, "file_name_invalid");
      const { name } = cleaned;
      if (length === 0) throw new RequestError(400, "That file is empty.", "file_empty");
      if (length !== undefined && length > maxFileBytes) throw tooLarge();
      // Without a declared length the most it could be is reserved.
      const reserved = length ?? maxFileBytes;
      if (count >= maxFiles || used + reserved > quotaBytes)
        throw new RequestError(507, "File storage on this host is full. Remove old folders from the files directory in the bridge's state directory.", "file_storage_full");
      used += reserved;
      count++;
      let directory;
      let made = false;
      let part;
      let handle;
      let size = 0;
      try {
        await mkdir(root, { recursive: true, mode: 0o700 });
        await requirePrivateDirectory(root);
        directory = path.join(root, randomId());
        // Not recursive: an existing entry, a link included, is an error.
        await mkdir(directory, { mode: 0o700 });
        made = true;
        const final = path.join(directory, name);
        const temporary = path.join(directory, `${PART}${randomId()}`);
        handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        part = temporary;
        for await (const chunk of chunks) {
          size += chunk.length;
          if (size > maxFileBytes || (length !== undefined && size > length)) throw tooLarge();
          await handle.write(chunk);
        }
        if (size === 0) throw new RequestError(400, "That file is empty.", "file_empty");
        if (length !== undefined && size !== length) throw interrupted();
        await handle.sync();
        await handle.close();
        handle = undefined;
        await link(part, final);
        await unlink(part).catch(() => {});
        used += size - reserved;
        return { path: final, name, size };
      } catch (error) {
        await handle?.close().catch(() => {});
        // Only what this save made is removed, never what it found: an entry
        // that was already there is left as it is. The reservation is released
        // once none of this save's bytes remain.
        let gone = true;
        if (part !== undefined) gone = await unlink(part).then(() => true, (cleanup) => cleanup.code === "ENOENT");
        if (made) await rmdir(directory).catch(() => {});
        if (gone) { used -= reserved; count--; }
        if (error instanceof RequestError) throw error;
        if (error.code === "EEXIST") throw new RequestError(500, "A file is already stored at that path; nothing was changed.", "file_exists");
        // A body that stops early surfaces as an aborted stream, not a bridge fault.
        if (["ECONNRESET", "ERR_STREAM_PREMATURE_CLOSE", "ABORT_ERR"].includes(error.code)) throw interrupted();
        throw error;
      }
    },
  };
}
