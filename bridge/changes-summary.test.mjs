import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { COUNT_CAP, MAX_READS, createChanges } from "./changes.mjs";
import { cleanup, git, repo, scratch, snapshotGitDir, trap } from "./git-fixtures.mjs";

// C11: the summary answers "is there work here that closing the pane could
// strand?" with counts only. These run against real temporary repositories;
// the "remote" is a bare repository on disk, so nothing touches a network.

const changes = createChanges();
test.after(cleanup);

const none = { staged: 0, unstaged: 0, uncommitted: 0, untracked: 0, unpushed: 0 };
const counts = (overrides) => ({ ...none, ...overrides });

/** A checkout with a bare repository as `origin`, `main` pushed and tracking it. */
async function pushed(files) {
  const dir = await repo(files);
  const remote = path.join(await scratch(), "origin.git");
  git(dir, "init", "-q", "--bare", remote);
  git(dir, "remote", "add", "origin", remote);
  git(dir, "push", "-q", "-u", "origin", "main");
  return { dir, remote };
}

/** `n` empty commits on top of main's tip, made in one go. */
function manyCommits(dir, n) {
  let stream = "";
  for (let i = 0; i < n; i += 1) {
    stream += `commit refs/heads/main\ncommitter t <t@e> ${1_700_000_000 + i} +0000\ndata 2\nx\n${i === 0 ? "from refs/heads/main^0\n" : ""}\n`;
  }
  execFileSync("git", ["fast-import", "--quiet"], { cwd: dir, input: stream });
}

test("a clean checkout whose branch is pushed has nothing to warn about", async () => {
  const { dir } = await pushed();
  assert.deepEqual(await changes.summary(dir), {
    kind: "checkout",
    branch: "main",
    detached: false,
    counts: none,
    unpushedBasis: "upstream",
    truncated: false,
  });
});

test("each kind of dirtiness shows up alone", async () => {
  const { dir } = await pushed({ "a.txt": "1\n", "b.txt": "1\n" });

  await writeFile(path.join(dir, "a.txt"), "2\n");
  assert.deepEqual((await changes.summary(dir)).counts, counts({ unstaged: 1, uncommitted: 1 }));

  git(dir, "add", "a.txt");
  assert.deepEqual((await changes.summary(dir)).counts, counts({ staged: 1, uncommitted: 1 }));

  // A file edited again after staging is one uncommitted file, both staged and unstaged.
  await writeFile(path.join(dir, "a.txt"), "3\n");
  assert.deepEqual((await changes.summary(dir)).counts, counts({ staged: 1, unstaged: 1, uncommitted: 1 }));
  git(dir, "checkout", "-q", "HEAD", "--", "a.txt");

  await writeFile(path.join(dir, "new.txt"), "n\n");
  await mkdir(path.join(dir, "deep", "er"), { recursive: true });
  await writeFile(path.join(dir, "deep", "er", "x.txt"), "x\n");
  assert.deepEqual((await changes.summary(dir)).counts, counts({ untracked: 2 }));
  await rm(path.join(dir, "new.txt"));
  await rm(path.join(dir, "deep"), { recursive: true });

  await rm(path.join(dir, "b.txt"));
  assert.deepEqual((await changes.summary(dir)).counts, counts({ unstaged: 1, uncommitted: 1 }));
  git(dir, "checkout", "-q", "HEAD", "--", "b.txt");
  // A staged rename is one change, and its second path is not read as another entry.
  git(dir, "mv", "a.txt", "renamed.txt");
  assert.deepEqual((await changes.summary(dir)).counts, counts({ staged: 1, uncommitted: 1 }));
});

test("an unmerged file counts as one uncommitted, unstaged change", async () => {
  const { dir } = await pushed({ "a.txt": "base\n" });
  git(dir, "checkout", "-q", "-b", "other");
  await writeFile(path.join(dir, "a.txt"), "other\n");
  git(dir, "commit", "-q", "-am", "other");
  git(dir, "checkout", "-q", "main");
  await writeFile(path.join(dir, "a.txt"), "main\n");
  git(dir, "commit", "-q", "-am", "main");
  git(dir, "push", "-q");
  assert.throws(() => git(dir, "merge", "other"));
  assert.deepEqual((await changes.summary(dir)).counts, counts({ unstaged: 1, uncommitted: 1 }));
});

