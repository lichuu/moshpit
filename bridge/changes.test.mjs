import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ChangesError,
  FILE_CAP,
  PATCH_CAP,
  UNTRACKED_FILE_CAP,
  changesDirectory,
  createChanges,
  parseChangesQuery,
  resolveInside,
} from "./changes.mjs";

const IDENT = ["-c", "user.name=t", "-c", "user.email=t@e"];
const git = (cwd, ...args) => execFileSync("git", [...IDENT, ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
const changes = createChanges();
const cleanups = [];
test.after(async () => {
  await Promise.all(cleanups.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function scratch() {
  const dir = await mkdtemp(path.join(tmpdir(), "moshpit-changes-"));
  cleanups.push(dir);
  return dir;
}

/** A repository with one commit holding `files` (path -> text). */
async function repo(files = { "a.txt": "one\ntwo\nthree\n" }, { name = "work" } = {}) {
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

const entry = (result, name) => result.files.find((file) => file.path === name);
const patchOf = (result, file) => result.patch.slice(...file.patch);

/** A script that stands in for a program git must never run: it leaves a marker. */
async function trap(name) {
  const home = await scratch();
  const marker = path.join(home, `${name}.ran`);
  const script = path.join(home, `${name}.sh`);
  await writeFile(script, `#!/bin/sh\necho ran >> '${marker}'\ncat\n`);
  await chmod(script, 0o755);
  return { script, marker, ran: () => existsSync(marker) };
}

test("lists staged and unstaged edits against HEAD, with counts and the branch", async () => {
  const dir = await repo({ "a.txt": "one\ntwo\nthree\n", "b.txt": "x\n", "c.txt": "keep\n" });
  await writeFile(path.join(dir, "a.txt"), "one\nTWO\nthree\nfour\n");
  git(dir, "add", "a.txt");
  await writeFile(path.join(dir, "a.txt"), "one\nTWO\nthree\nfour\nfive\n");
  await writeFile(path.join(dir, "b.txt"), "y\n");
  git(dir, "rm", "-q", "--cached", "c.txt");
  const result = await changes.read(dir);
  assert.equal(result.kind, "checkout");
  assert.equal(result.repo, "work");
  assert.equal(result.branch, "main");
  assert.equal(result.detached, false);
  assert.match(result.head, /^[0-9a-f]{7}$/);
  // Staged and unstaged edits to one file read as a single change since HEAD.
  assert.deepEqual({ ...entry(result, "a.txt"), patch: undefined }, { path: "a.txt", status: "modified", added: 3, deleted: 1, binary: false, untracked: false, patch: undefined });
  assert.deepEqual([entry(result, "b.txt").added, entry(result, "b.txt").deleted], [1, 1]);
  assert.equal(entry(result, "c.txt").status, "deleted");
  assert.equal(result.truncated, false);
  assert.match(patchOf(result, entry(result, "a.txt")), /^diff --git a\/a\.txt b\/a\.txt\n[\s\S]*\+five\n$/);
  assert.equal(result.fileCount, 3);
});

test("a clean checkout has no files and no patch", async () => {
  const dir = await repo();
  assert.deepEqual(await changes.read(dir), {
    kind: "checkout",
    repo: "work",
    branch: "main",
    detached: false,
    head: (await changes.read(dir)).head,
    files: [],
    fileCount: 0,
    patch: "",
    truncated: false,
  });
});

test("reads from a subdirectory of the checkout and names the repository by its last component", async () => {
  const dir = await repo({ "src/deep/x.txt": "x\n" });
  await writeFile(path.join(dir, "src/deep/x.txt"), "y\n");
  const result = await changes.read(path.join(dir, "src", "deep"));
  assert.equal(result.repo, "work");
  assert.deepEqual(result.files.map((file) => file.path), ["src/deep/x.txt"]);
  assert.ok(!JSON.stringify(result).includes(dir), "no absolute host path leaves the bridge");
});

test("includes untracked files and never ignored ones", async () => {
  const dir = await repo({ ".gitignore": "build/\n*.log\n" });
  await mkdir(path.join(dir, "build"));
  await mkdir(path.join(dir, "notes"));
  await writeFile(path.join(dir, "build", "out.js"), "IGNORED_BUILD\n");
  await writeFile(path.join(dir, "debug.log"), "IGNORED_LOG\n");
  await writeFile(path.join(dir, "notes", "todo.txt"), "fresh\nlines\n");
  const result = await changes.read(dir);
  assert.deepEqual(result.files.map((file) => file.path), ["notes/todo.txt"]);
  const file = result.files[0];
  assert.equal(file.untracked, true);
  assert.equal(file.status, "added");
  assert.deepEqual([file.added, file.deleted], [2, 0]);
  assert.match(patchOf(result, file), /^diff --git a\/notes\/todo\.txt b\/notes\/todo\.txt\nnew file mode 100644\nindex 0000000\.\.[0-9a-f]+\n--- \/dev\/null\n\+\+\+ b\/notes\/todo\.txt\n@@ -0,0 \+1,2 @@\n\+fresh\n\+lines\n$/);
  assert.ok(!result.patch.includes("IGNORED"));
});

test("a tracked file that is now ignored is still a tracked change, an ignored untracked one is absent", async () => {
  const dir = await repo({ "kept.txt": "a\n" });
  await writeFile(path.join(dir, ".gitignore"), "kept.txt\nsecret.env\n");
  await writeFile(path.join(dir, "secret.env"), "TOKEN=hunter2\n");
  await writeFile(path.join(dir, "kept.txt"), "b\n");
  const result = await changes.read(dir);
  assert.deepEqual(result.files.map((file) => file.path).sort(), [".gitignore", "kept.txt"]);
  assert.ok(!result.patch.includes("hunter2"));
});

test("reports renames with their previous path, and deletions", async () => {
  const dir = await repo({ "old.txt": "alpha\nbeta\ngamma\ndelta\nepsilon\n", "gone.txt": "bye\n" });
  git(dir, "mv", "old.txt", "new.txt");
  await writeFile(path.join(dir, "new.txt"), "alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\n");
  await rm(path.join(dir, "gone.txt"));
  const result = await changes.read(dir);
  const renamed = entry(result, "new.txt");
  assert.equal(renamed.status, "renamed");
  assert.equal(renamed.previousPath, "old.txt");
  assert.deepEqual([renamed.added, renamed.deleted], [1, 0]);
  assert.match(patchOf(result, renamed), /^diff --git a\/old\.txt b\/new\.txt\nsimilarity index/);
  assert.equal(entry(result, "gone.txt").status, "deleted");
  assert.equal(entry(result, "old.txt"), undefined);
});

test("binary files are listed as binary and carry no content", async () => {
  const dir = await repo({ "pic.bin": Buffer.from([0, 1, 2, 3, 0, 0x50]).toString("latin1") });
  await writeFile(path.join(dir, "pic.bin"), Buffer.from([0, 9, 8, 7, 0, 0x51, 0x52]));
  await writeFile(path.join(dir, "fresh.bin"), Buffer.from([0, 0xff, 0xfe, 0x53, 0x45, 0x43, 0x52, 0x45, 0x54, 0]));
  const result = await changes.read(dir);
  for (const name of ["pic.bin", "fresh.bin"]) {
    const file = entry(result, name);
    assert.equal(file.binary, true, name);
    assert.equal(file.added, null);
    assert.equal(file.deleted, null);
    assert.match(patchOf(result, file), /Binary files .* differ\n$/);
  }
  assert.ok(!result.patch.includes("SECRET"));
  assert.equal(entry(result, "fresh.bin").untracked, true);
});

test("paths with spaces, quotes, tabs, newlines and non-ASCII are reported as they are", async () => {
  const names = ["with space.txt", 'say "hi".txt', "tab\there.txt", "new\nline.txt", "café 日本.txt", "-dash.txt", "back\\slash.txt"];
  const dir = await repo(Object.fromEntries(names.map((name) => [name, "v1\n"])));
  for (const name of names) await writeFile(path.join(dir, name), "v2\n");
  await writeFile(path.join(dir, "u spaceé\n\"q\".txt"), "fresh\n");
  const result = await changes.read(dir);
  assert.deepEqual(result.files.map((file) => file.path).sort(), [...names, "u spaceé\n\"q\".txt"].sort());
  for (const file of result.files) {
    assert.ok(file.patch, `${JSON.stringify(file.path)} has its patch`);
    assert.match(patchOf(result, file), /^diff --git /);
    assert.ok(file.added >= 1);
  }
  assert.match(patchOf(result, entry(result, "tab\there.txt")), /^diff --git "a\/tab\\there\.txt" "b\/tab\\there\.txt"\n/);
});

test("a repository with no commits shows what is staged and what is untracked as new", async () => {
  const dir = path.join(await scratch(), "fresh");
  await mkdir(dir);
  git(dir, "init", "-q", "-b", "trunk");
  await writeFile(path.join(dir, "staged.txt"), "s1\ns2\n");
  git(dir, "add", "staged.txt");
  await writeFile(path.join(dir, "staged.txt"), "s1\ns2\ns3\n");
  await writeFile(path.join(dir, "loose.txt"), "l\n");
  const result = await changes.read(dir);
  assert.equal(result.branch, "trunk");
  assert.equal(result.head, null);
  assert.deepEqual(result.files.map((file) => [file.path, file.status, file.untracked, file.added]), [
    ["staged.txt", "added", false, 3],
    ["loose.txt", "added", true, 1],
  ]);
});

test("a detached HEAD has no branch name and says so", async () => {
  const dir = await repo();
  git(dir, "checkout", "-q", "--detach");
  const result = await changes.read(dir);
  assert.equal(result.branch, null);
  assert.equal(result.detached, true);
  assert.match(result.head, /^[0-9a-f]{7}$/);
});

test("a linked worktree reports its own branch and changes", async () => {
  const dir = await repo();
  const linked = path.join(path.dirname(dir), "linked");
  git(dir, "worktree", "add", "-q", "-b", "side", linked);
  await writeFile(path.join(linked, "a.txt"), "changed in the linked checkout\n");
  const result = await changes.read(linked);
  assert.equal(result.repo, "linked");
  assert.equal(result.branch, "side");
  assert.deepEqual(result.files.map((file) => file.path), ["a.txt"]);
  assert.deepEqual((await changes.read(dir)).files, []);
});

test("submodules are not entered", async () => {
  const inner = await repo({ "lib.txt": "1\n" }, { name: "inner" });
  const dir = await repo({ "a.txt": "x\n" });
  git(dir, "-c", "protocol.file.allow=always", "submodule", "add", "-q", inner, "vendor");
  git(dir, "commit", "-q", "-m", "sub");
  await writeFile(path.join(dir, "vendor", "lib.txt"), "2\n");
  const result = await changes.read(dir);
  assert.deepEqual(result.files, []);
});

test("not a git checkout, a missing directory, a missing git and a pane without a directory each answer distinctly", async () => {
  const plain = await scratch();
  assert.deepEqual(await changes.read(plain), { kind: "not-a-checkout" });

  await assert.rejects(changes.read(path.join(plain, "nope")), { status: 409, code: "changes_directory_missing", message: "This pane's directory no longer exists." });
  await writeFile(path.join(plain, "file"), "x");
  await assert.rejects(changes.read(path.join(plain, "file")), { code: "changes_directory_missing" });

  const dir = await repo();
  await assert.rejects(createChanges({ gitBin: path.join(plain, "no-such-git") }).read(dir), { status: 503, code: "changes_git_missing", message: "Git is not installed on this host." });

  const bare = path.join(plain, "bare.git");
  git(plain, "init", "-q", "--bare", bare);
  assert.deepEqual(await changes.read(bare), { kind: "not-a-checkout" });
  assert.deepEqual(await changes.read(path.join(dir, ".git")), { kind: "not-a-checkout" });

  const snapshot = { agents: [{ id: "w1:p1", paneId: "w1:p1", cwd: dir }, { id: "w1:p2", paneId: "w1:p2", cwd: "" }, { id: "w1:p3", paneId: "w1:p3", cwd: "~/src/web" }] };
  assert.equal(changesDirectory(snapshot, "w1:p1"), dir);
  assert.throws(() => changesDirectory(snapshot, "w1:p2"), { status: 409, code: "changes_no_directory", message: "This pane has no known directory." });
  assert.throws(() => changesDirectory(snapshot, "w1:p3"), { code: "changes_no_directory" });
  assert.throws(() => changesDirectory(snapshot, "w9:p9"), { status: 404, code: "changes_target_unknown" });
});

test("a request names the pane and nothing else", () => {
  assert.equal(parseChangesQuery(new URLSearchParams("target=w1%3Ap1")), "w1:p1");
  for (const bad of ["", "target=", "target=a&target=b", "target=a&path=/etc", "target=a&cwd=/tmp", "target=a&ref=HEAD~3", "target=a&arg=--output%3Dx", "path=/etc", "target=-p", `target=${"x".repeat(513)}`]) {
    assert.throws(() => parseChangesQuery(new URLSearchParams(bad)), (error) => error instanceof ChangesError && error.status === 400 && error.code === "changes_request_invalid", bad);
  }
});

test("git runs with literal argv, no shell, whatever the directory and file names hold", async () => {
  const dir = await repo({ "plain.txt": "1\n" }, { name: "w $(touch pwned); `touch pwned2` & 'x'" });
  await writeFile(path.join(dir, "plain.txt"), "2\n");
  await writeFile(path.join(dir, "; touch pwned3 #.txt"), "n\n");
  await writeFile(path.join(dir, "$(touch pwned4).txt"), "n\n");
  const result = await changes.read(dir);
  assert.equal(result.files.length, 3);
  for (const name of ["pwned", "pwned2", "pwned3", "pwned4"]) {
    assert.equal(existsSync(path.join(dir, name)), false, name);
    assert.equal(existsSync(path.join(process.cwd(), name)), false, name);
  }
});

test("every git call is read-only, quiet and carries the safety settings", async () => {
  const dir = await repo({ "a.txt": "1\n" });
  await writeFile(path.join(dir, "a.txt"), "2\n");
  await writeFile(path.join(dir, "new.txt"), "n\n");
  const log = path.join(await scratch(), "calls.log");
  const wrapper = path.join(path.dirname(log), "git-wrapper");
  await writeFile(wrapper, `#!/bin/sh\n{ printf '%s=%s ' GIT_OPTIONAL_LOCKS "$GIT_OPTIONAL_LOCKS" GIT_TERMINAL_PROMPT "$GIT_TERMINAL_PROMPT" GIT_PAGER "$GIT_PAGER"; printf '%s\\037' "$@"; printf '\\n'; } >> '${log}'\nexec git "$@"\n`);
  await chmod(wrapper, 0o755);
  await createChanges({ gitBin: wrapper }).read(dir);
  const calls = (await readFile(log, "utf8")).split("\n").filter(Boolean).map((line) => {
    const parts = line.split(" ");
    return { env: parts.slice(0, 3).join(" "), args: parts.slice(3).join(" ").split("\u001f").filter(Boolean) };
  });
  assert.ok(calls.length >= 5);
  const verbs = new Set(["rev-parse", "config", "status", "diff", "ls-files"]);
  for (const { env, args } of calls) {
    assert.match(env, /GIT_OPTIONAL_LOCKS=0/);
    assert.match(env, /GIT_TERMINAL_PROMPT=0/);
    assert.match(env, /GIT_PAGER=cat/);
    for (const setting of ["core.fsmonitor=false", "core.pager=cat", "diff.external="]) {
      assert.ok(args.some((arg, at) => arg === setting && args[at - 1] === "-c"), `${setting} in ${args.join(" ")}`);
    }
    const verb = args.find((arg, at) => args[at - 1] !== "-c" && !arg.startsWith("-") && verbs.has(arg));
    assert.ok(verb, args.join(" "));
    assert.ok(!["add", "commit", "checkout", "reset", "stash", "update-index", "apply", "gc", "fetch", "pull", "push", "clean", "rm", "mv"].includes(verb));
    if (verb === "diff") {
      for (const flag of ["--no-ext-diff", "--no-textconv", "--ignore-submodules=all"]) {
        // The raw name-status and numstat runs name their flags the same way.
        assert.ok(args.includes(flag), `${flag} in ${args.join(" ")}`);
      }
    }
    if (verb === "status") assert.ok(args.includes("--ignore-submodules=all"));
  }
  const diffs = calls.filter(({ args }) => args.includes("diff"));
  assert.ok(diffs.length >= 4);
  const untracked = diffs.find(({ args }) => args.includes("--no-index"));
  // The path follows `--`, so it can never be read as an option.
  assert.deepEqual(untracked.args.slice(untracked.args.indexOf("--")), ["--", "/dev/null", "new.txt"]);
});

// Each setting a repository can use to make a read run a program, with the
// plain git command that does run it. The read must not.
const PROGRAMS = [
  { name: "diff.external", plain: ["diff", "HEAD"], attributes: "", set: (t) => [["diff.external", t]] },
  { name: "a diff driver's command", plain: ["diff", "HEAD"], attributes: "*.bin diff=spy\n", set: (t) => [["diff.spy.command", t]] },
  { name: "a textconv driver", plain: ["diff", "HEAD"], attributes: "*.bin diff=spy\n", set: (t) => [["diff.spy.textconv", t]] },
  { name: "core.fsmonitor", plain: ["status", "--porcelain"], attributes: "", set: (t) => [["core.fsmonitor", t]] },
  { name: "a clean filter", plain: ["diff", "HEAD"], attributes: "*.dat filter=spy\n", set: (t) => [["filter.spy.clean", t]] },
  { name: "a filter process", plain: ["diff", "HEAD"], attributes: "*.dat filter=spy\n", set: (t) => [["filter.spy.process", t]] },
  { name: "a clean filter whose name has a dot", plain: ["diff", "HEAD"], attributes: "*.dat filter=my.spy\n", set: (t) => [["filter.my.spy.clean", t]] },
];

for (const { name, plain, attributes, set } of PROGRAMS) {
  test(`a repository cannot make a read run ${name}`, async () => {
    const dir = await repo({ "a.txt": "one\n", "b.bin": "x\n", "c.dat": "y\n" });
    const spy = await trap("spy");
    await writeFile(path.join(dir, ".git", "info", "attributes"), attributes);
    for (const [key, value] of set(spy.script)) git(dir, "config", key, value);
    await writeFile(path.join(dir, "a.txt"), "two\n");
    await writeFile(path.join(dir, "b.bin"), "changed\n");
    await writeFile(path.join(dir, "c.dat"), "changed too\n");
    await writeFile(path.join(dir, "fresh.bin"), "new\n");
    // Stale stat data forces git to look inside the files, which is when a filter runs.
    const when = new Date(Date.now() + 5000);
    for (const file of ["a.txt", "b.bin", "c.dat"]) await utimes(path.join(dir, file), when, when);

    // The trap is live: plain git, asked a similar question, does run it.
    execFileSync("git", plain, { cwd: dir, stdio: "ignore", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_PAGER: "cat" } });
    assert.equal(spy.ran(), true, "the trap fires when nothing guards against it");
    await rm(spy.marker);

    const result = await changes.read(dir);
    assert.deepEqual(result.files.map((file) => file.path).sort(), ["a.txt", "b.bin", "c.dat", "fresh.bin"]);
    assert.equal(entry(result, "a.txt").added, 1);
    assert.equal(spy.ran(), false, `${name} ran during the read`);
  });
}

test("a repository's hooks do not run when the read refreshes its private index", async () => {
  const dir = await repo({ "a.txt": "one\n", "b.txt": "same\n" });
  const spy = await trap("hook");
  const hook = path.join(dir, ".git", "hooks", "post-index-change");
  await mkdir(path.dirname(hook), { recursive: true });
  await writeFile(hook, `#!/bin/sh\necho ran >> '${spy.marker}'\n`);
  await chmod(hook, 0o755);
  await writeFile(path.join(dir, "a.txt"), "two\n");
  // A touched, unchanged file is what makes git write a refreshed index.
  const when = new Date(Date.now() + 5000);
  await utimes(path.join(dir, "b.txt"), when, when);

  // The trap is live: a plain diff refreshes the index and runs the hook.
  execFileSync("git", ["diff", "HEAD"], { cwd: dir, stdio: "ignore", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_PAGER: "cat" } });
  assert.equal(spy.ran(), true, "the hook fires when nothing guards against it");
  await rm(spy.marker);
  const later = new Date(Date.now() + 9000);
  await utimes(path.join(dir, "b.txt"), later, later);

  const result = await changes.read(dir);
  assert.equal(entry(result, "a.txt").added, 1);
  assert.equal(spy.ran(), false, "a hook ran during the read");
});

test("GIT_ variables in the bridge's own environment do not steer git", async () => {
  const dir = await repo({ "a.txt": "1\n" });
  const elsewhere = await repo({ "z.txt": "1\n" });
  const external = await trap("envexternal");
  await writeFile(path.join(dir, "a.txt"), "2\n");
  await writeFile(path.join(elsewhere, "z.txt"), "2\n");
  const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE, GIT_EXTERNAL_DIFF: process.env.GIT_EXTERNAL_DIFF };
  Object.assign(process.env, { GIT_DIR: path.join(elsewhere, ".git"), GIT_WORK_TREE: elsewhere, GIT_EXTERNAL_DIFF: external.script });
  try {
    const result = await changes.read(dir);
    assert.deepEqual(result.files.map((file) => file.path), ["a.txt"]);
    assert.equal(external.ran(), false);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

async function snapshotGitDir(dir) {
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

test("a read changes nothing: no lock, no index refresh, no staging, no new objects", async () => {
  const dir = await repo({ "a.txt": "1\n", "b.txt": "1\n" });
  await writeFile(path.join(dir, "a.txt"), "2\n");
  await writeFile(path.join(dir, "new.txt"), "n\n");
  // A touched file has stale stat data: the exact case where git likes to rewrite the index.
  const when = new Date(Date.now() + 4000);
  await utimes(path.join(dir, "b.txt"), when, when);
  const before = await snapshotGitDir(dir);
  const worktree = await Promise.all(["a.txt", "b.txt", "new.txt"].map(async (name) => readFile(path.join(dir, name), "utf8")));
  await changes.read(dir);
  await changes.read(dir);
  assert.deepEqual(await snapshotGitDir(dir), before);
  assert.equal(existsSync(path.join(dir, ".git", "index.lock")), false);
  assert.deepEqual(await Promise.all(["a.txt", "b.txt", "new.txt"].map(async (name) => readFile(path.join(dir, name), "utf8"))), worktree);
  assert.match(git(dir, "status", "--porcelain"), /\?\? new\.txt/);
});

test("a symbolic link is shown as a link and never followed out of the checkout", async () => {
  const dir = await repo({ "a.txt": "1\n" });
  const outside = await scratch();
  await writeFile(path.join(outside, "secret.txt"), "OUTSIDE_SECRET\n");
  await mkdir(path.join(outside, "dir"));
  await writeFile(path.join(outside, "dir", "inner.txt"), "OUTSIDE_INNER\n");
  await symlink(path.join(outside, "secret.txt"), path.join(dir, "file-link"));
  await symlink(path.join(outside, "dir"), path.join(dir, "dir-link"));
  await symlink("a.txt", path.join(dir, "inside-link"));
  const result = await changes.read(dir);
  assert.deepEqual(result.files.map((file) => file.path).sort(), ["dir-link", "file-link", "inside-link"]);
  assert.ok(!result.patch.includes("OUTSIDE_SECRET"));
  assert.ok(!result.patch.includes("OUTSIDE_INNER"));
  assert.match(patchOf(result, entry(result, "file-link")), /new file mode 120000/);
  assert.match(patchOf(result, entry(result, "inside-link")), /\+a\.txt\n/);
});

test("a path is accepted only while it resolves to somewhere inside the root", async () => {
  const dir = await repo();
  const outside = await scratch();
  await writeFile(path.join(outside, "x.txt"), "x");
  await symlink(outside, path.join(dir, "hop"));
  await symlink(path.join(outside, "x.txt"), path.join(dir, "leaf"));
  await mkdir(path.join(dir, "sub"));
  await writeFile(path.join(dir, "sub", "ok.txt"), "ok");
  const real = await realpath(dir);
  assert.equal(await resolveInside(dir, "sub/ok.txt"), path.join(real, "sub", "ok.txt"));
  // The last component is not followed: a link inside the root is fine even when it points out.
  assert.equal(await resolveInside(dir, "leaf"), path.join(real, "leaf"));
  for (const bad of ["../x.txt", "sub/../../x.txt", "/etc/hostname", "hop/x.txt", "", "sub/", "./sub/ok.txt", "a\0b", "missing/file.txt"]) {
    assert.equal(await resolveInside(dir, bad), null, JSON.stringify(bad));
  }
});

test("a nested repository is listed without content, and a pipe is never opened", async () => {
  const dir = await repo();
  execFileSync("mkfifo", [path.join(dir, "pipe")]);
  await mkdir(path.join(dir, "nested"));
  git(path.join(dir, "nested"), "init", "-q");
  await writeFile(path.join(dir, "nested", "f.txt"), "x");
  git(path.join(dir, "nested"), "add", "f.txt");
  git(path.join(dir, "nested"), "commit", "-q", "-m", "n");
  const result = await changes.read(dir);
  for (const file of result.files) assert.equal(file.omitted, "not-a-file", file.path);
  // The pipe is never listed (git skips it), and was never opened: the read returned.
  assert.deepEqual(result.files.map((file) => file.path), ["nested/"]);
  assert.equal(result.truncated, true);
});

test("the patch is cut on a file boundary at the cap and says which files are missing", async () => {
  const body = (tag) => Array.from({ length: 1500 }, (_, n) => `${tag} line ${n} ${"x".repeat(60)}\n`).join("");
  const files = Object.fromEntries(Array.from({ length: 12 }, (_, n) => [`f${String(n).padStart(2, "0")}.txt`, "base\n"]));
  const dir = await repo(files);
  for (const name of Object.keys(files)) await writeFile(path.join(dir, name), body(name)); // ~110 KiB each
  const big = Object.fromEntries(Array.from({ length: 30 }, (_, n) => [`g${String(n).padStart(2, "0")}.txt`, "base\n"]));
  const wide = await repo(big, { name: "wide" });
  for (const name of Object.keys(big)) await writeFile(path.join(wide, name), body(name).repeat(2));
  const result = await changes.read(wide);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.patch) <= PATCH_CAP);
  assert.ok(result.patch.endsWith("\n"));
  const shown = result.files.filter((file) => file.patch);
  const left = result.files.filter((file) => file.omitted === "patch-cap");
  assert.ok(shown.length >= 10 && left.length >= 1, `${shown.length} shown, ${left.length} left out`);
  assert.equal(shown.length + left.length, 30);
  // Every file that is shown is whole, and ranges tile the patch exactly.
  let at = 0;
  for (const file of shown) {
    assert.equal(file.patch[0], at);
    at = file.patch[1];
    assert.ok(result.patch.slice(...file.patch).endsWith("\n"));
    assert.equal(result.patch.slice(...file.patch).split("\n").filter((line) => line.startsWith("+")).length - 1, file.added);
  }
  assert.equal(at, result.patch.length);
  // Left-out files keep their name, status and (from numstat) their counts.
  for (const file of left) assert.ok(file.added > 0 && !file.patch);
  assert.equal(result.fileCount, 30);
  assert.equal((await changes.read(dir)).truncated, false);
});

test("untracked files count against the patch cap too", async () => {
  const dir = await repo();
  const line = `${"y".repeat(78)}\n`;
  for (let n = 0; n < 8; n += 1) await writeFile(path.join(dir, `n${n}.txt`), line.repeat(Math.floor((UNTRACKED_FILE_CAP - 100) / line.length)));
  const result = await changes.read(dir);
  assert.ok(Buffer.byteLength(result.patch) <= PATCH_CAP);
  assert.equal(result.truncated, true);
  assert.ok(result.files.some((file) => file.patch));
  assert.ok(result.files.some((file) => file.omitted === "patch-cap"));
  assert.equal(result.files.length, 8);
});

test("an untracked file over its own cap is listed without content; a large binary is still binary", async () => {
  const dir = await repo();
  await writeFile(path.join(dir, "huge.txt"), "z".repeat(UNTRACKED_FILE_CAP + 1));
  await writeFile(path.join(dir, "huge.bin"), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.alloc(UNTRACKED_FILE_CAP + 1, 7)]));
  await writeFile(path.join(dir, "ok.txt"), "z".repeat(UNTRACKED_FILE_CAP - 10));
  const result = await changes.read(dir);
  assert.equal(entry(result, "huge.txt").omitted, "too-large");
  assert.equal(entry(result, "huge.txt").patch, undefined);
  assert.equal(entry(result, "huge.bin").binary, true);
  assert.equal(entry(result, "huge.bin").omitted, undefined);
  assert.ok(entry(result, "ok.txt").patch);
  assert.equal(result.truncated, true);
  assert.ok(!result.patch.includes("zzzzzzzzzz".repeat(100)) || result.patch.includes("ok.txt"));
});

test("only the first files are listed past the file cap, and the rest are counted", async () => {
  const dir = await repo();
  const extra = 25;
  for (let n = 0; n < FILE_CAP + extra; n += 1) await writeFile(path.join(dir, `f${String(n).padStart(4, "0")}.txt`), `${n}\n`);
  const result = await changes.read(dir);
  assert.equal(result.files.length, FILE_CAP);
  assert.equal(result.fileCount, FILE_CAP + extra);
  assert.equal(result.truncated, true);
  assert.equal(result.files[0].path, "f0000.txt");
});

test("a slow git is stopped, and a read that is abandoned stops its git", async () => {
  const dir = await repo();
  const bin = path.join(await scratch(), "slow-git");
  await writeFile(bin, "#!/bin/sh\nexec sleep 30\n");
  await chmod(bin, 0o755);
  const started = Date.now();
  await assert.rejects(createChanges({ gitBin: bin, timeoutMs: 150 }).read(dir), { status: 504, code: "changes_timeout" });
  assert.ok(Date.now() - started < 5000);
  await assert.rejects(createChanges({ gitBin: bin, timeoutMs: 60_000, deadlineMs: 150 }).read(dir), { status: 504, code: "changes_timeout" });
  const controller = new AbortController();
  const pending = createChanges({ gitBin: bin, timeoutMs: 60_000 }).read(dir, { signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(pending, (error) => error.name === "AbortError");
});

test("only a few reads run at once", async () => {
  const dir = await repo();
  const bin = path.join(await scratch(), "slow-git");
  await writeFile(bin, "#!/bin/sh\nsleep 1\n");
  await chmod(bin, 0o755);
  const busy = createChanges({ gitBin: bin });
  const running = Array.from({ length: 4 }, () => busy.read(dir));
  await assert.rejects(busy.read(dir), { status: 429, code: "changes_busy", retryAfter: 2 });
  await Promise.all(running);
  assert.deepEqual(await busy.read(dir), { kind: "not-a-checkout" });
});

test("a failing git is an error and no message from it reaches the caller", async () => {
  const dir = await repo();
  await writeFile(path.join(dir, ".git", "index"), "garbage");
  const error = await changes.read(dir).then(() => null, (cause) => cause);
  assert.ok(error);
  assert.ok(!(error instanceof ChangesError));
});

test("diff settings in the repository do not change the shape of the patch", async () => {
  const dir = await repo({ "a.txt": "one\n\ntwo\n" });
  git(dir, "config", "diff.noprefix", "true");
  git(dir, "config", "diff.mnemonicPrefix", "true");
  git(dir, "config", "diff.suppressBlankEmpty", "true");
  git(dir, "config", "color.ui", "always");
  git(dir, "config", "diff.context", "0");
  await writeFile(path.join(dir, "a.txt"), "ONE\n\ntwo\n");
  const result = await changes.read(dir);
  const patch = patchOf(result, entry(result, "a.txt"));
  assert.match(patch, /^diff --git a\/a\.txt b\/a\.txt\n/);
  assert.ok(!patch.includes("\u001b["));
  assert.match(patch, /\n @@|\n@@ -1,3 \+1,3 @@/);
  assert.ok(patch.includes("\n \n two\n"), "the blank context line keeps its space");
});
