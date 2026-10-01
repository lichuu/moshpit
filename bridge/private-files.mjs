import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";

// The bridge's own state and logs outside the device store: push
// subscriptions, the VAPID key pair, the audit trail and the client black box.
// An existing file is used only if it is a regular file this user owns and not
// a symbolic link. Anything else refuses the operation, or startup, rather
// than repairing a file that may belong to someone else. Tightening the mode
// of our own file to 0600 follows the device store.

export class PrivateFileError extends Error {
  constructor(message) {
    super(message);
    this.name = "PrivateFileError";
    this.status = 500;
    this.code = "state_file_unsafe";
  }
}

const unsafe = (file, why) =>
  new PrivateFileError(`${file} ${why}; move it aside or fix it, then restart the bridge`);

export const MAX_LOG_BYTES = 10 * 1024 * 1024;
export const KEPT_LOGS = 3;

function requireOwner(info, file) {
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid) throw unsafe(file, "belongs to another user");
}

// O_NONBLOCK keeps a FIFO planted at the path from stalling the bridge; the
// fstat below then refuses it.
async function openChecked(file, flags) {
  let handle;
  try {
    handle = await open(file, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  } catch (error) {
    if (error.code === "ELOOP") throw unsafe(file, "is a symbolic link");
    if (error.code === "ENXIO") throw unsafe(file, "is not a regular file");
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw unsafe(file, "is not a regular file");
    requireOwner(info, file);
    if ((info.mode & 0o777) !== 0o600) await handle.chmod(0o600);
    return { handle, size: info.size };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

// A path the bridge is about to replace or rotate into: absent, or a regular
// file this user owns.
async function requireReplaceable(file) {
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (info.isSymbolicLink()) throw unsafe(file, "is a symbolic link");
  if (!info.isFile()) throw unsafe(file, "is not a regular file");
  requireOwner(info, file);
}

/** The file's text, or null when it does not exist. */
export async function readPrivateFile(file, { maxBytes }) {
  let opened;
  try {
    opened = await openChecked(file, constants.O_RDONLY);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const { handle, size } = opened;
  try {
    if (size > maxBytes) throw unsafe(file, `is larger than the ${maxBytes} bytes this bridge writes`);
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/** Replaces the file atomically through a private temp file beside it. */
export async function writePrivateFile(file, data) {
  await requireReplaceable(file);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.chmod(0o600);
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

/**
 * An append-only JSON-lines log kept below `maxBytes`: before a line would
 * take the active file past the cap, it becomes `.1`, older files shift up,
 * and at most `keep` rotated files remain. Appends and rotation are serialized.
 */
export function createPrivateLog(file, { maxBytes = MAX_LOG_BYTES, keep = KEPT_LOGS } = {}) {
  let lane = Promise.resolve();
  const serialize = (action) => {
    const operation = lane.then(action, action);
    lane = operation.catch(() => {});
    return operation;
  };
  const openActive = () => openChecked(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT);

  async function rotate() {
    const rotated = (n) => `${file}.${n}`;
    for (let n = 1; n <= keep; n++) await requireReplaceable(rotated(n));
    await unlink(rotated(keep)).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    for (let n = keep - 1; n >= 1; n--) {
      await rename(rotated(n), rotated(n + 1)).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    await rename(file, rotated(1));
  }

  return {
    /** Refuses an unsafe active file, so startup can fail with guidance. Creates nothing. */
    check: () =>
      serialize(async () => {
        let opened;
        try {
          opened = await openChecked(file, constants.O_WRONLY | constants.O_APPEND);
        } catch (error) {
          if (error.code === "ENOENT") return;
          throw error;
        }
        await opened.handle.close();
      }),
    append: (line) =>
      serialize(async () => {
        const bytes = Buffer.from(line.endsWith("\n") ? line : `${line}\n`);
        if (bytes.length > maxBytes) throw new PrivateFileError(`a ${bytes.length}-byte entry exceeds the ${maxBytes}-byte cap on ${file}`);
        let { handle, size } = await openActive();
        try {
          if (size + bytes.length > maxBytes) {
            await handle.close();
            handle = null;
            await rotate();
            ({ handle } = await openActive());
          }
          await handle.write(bytes);
        } finally {
          await handle?.close();
        }
      }),
  };
}
