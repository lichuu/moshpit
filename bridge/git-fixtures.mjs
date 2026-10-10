import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Real temporary repositories for the tests that read a checkout (changes.test.mjs
// and changes-summary.test.mjs). Each test file calls `cleanup` from its own `test.after`.

const IDENT = ["-c", "user.name=t", "-c", "user.email=t@e"];
export const git = (cwd, ...args) => execFileSync("git", [...IDENT, ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });

const made = [];
export const cleanup = () => Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));

export async function scratch() {
  const dir = await mkdtemp(path.join(tmpdir(), "moshpit-changes-"));
  made.push(dir);
  return dir;
}

/** A repository with one commit holding `files` (path -> text). */
export async function repo(files = { "a.txt": "one\ntwo\nthree\n" }, { name = "work" } = {}) {
  const dir = path.join(await scratch(), name);
  await mkdir(dir);
  git(dir, "init", "-q", "-b", "main");
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), text);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "first");
  return dir;
}

/** A script that stands in for a program git must never run: it leaves a marker. */
export async function trap(name) {
  const home = await scratch();
  const marker = path.join(home, `${name}.ran`);
  const script = path.join(home, `${name}.sh`);
  await writeFile(script, `#!/bin/sh\necho ran >> '${marker}'\ncat\n`);
  await chmod(script, 0o755);
  return { script, marker, ran: () => existsSync(marker) };
}

/** Every file under .git with its modification time and hash: equal before and after means nothing was written. */
export async function snapshotGitDir(dir) {
  const rows = [];
  async function walk(current) {
    for (const item of (await readdir(current, { withFileTypes: true })).sort((x, y) => x.name.localeCompare(y.name))) {
      const full = path.join(current, item.name);
      if (item.isDirectory()) await walk(full);
      else rows.push(`${path.relative(dir, full)} ${(await stat(full)).mtimeMs} ${createHash("sha1").update(await readFile(full)).digest("hex")}`);
    }
  }
  await walk(path.join(dir, ".git"));
  return rows;
}
