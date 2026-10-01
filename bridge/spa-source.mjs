import { stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { getAsset, getRawAsset } from "node:sea";

// Where the built PWA comes from: dist/spa in a checkout, or the assets the
// release build embedded in the executable. `find` takes a path relative to the
// app root and answers null for a missing file or a directory.

export const SPA_INDEX_ASSET = "spa-index.json";
export const spaAssetKey = (rel) => `spa/${rel}`;

export function diskSpa(root) {
  return {
    async find(rel) {
      const file = path.join(root, rel);
      try {
        const st = await stat(file);
        if (st.isDirectory()) return null;
        return { size: st.size, etag: `W/"${st.size}-${Number(st.mtimeMs).toString(36)}"`, stream: () => createReadStream(file) };
      } catch {
        return null;
      }
    },
  };
}

/** The index maps each relative path to the size and SHA-256 the build recorded. */
export function embeddedSpa() {
  const index = JSON.parse(getAsset(SPA_INDEX_ASSET, "utf8"));
  return {
    async find(rel) {
      if (!Object.hasOwn(index, rel)) return null;
      const { size, sha256 } = index[rel];
      return { size, etag: `"${sha256}"`, stream: () => Readable.from([Buffer.from(getRawAsset(spaAssetKey(rel)))]) };
    },
  };
}
