import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chown, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createPrivateLog, readPrivateFile, writePrivateFile } from "./private-files.mjs";

async function scratch(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "moshpit-private-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const refused = (pattern) => (error) => error.code === "state_file_unsafe" && pattern.test(error.message);
const asRoot = process.getuid?.() === 0;

test("a missing file reads as null and a safe one reads back", async (t) => {
  const dir = await scratch(t);
  const file = path.join(dir, "state.json");
  assert.equal(await readPrivateFile(file, { maxBytes: 1024 }), null);
  await writePrivateFile(file, "{}\n");
  assert.equal(await readPrivateFile(file, { maxBytes: 1024 }), "{}\n");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(dir), ["state.json"], "no temp file is left behind");
});

test("reads refuse a symbolic link, a FIFO and an oversized file, and never follow the link", async (t) => {
  const dir = await scratch(t);
  const secret = path.join(dir, "elsewhere");
  await writeFile(secret, "not yours");
  const link = path.join(dir, "vapid.json");
  await symlink(secret, link);
  await assert.rejects(readPrivateFile(link, { maxBytes: 1024 }), refused(/is a symbolic link/));

  const fifo = path.join(dir, "push.json");
  execFileSync("mkfifo", [fifo]);
  await assert.rejects(readPrivateFile(fifo, { maxBytes: 1024 }), refused(/is not a regular file/));

  const big = path.join(dir, "big.json");
  await writeFile(big, "x".repeat(2048), { mode: 0o600 });
  await assert.rejects(readPrivateFile(big, { maxBytes: 1024 }), refused(/larger than/));
});

test("our own file with a loose mode is tightened to 0600", async (t) => {
  const dir = await scratch(t);
  const file = path.join(dir, "vapid.json");
  await writeFile(file, "{}", { mode: 0o644 });
  assert.equal(await readPrivateFile(file, { maxBytes: 1024 }), "{}");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test("a file owned by another user is refused, not repaired", { skip: !asRoot && "needs root to chown" }, async (t) => {
  const dir = await scratch(t);
  const file = path.join(dir, "audit.jsonl");
  await writeFile(file, "", { mode: 0o644 });
  await chown(file, 4242, 4242);
  await assert.rejects(readPrivateFile(file, { maxBytes: 1024 }), refused(/belongs to another user/));
  await assert.rejects(writePrivateFile(file, "{}"), refused(/belongs to another user/));
  await assert.rejects(createPrivateLog(file).append("{}"), refused(/belongs to another user/));
  const info = await stat(file);
  assert.equal(info.uid, 4242);
  assert.equal(info.mode & 0o777, 0o644, "someone else's file keeps its mode");
});

test("a write refuses to replace a symbolic link and leaves its target alone", async (t) => {
  const dir = await scratch(t);
  const target = path.join(dir, "target");
  await writeFile(target, "original");
  const link = path.join(dir, "push.json");
  await symlink(target, link);
  await assert.rejects(writePrivateFile(link, "{}"), refused(/is a symbolic link/));
  assert.equal(await readFile(target, "utf8"), "original");
  assert.deepEqual((await readdir(dir)).sort(), ["push.json", "target"]);
});

test("a log appends lines and rotates before passing its cap, keeping three old files", async (t) => {
  const dir = await scratch(t);
  const file = path.join(dir, "audit.jsonl");
  const log = createPrivateLog(file, { maxBytes: 100, keep: 3 });
  const line = (n) => JSON.stringify({ n, pad: "x".repeat(30) });
  // Each line is 49 bytes, so two fit under the cap and the third rotates.
  await Promise.all(Array.from({ length: 11 }, (_, n) => log.append(line(n))));
  const names = (await readdir(dir)).sort();
  assert.deepEqual(names, ["audit.jsonl", "audit.jsonl.1", "audit.jsonl.2", "audit.jsonl.3"]);
  const read = async (name) => (await readFile(path.join(dir, name), "utf8")).trim().split("\n").map((l) => JSON.parse(l).n);
  assert.deepEqual(await read("audit.jsonl"), [10]);
  assert.deepEqual(await read("audit.jsonl.1"), [8, 9]);
  assert.deepEqual(await read("audit.jsonl.2"), [6, 7]);
  assert.deepEqual(await read("audit.jsonl.3"), [4, 5]);
  for (const name of names) {
    const info = await stat(path.join(dir, name));
    assert.ok(info.size <= 100, `${name} stays under the cap`);
    assert.equal(info.mode & 0o777, 0o600);
  }
  await assert.rejects(log.append("y".repeat(200)), refused(/exceeds the 100-byte cap/));
});

test("rotation refuses a planted backup link before moving anything", async (t) => {
  const dir = await scratch(t);
  const file = path.join(dir, "client.log");
  const target = path.join(dir, "target");
  await writeFile(target, "original");
  const log = createPrivateLog(file, { maxBytes: 60, keep: 3 });
  await log.append(JSON.stringify({ n: 0, pad: "x".repeat(30) }));
  await symlink(target, `${file}.2`);
  await assert.rejects(log.append(JSON.stringify({ n: 1, pad: "x".repeat(30) })), refused(/client\.log\.2 is a symbolic link/));
  assert.equal(await readFile(target, "utf8"), "original");
  assert.match(await readFile(file, "utf8"), /"n":0/, "the active file was not rotated away");
  // The refusal does not wedge the log once the link is removed.
  await rm(`${file}.2`);
  await log.append(JSON.stringify({ n: 2, pad: "x".repeat(30) }));
  assert.match(await readFile(`${file}.1`, "utf8"), /"n":0/);
});

test("check refuses a symlinked active log without creating or following it", async (t) => {
  const dir = await scratch(t);
  const target = path.join(dir, "target");
  await writeFile(target, "original");
  const file = path.join(dir, "audit.jsonl");
  await symlink(target, file);
  const absent = path.join(dir, "client.log");
  await createPrivateLog(absent).check();
  await assert.rejects(stat(absent), { code: "ENOENT" }, "check creates nothing");
  const log = createPrivateLog(file);
  await assert.rejects(log.check(), refused(/audit\.jsonl is a symbolic link/));
  await assert.rejects(log.append("{}"), refused(/is a symbolic link/));
  assert.equal(await readFile(target, "utf8"), "original");
});