test("ignored files are not counted", async () => {
  const { dir } = await pushed({ ".gitignore": "build/\n*.log\n" });
  await mkdir(path.join(dir, "build"));
  await writeFile(path.join(dir, "build", "out.js"), "x\n");
  await writeFile(path.join(dir, "debug.log"), "x\n");
  assert.deepEqual((await changes.summary(dir)).counts, none);
});

test("commits ahead of the upstream are counted, and commits behind are not", async () => {
  const { dir, remote } = await pushed();
  await writeFile(path.join(dir, "one.txt"), "1\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "one");
  await writeFile(path.join(dir, "two.txt"), "2\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "two");
  let result = await changes.summary(dir);
  assert.deepEqual([result.counts, result.unpushedBasis], [counts({ unpushed: 2 }), "upstream"]);

  // Someone else pushes, and this checkout fetches: now ahead 2 and behind 1.
  const other = path.join(await scratch(), "other");
  git(path.dirname(other), "clone", "-q", "-b", "main", remote, other);
  await writeFile(path.join(other, "theirs.txt"), "t\n");
  git(other, "add", "-A");
  git(other, "commit", "-q", "-m", "theirs");
  git(other, "push", "-q");
  git(dir, "fetch", "-q");
  assert.match(git(dir, "status", "--porcelain=v2", "--branch"), /branch\.ab \+2 -1/);
  result = await changes.summary(dir);
  assert.deepEqual([result.counts, result.unpushedBasis], [counts({ unpushed: 2 }), "upstream"]);

  git(dir, "pull", "-q", "--no-rebase", "--no-edit");
  git(dir, "push", "-q");
  assert.deepEqual((await changes.summary(dir)).counts, none);
});

test("it never fetches: a remote that moved on is not noticed, and an unreachable one is not contacted", async () => {
  const { dir, remote } = await pushed();
  const other = path.join(await scratch(), "other");
  git(path.dirname(other), "clone", "-q", "-b", "main", remote, other);
  await writeFile(path.join(other, "theirs.txt"), "t\n");
  git(other, "add", "-A");
  git(other, "commit", "-q", "-m", "theirs");
  git(other, "push", "-q");
  git(dir, "remote", "set-url", "origin", "http://127.0.0.1:1/never.git");
  const refs = git(dir, "for-each-ref");
  const before = await snapshotGitDir(dir);

  const log = path.join(await scratch(), "calls.log");
  const wrapper = path.join(path.dirname(log), "git-wrapper");
  await writeFile(wrapper, `#!/bin/sh\n{ printf '%s\\037' "$@"; printf '\\n'; } >> '${log}'\nexec git "$@"\n`);
  await chmod(wrapper, 0o755);
  const started = Date.now();
  const result = await createChanges({ gitBin: wrapper }).summary(dir);
  assert.ok(Date.now() - started < 5000);
  assert.deepEqual(result.counts, none);

  const verbs = new Set(["rev-parse", "config", "status"]);
  const calls = (await readFile(log, "utf8")).split("\n").filter(Boolean).map((line) => line.split("\u001f").filter(Boolean));
  assert.ok(calls.length >= 4);
  for (const args of calls) {
    for (const setting of ["core.fsmonitor=false", "core.hooksPath=/dev/null"]) {
      assert.ok(args.some((arg, at) => arg === setting && args[at - 1] === "-c"), `${setting} in ${args.join(" ")}`);
    }
    const verb = args.find((arg, at) => args[at - 1] !== "-c" && !arg.startsWith("-"));
    assert.ok(verbs.has(verb), args.join(" "));
  }
  assert.equal(git(dir, "for-each-ref"), refs);
  assert.deepEqual(await snapshotGitDir(dir), before);
  assert.equal(existsSync(path.join(dir, ".git", "FETCH_HEAD")), false);
});

test("a branch with no upstream counts the commits that no remote-tracking ref reaches", async () => {
  const { dir } = await pushed();
  git(dir, "checkout", "-q", "-b", "side");
  // Same commit as origin/main: nothing here exists only here.
  let result = await changes.summary(dir);
  assert.deepEqual([result.counts, result.unpushedBasis, result.branch], [none, "remotes", "side"]);

  await writeFile(path.join(dir, "s1.txt"), "1\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "s1");
  await writeFile(path.join(dir, "s2.txt"), "2\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "s2");
  result = await changes.summary(dir);
  assert.deepEqual([result.counts, result.unpushedBasis], [counts({ unpushed: 2 }), "remotes"]);

  // Pushing the branch (without -u) gives it a remote-tracking ref, which is enough.
  git(dir, "push", "-q", "origin", "side");
  assert.deepEqual((await changes.summary(dir)).counts, none);
});

test("a branch whose upstream ref is gone falls back to the remote-tracking refs", async () => {
  const { dir } = await pushed();
  git(dir, "checkout", "-q", "-b", "feature");
  git(dir, "push", "-q", "-u", "origin", "feature");
  await writeFile(path.join(dir, "f.txt"), "f\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "f");
  assert.equal((await changes.summary(dir)).unpushedBasis, "upstream");
  git(dir, "update-ref", "-d", "refs/remotes/origin/feature");
  const result = await changes.summary(dir);
  // origin/main still holds the first commit; the new one is on no remote ref.
  assert.deepEqual([result.counts, result.unpushedBasis], [counts({ unpushed: 1 }), "remotes"]);
});

test("a repository with no remote at all is local-only, and its commits are not counted", async () => {
  const dir = await repo();
  await writeFile(path.join(dir, "b.txt"), "b\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "second");
  const result = await changes.summary(dir);
  assert.deepEqual([result.counts, result.unpushedBasis], [none, "local-only"]);
  await writeFile(path.join(dir, "b.txt"), "c\n");
  assert.deepEqual((await changes.summary(dir)).counts, counts({ unstaged: 1, uncommitted: 1 }));
});

test("a remote that was never fetched counts every commit as not on a remote", async () => {
  const dir = await repo();
  git(dir, "remote", "add", "origin", "/nonexistent/never-fetched.git");
  const result = await changes.summary(dir);
  assert.deepEqual([result.counts, result.unpushedBasis], [counts({ unpushed: 1 }), "remotes"]);
});

test("a detached HEAD counts the commits that no branch and no remote ref reaches", async () => {
  const { dir } = await pushed();
  git(dir, "checkout", "-q", "--detach");
  let result = await changes.summary(dir);
  assert.deepEqual([result.branch, result.detached, result.counts, result.unpushedBasis], [null, true, none, "detached"]);

  await writeFile(path.join(dir, "d.txt"), "d\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "detached work");
  result = await changes.summary(dir);
  assert.deepEqual([result.counts, result.unpushedBasis], [counts({ unpushed: 1 }), "detached"]);

  // A branch pointing at it makes it reachable from a branch again.
  git(dir, "branch", "keep");
  assert.deepEqual((await changes.summary(dir)).counts, none);
});

test("a detached HEAD in a repository with no remote still counts commits that sit on no branch", async () => {
  const dir = await repo();
  git(dir, "checkout", "-q", "--detach");
  await writeFile(path.join(dir, "d.txt"), "d\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "adrift");
  const result = await changes.summary(dir);
  assert.deepEqual([result.counts, result.unpushedBasis], [counts({ unpushed: 1 }), "detached"]);
});

test("a repository with no commits yet counts what is staged and untracked", async () => {
  const dir = path.join(await scratch(), "fresh");
  await mkdir(dir);
  git(dir, "init", "-q", "-b", "trunk");
  assert.deepEqual(await changes.summary(dir), {
    kind: "checkout",
    branch: "trunk",
    detached: false,
    counts: none,
    unpushedBasis: "no-commits",
    truncated: false,
  });
  await writeFile(path.join(dir, "staged.txt"), "s\n");
  git(dir, "add", "staged.txt");
  await writeFile(path.join(dir, "loose.txt"), "l\n");
  const result = await changes.summary(dir);
  assert.deepEqual([result.counts, result.unpushedBasis], [counts({ staged: 1, uncommitted: 1, untracked: 1 }), "no-commits"]);
});

test("a directory outside any checkout is a clean answer, and a missing one is an error", async () => {
  const plain = await scratch();
  assert.deepEqual(await changes.summary(plain), { kind: "not-a-checkout" });
  const bare = path.join(plain, "bare.git");
  git(plain, "init", "-q", "--bare", bare);
  assert.deepEqual(await changes.summary(bare), { kind: "not-a-checkout" });
  await assert.rejects(changes.summary(path.join(plain, "nope")), { status: 409, code: "changes_directory_missing" });
  const dir = await repo();
  await assert.rejects(createChanges({ gitBin: path.join(plain, "no-such-git") }).summary(dir), { status: 503, code: "changes_git_missing" });
});

test("it reads from a subdirectory and from a linked worktree", async () => {
  const { dir } = await pushed({ "src/deep/x.txt": "x\n" });
  await writeFile(path.join(dir, "src/deep/x.txt"), "y\n");
  assert.deepEqual((await changes.summary(path.join(dir, "src", "deep"))).counts, counts({ unstaged: 1, uncommitted: 1 }));
  const linked = path.join(path.dirname(dir), "linked");
  git(dir, "worktree", "add", "-q", "-b", "side", linked);
  const result = await changes.summary(linked);
  assert.deepEqual([result.branch, result.counts, result.unpushedBasis], ["side", none, "remotes"]);
});

test("submodules are not entered", async () => {
  const inner = await repo({ "lib.txt": "1\n" }, { name: "inner" });
  const { dir } = await pushed({ "a.txt": "x\n" });
  git(dir, "-c", "protocol.file.allow=always", "submodule", "add", "-q", inner, "vendor");
  git(dir, "commit", "-q", "-m", "sub");
  git(dir, "push", "-q");
  await writeFile(path.join(inner, "late.txt"), "late\n");
  await writeFile(path.join(dir, "vendor", "lib.txt"), "2\n");
  await writeFile(path.join(dir, "vendor", "extra.txt"), "e\n");
  assert.deepEqual((await changes.summary(dir)).counts, none);
});

test("a count stops at its cap and the answer says it is a floor", async () => {
  const dir = await repo();
  for (let n = 0; n < COUNT_CAP + 5; n += 1) await writeFile(path.join(dir, `f${n}.txt`), "x\n");
  const result = await changes.summary(dir);
  assert.equal(result.counts.untracked, COUNT_CAP);
  assert.equal(result.truncated, true);

  const long = await repo({ "a.txt": "1\n" }, { name: "long" });
  manyCommits(long, COUNT_CAP + 50);
  git(long, "remote", "add", "origin", "/nonexistent/never-fetched.git");
  const walked = await changes.summary(long);
  assert.equal(walked.counts.unpushed, COUNT_CAP);
  assert.equal(walked.truncated, true);
});

test("a listing too long for the status buffer is cut, not read to the end", async () => {
  const dir = await repo();
  const name = "n".repeat(200);
  for (let n = 0; n < 3000; n += 1) await writeFile(path.join(dir, `${name}${n}`), "");
  const result = await changes.summary(dir);
  assert.equal(result.truncated, true);
  assert.equal(result.counts.untracked, COUNT_CAP);
});

test("tracked changes still show when the untracked listing is cut", async () => {
  const dir = await repo({ "a.txt": "1\n" });
  await writeFile(path.join(dir, "a.txt"), "2\n");
  const name = "n".repeat(200);
  for (let n = 0; n < 3000; n += 1) await writeFile(path.join(dir, `${name}${n}`), "");
  assert.deepEqual((await changes.summary(dir)).counts, counts({ unstaged: 1, uncommitted: 1, untracked: COUNT_CAP }));
});

test("a read changes nothing: no lock, no index refresh, no staging", async () => {
  const { dir } = await pushed({ "a.txt": "1\n", "b.txt": "1\n" });
  await writeFile(path.join(dir, "a.txt"), "2\n");
  await writeFile(path.join(dir, "new.txt"), "n\n");
  const when = new Date(Date.now() + 4000);
  await utimes(path.join(dir, "b.txt"), when, when);
  const before = await snapshotGitDir(dir);
  await changes.summary(dir);
  await changes.summary(dir);
  assert.deepEqual(await snapshotGitDir(dir), before);
  assert.equal(existsSync(path.join(dir, ".git", "index.lock")), false);
  assert.match(git(dir, "status", "--porcelain"), /\?\? new\.txt/);
});

// The settings a repository can use to make `status` run a program.
const PROGRAMS = [
  { name: "core.fsmonitor", attributes: "", set: (t) => [["core.fsmonitor", t]] },
  { name: "a clean filter", attributes: "*.dat filter=spy\n", set: (t) => [["filter.spy.clean", t]] },
  { name: "a filter process", attributes: "*.dat filter=spy\n", set: (t) => [["filter.spy.process", t]] },
  { name: "a clean filter whose name has a dot", attributes: "*.dat filter=my.spy\n", set: (t) => [["filter.my.spy.clean", t]] },
];

for (const { name, attributes, set } of PROGRAMS) {
  test(`a repository cannot make the summary run ${name}`, async () => {
    const dir = await repo({ "a.txt": "one\n", "c.dat": "y\n" });
    const spy = await trap("spy");
    await writeFile(path.join(dir, ".git", "info", "attributes"), attributes);
    for (const [key, value] of set(spy.script)) git(dir, "config", key, value);
    await writeFile(path.join(dir, "a.txt"), "two\n");
    await writeFile(path.join(dir, "c.dat"), "z\n");
    const when = new Date(Date.now() + 5000);
    for (const file of ["a.txt", "c.dat"]) await utimes(path.join(dir, file), when, when);

    // The trap is live: plain git, asked a similar question, does run it.
    execFileSync("git", ["status", "--porcelain"], { cwd: dir, stdio: "ignore", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_PAGER: "cat" } });
    assert.equal(spy.ran(), true, "the trap fires when nothing guards against it");
    await rm(spy.marker);

    const result = await changes.summary(dir);
    assert.deepEqual(result.counts, counts({ unstaged: 2, uncommitted: 2 }));
    assert.equal(spy.ran(), false, `${name} ran during the summary`);
  });
}

test("a repository's hooks do not run when the summary refreshes its private index", async () => {
  const dir = await repo({ "a.txt": "one\n", "b.txt": "same\n" });
  const spy = await trap("hook");
  const hook = path.join(dir, ".git", "hooks", "post-index-change");
  await mkdir(path.dirname(hook), { recursive: true });
  await writeFile(hook, `#!/bin/sh\necho ran >> '${spy.marker}'\n`);
  await chmod(hook, 0o755);
  await writeFile(path.join(dir, "a.txt"), "two\n");
  const when = new Date(Date.now() + 5000);
  await utimes(path.join(dir, "b.txt"), when, when);

  execFileSync("git", ["status", "--porcelain"], { cwd: dir, stdio: "ignore", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_PAGER: "cat" } });
  assert.equal(spy.ran(), true, "the hook fires when nothing guards against it");
  await rm(spy.marker);
  const later = new Date(Date.now() + 9000);
  await utimes(path.join(dir, "b.txt"), later, later);

  assert.equal((await changes.summary(dir)).counts.unstaged, 1);
  assert.equal(spy.ran(), false, "a hook ran during the summary");
});

test("GIT_ variables in the bridge's own environment do not steer git", async () => {
  const dir = await repo({ "a.txt": "1\n" });
  const elsewhere = await repo({ "z.txt": "1\n" });
  await writeFile(path.join(dir, "a.txt"), "2\n");
  await writeFile(path.join(elsewhere, "z.txt"), "2\n");
  await writeFile(path.join(elsewhere, "z2.txt"), "2\n");
  const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
  Object.assign(process.env, { GIT_DIR: path.join(elsewhere, ".git"), GIT_WORK_TREE: elsewhere });
  try {
    assert.deepEqual((await changes.summary(dir)).counts, counts({ unstaged: 1, uncommitted: 1 }));
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("a slow git is stopped, and an abandoned summary stops its git", async () => {
  const dir = await repo();
  const bin = path.join(await scratch(), "slow-git");
  await writeFile(bin, "#!/bin/sh\nexec sleep 30\n");
  await chmod(bin, 0o755);
  const started = Date.now();
  await assert.rejects(createChanges({ gitBin: bin, timeoutMs: 150 }).summary(dir), { status: 504, code: "changes_timeout" });
  assert.ok(Date.now() - started < 5000);
  await assert.rejects(createChanges({ gitBin: bin, timeoutMs: 60_000, deadlineMs: 150 }).summary(dir), { status: 504, code: "changes_timeout" });
  const controller = new AbortController();
  const pending = createChanges({ gitBin: bin, timeoutMs: 60_000 }).summary(dir, { signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(pending, (error) => error.name === "AbortError");
});

test("summaries and full reads share one limit", async () => {
  const dir = await repo();
  const bin = path.join(await scratch(), "slow-git");
  await writeFile(bin, "#!/bin/sh\nsleep 1\n");
  await chmod(bin, 0o755);
  const busy = createChanges({ gitBin: bin });
  const running = Array.from({ length: MAX_READS }, (_, n) => (n % 2 ? busy.read(dir) : busy.summary(dir)));
  await assert.rejects(busy.summary(dir), { status: 429, code: "changes_busy", retryAfter: 2 });
  await assert.rejects(busy.read(dir), { status: 429, code: "changes_busy" });
  await Promise.all(running);
  assert.deepEqual(await busy.summary(dir), { kind: "not-a-checkout" });
});

test("a failing git is an error and no message from it reaches the caller", async () => {
  const dir = await repo();
  await writeFile(path.join(dir, ".git", "index"), "garbage");
  const error = await changes.summary(dir).then(() => null, (cause) => cause);
  assert.ok(error);
  assert.equal(error.code, undefined);
});
