import { createHash } from "node:crypto";

// A release is trusted because it came over HTTPS from the repository's
// GitHub Releases, and its executable matches the manifest published beside
// it. The manifest check catches a damaged or truncated download. It does
// not catch a release replaced by someone who can publish to the
// repository, because they can replace the manifest too.

export class ManifestMismatch extends Error {
  constructor(detail) {
    super(detail);
    this.name = "ManifestMismatch";
  }
}

/** The parsed manifest, only when its byte count and SHA-256 describe the executable. */
export function checkRelease({ manifestBytes, binaryBytes }) {
  let manifest;
  try {
    manifest = JSON.parse(Buffer.from(manifestBytes).toString("utf8"));
  } catch {
    throw new ManifestMismatch("the manifest is not JSON");
  }
  if (manifest?.bytes !== binaryBytes.length) throw new ManifestMismatch("the executable size differs from the manifest");
  if (manifest.sha256 !== createHash("sha256").update(binaryBytes).digest("hex")) throw new ManifestMismatch("the executable SHA-256 differs from the manifest");
  return manifest;
}
