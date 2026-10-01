import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createUploads } from "./upload.mjs";

const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(92)]);
const image = (bytes = PNG) => ({ name: "shot.png", type: "image/png", data: bytes.toString("base64") });

async function scratch(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "moshpit-upload-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("parallel uploads cannot pass the quota, and a refusal keeps older uploads", async (t) => {
  const stateDir = await scratch(t);
  const uploads = await createUploads({ stateDir, quotaBytes: PNG.length * 3 });
  const results = await Promise.allSettled(Array.from({ length: 6 }, () => uploads.save(image())));
  const saved = results.filter((r) => r.status === "fulfilled");
  const refused = results.filter((r) => r.status === "rejected");
  assert.equal(saved.length, 3);
  for (const { reason } of refused) {
    assert.equal(reason.status, 507);
    assert.equal(reason.code, "upload_quota_exceeded");
  }
  assert.equal((await readdir(path.join(stateDir, "uploads"))).length, 3, "no upload was deleted to make room");
  assert.equal(uploads.usedBytes, PNG.length * 3);
});

test("a restart counts files already on disk", async (t) => {
  const stateDir = await scratch(t);
  await mkdir(path.join(stateDir, "uploads"), { recursive: true });
  await writeFile(path.join(stateDir, "uploads", "old.png"), Buffer.alloc(PNG.length * 2));
  const uploads = await createUploads({ stateDir, quotaBytes: PNG.length * 3 });
  assert.equal(uploads.usedBytes, PNG.length * 2);
  await uploads.save(image());
  await assert.rejects(uploads.save(image()), { code: "upload_quota_exceeded" });
});

test("an invalid image is refused before it reserves anything", async (t) => {
  const stateDir = await scratch(t);
  const uploads = await createUploads({ stateDir, quotaBytes: PNG.length });
  await assert.rejects(uploads.save({ ...image(), type: "image/jpeg" }), { status: 400 });
  assert.equal(uploads.usedBytes, 0);
  await uploads.save(image());
});

test("a failed write releases its reservation", async (t) => {
  const stateDir = await scratch(t);
  const directory = path.join(stateDir, "uploads");
  const uploads = await createUploads({ stateDir, quotaBytes: PNG.length });
  // A file where the directory should be fails the write for any user.
  await writeFile(directory, "");
  await assert.rejects(uploads.save(image()), (error) => ["EEXIST", "ENOTDIR"].includes(error.code));
  assert.equal(uploads.usedBytes, 0);
  await rm(directory);
  await uploads.save(image());
  assert.equal(uploads.usedBytes, PNG.length);
});
