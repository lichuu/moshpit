import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { checkRelease, ManifestMismatch } from "./release-manifest.mjs";
import { releaseBin } from "./test-support.mjs";

function release(binary = Buffer.from("moshpit executable bytes"), fields = {}) {
  const manifest = {
    name: "moshpit-linux-x64",
    version: "v1.0.0",
    arch: "x64",
    releaseSerial: 700,
    sha256: createHash("sha256").update(binary).digest("hex"),
    bytes: binary.length,
    ...fields,
  };
  return { manifest, input: { manifestBytes: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), binaryBytes: binary } };
}

const refuses = (input, pattern) => assert.throws(() => checkRelease(input), (error) => error instanceof ManifestMismatch && pattern.test(error.message));

test("an executable that matches its manifest yields the manifest", () => {
  const { manifest, input } = release();
  assert.deepEqual(checkRelease(input), manifest);
});

test("an executable changed by one byte is refused by its SHA-256", () => {
  const { input } = release();
  const binaryBytes = Buffer.from(input.binaryBytes);
  binaryBytes[0] ^= 1;
  refuses({ ...input, binaryBytes }, /SHA-256 differs/);
});

test("a truncated or extended executable is refused by its size", () => {
  const { input } = release();
  refuses({ ...input, binaryBytes: input.binaryBytes.subarray(1) }, /size differs/);
  refuses({ ...input, binaryBytes: Buffer.concat([input.binaryBytes, Buffer.from("x")]) }, /size differs/);
});

test("a manifest that is not JSON, or names no size or hash, is refused", () => {
  const { input } = release();
  refuses({ ...input, manifestBytes: Buffer.from("not json") }, /not JSON/);
  refuses({ ...input, manifestBytes: Buffer.from("null") }, /size differs/);
  refuses(release(input.binaryBytes, { sha256: undefined }).input, /SHA-256 differs/);
});

// The executable ignores NODE_OPTIONS, so its assets are read from its bytes.
test("the release executable embeds the release info its manifest names", { skip: releaseBin() ? false : "needs the release executable; run npm run test:release" }, async () => {
  const binary = await readFile(releaseBin());
  const manifest = JSON.parse(await readFile(`${releaseBin()}.json`, "utf8"));
  assert.deepEqual(checkRelease({ manifestBytes: Buffer.from(JSON.stringify(manifest)), binaryBytes: binary }), manifest);
  const { sha256: _sha256, bytes: _bytes, ...info } = { ...manifest, name: "moshpit" };
  assert.ok(binary.includes(JSON.stringify(info)), "release.json is embedded as the manifest describes it");
  assert.equal(Number.isSafeInteger(info.releaseSerial) && info.releaseSerial > 0, true);
  assert.equal("signingKeyFingerprint" in info || "unsigned" in info, false, "the build records no signing state");
});
