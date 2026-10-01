import { lstat, mkdir, open, readdir, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const UPLOAD_QUOTA_BYTES = 1024 * 1024 * 1024;
export const MAX_PROMPT_BODY = Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 64 * 1024;

export class RequestError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    if (code) this.code = code;
  }
}

function imageExtension(bytes) {
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return ["image/png", "png"];
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return ["image/jpeg", "jpg"];
  if (["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6)))
    return ["image/gif", "gif"];
  if (
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  )
    return ["image/webp", "webp"];
  throw new RequestError(400, "Choose a valid PNG, JPEG, WebP, or GIF image.");
}

export async function readUploadedImage(filename, stateDir) {
  const directory = path.resolve(stateDir, "uploads");
  if (typeof filename !== "string" || path.dirname(filename) !== directory ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.(png|jpg|gif|webp)$/.test(path.basename(filename))) {
    throw new RequestError(404, "Image not found.");
  }
  let file;
  try {
    file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_IMAGE_BYTES) throw new RequestError(404, "Image not found.");
    const bytes = await file.readFile();
    const [type] = imageExtension(bytes);
    return { bytes, type };
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "ELOOP"].includes(error.code)) throw new RequestError(404, "Image not found.");
    throw error;
  } finally {
    await file?.close();
  }
}

// Validates the attachment and returns its decoded bytes, before any disk
// space is reserved for it.
function decodeImage(image) {
  if (
    !image ||
    typeof image !== "object" ||
    typeof image.name !== "string" ||
    image.name.length > 255 ||
    typeof image.type !== "string" ||
    typeof image.data !== "string"
  )
    throw new RequestError(400, "Invalid image attachment.");
  // floor, not ceil: rounding up admits two bytes over the cap, which only the
  // post-decode check catches — after a 10 MB Buffer has already been built.
  if (image.data.length > Math.floor(MAX_IMAGE_BYTES / 3) * 4)
    throw new RequestError(413, "Images must be 10 MB or smaller.");
  if (
    !image.data.length ||
    image.data.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)
  )
    throw new RequestError(400, "Invalid image data.");
  const bytes = Buffer.from(image.data, "base64");
  if (bytes.length > MAX_IMAGE_BYTES)
    throw new RequestError(413, "Images must be 10 MB or smaller.");
  const [type, extension] = imageExtension(bytes);
  if (image.type !== type)
    throw new RequestError(
      400,
      "The file contents don't match its image type.",
    );
  return { bytes, type, extension };
}

async function bytesOnDisk(directory) {
  let names;
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
  let total = 0;
  for (const name of names) {
    const info = await lstat(path.join(directory, name)).catch(() => null);
    if (info?.isFile()) total += info.size;
  }
  return total;
}

/**
 * Saves uploaded images under one aggregate quota. Usage starts from what is
 * already on disk, and each save reserves its size synchronously before the
 * write, so concurrent uploads cannot overshoot. A failed write releases its
 * reservation only once the partial file is gone; a partial file that could
 * not be removed stays charged. Older uploads are never deleted to make room.
 */
export async function createUploads({ stateDir, quotaBytes = UPLOAD_QUOTA_BYTES }) {
  const directory = path.resolve(stateDir, "uploads");
  let used = await bytesOnDisk(directory);
  return {
    get usedBytes() {
      return used;
    },
    async save(image) {
      const { bytes, type, extension } = decodeImage(image);
      if (used + bytes.length > quotaBytes)
        throw new RequestError(507, "Upload storage on this host is full. Remove old files from the bridge's uploads directory.", "upload_quota_exceeded");
      used += bytes.length;
      const filename = path.join(directory, `${randomUUID()}.${extension}`);
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(filename, bytes, { mode: 0o600, flag: "wx" });
      } catch (error) {
        // Released only once no partial file can remain: removed now, or
        // never created because the path does not exist.
        await unlink(filename).then(
          () => { used -= bytes.length; },
          (cleanup) => { if (cleanup.code === "ENOENT" || cleanup.code === "ENOTDIR") used -= bytes.length; },
        );
        throw error;
      }
      return { path: filename, name: image.name, size: bytes.length, type };
    },
  };
}
