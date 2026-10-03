import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { after, test } from "node:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CommandScopeError, ScanStoppedError, projectToken, scanAgentCommands, scopedCatalog } from "./commands.mjs";
import { createHerdr, run } from "./herdr.mjs";
import { createProjectResolver } from "./projects.mjs";

const writeTree = async (file, body) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body);
};
const agent = (over = {}) => ({
  id: "w1:p1",
  kind: "claude",
  cwd: "/repo/app",
  projectRoot: null,
  sessionId: "sess-1",
  ...over,
});
const snapshotOf = (agents) => ({ agents });
const staticSnapshot = (agents) => async () => snapshotOf(agents);

test("a scoped catalog binds the pane, its session and its project", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "moshpit-scoped-"));
  await writeTree(path.join(home, ".claude", "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: Ship it.\n---\n");
  const calls = [];
  const snapshot = async (options) => {
    calls.push(options);
    return snapshotOf([agent()]);
  };
  const catalog = await scopedCatalog({ snapshot, target: "w1:p1", sessionId: "sess-1", home });
  assert.deepEqual(catalog.scope, {
    target: "w1:p1",
    sessionId: "sess-1",
    project: JSON.stringify([null, "/repo/app"]),
  });
  assert.equal(catalog.coverage, "partial");
  assert.equal(catalog.truncated, false);
  assert.deepEqual(catalog.prefixes, ["/"]);
  assert.deepEqual(catalog.commands, [{ name: "deploy", invocation: "/deploy", description: "Ship it.", origin: "home-skills" }]);
  assert.match(catalog.revision, /^[0-9a-f]{64}$/);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((options) => options.freshProjectFor === "w1:p1" && options.targeted === true));
  await rm(home, { recursive: true, force: true });
});

test("an unknown pane is a 404-class refusal, before any scan", async () => {
  await assert.rejects(
    scopedCatalog({ snapshot: staticSnapshot([agent()]), target: "w9:p9", sessionId: "sess-1" }),
    (error) => error instanceof CommandScopeError && error.code === "command_target_unknown",
  );
});

test("a missing or unequal native session is a scope change", async () => {
  await assert.rejects(
    scopedCatalog({ snapshot: staticSnapshot([agent()]), target: "w1:p1", sessionId: "other" }),
    (error) => error instanceof CommandScopeError && error.code === "command_scope_changed",
  );
  await assert.rejects(
    scopedCatalog({ snapshot: staticSnapshot([agent({ sessionId: undefined })]), target: "w1:p1", sessionId: "sess-1" }),
    (error) => error instanceof CommandScopeError && error.code === "command_scope_changed",
  );
});

test("a pane without a usable cwd is refused on the bridge", async () => {
  for (const over of [{ cwd: "" }, { cwd: undefined }]) {
    await assert.rejects(
      scopedCatalog({ snapshot: staticSnapshot([agent(over)]), target: "w1:p1", sessionId: "sess-1" }),
      (error) => error instanceof CommandScopeError && error.code === "command_scope_changed",
    );
  }
});

test("a post-scan identity change publishes nothing", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "moshpit-scoped-"));
  const flip = (change) => {
    let first = true;
    return async () => {
      const value = first ? agent() : { ...agent(), ...change };
      first = false;
      return snapshotOf([value]);
    };
  };
  for (const change of [
    { sessionId: "sess-2" },
    { cwd: "/repo/other" },
    { projectRoot: "/repo" },
    { kind: "codex" },
  ]) {
    await assert.rejects(
      scopedCatalog({ snapshot: flip(change), target: "w1:p1", sessionId: "sess-1", home }),
      (error) => error instanceof CommandScopeError && error.code === "command_scope_changed",
      JSON.stringify(change),
    );
  }
  let calls = 0;
  const vanish = async () => {
    calls += 1;
    return calls === 1 ? snapshotOf([agent()]) : snapshotOf([]);
  };
  await assert.rejects(
    scopedCatalog({ snapshot: vanish, target: "w1:p1", sessionId: "sess-1", home }),
    (error) => error instanceof CommandScopeError && error.code === "command_scope_changed",
  );
  await rm(home, { recursive: true, force: true });
});

test("a kind with no fixed sources answers unsupported, not an error", async () => {
  const catalog = await scopedCatalog({
    snapshot: staticSnapshot([agent({ kind: "qwen" })]),
    target: "w1:p1",
    sessionId: "sess-1",
  });
  assert.equal(catalog.coverage, "unsupported");
  assert.deepEqual(catalog.commands, []);
  assert.deepEqual(catalog.prefixes, []);
});

test("an aborted signal stops even the unsupported answer", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    scopedCatalog({
      snapshot: staticSnapshot([agent({ kind: "qwen" })]),
      target: "w1:p1",
      sessionId: "sess-1",
      signal: controller.signal,
    }),
    (error) => error instanceof ScanStoppedError && error.reason === "aborted",
  );
});

test("the revision changes with the inventory the scan inspected", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "moshpit-scoped-"));
  const first = await scopedCatalog({
    snapshot: staticSnapshot([agent()]),
    target: "w1:p1",
    sessionId: "sess-1",
    home,
  });
  await writeTree(path.join(home, ".claude", "skills", "extra", "SKILL.md"), "---\nname: extra\ndescription: More.\n---\n");
  const second = await scopedCatalog({
    snapshot: staticSnapshot([agent()]),
    target: "w1:p1",
    sessionId: "sess-1",
    home,
  });
  assert.notEqual(second.revision, first.revision);
  await rm(home, { recursive: true, force: true });
});

test("the project token is the existing snapshot metadata, serialized identically", () => {
  assert.equal(projectToken({ projectRoot: undefined, cwd: "/a" }), JSON.stringify([null, "/a"]));
  assert.equal(projectToken({ projectRoot: "/repo", cwd: "/repo/app" }), JSON.stringify(["/repo", "/repo/app"]));
});

// --- fake herdr: the shared deadline covers the read-only subprocess waits,
// and an abort or timeout kills the owned child instead of leaving it.
// FAKE_HERDR_HANG names which "api snapshot" call hangs: first or second.

const FAKE_HERDR = `
import { readFileSync, writeFileSync } from "node:fs";
const [cmd, sub] = process.argv.slice(2);
if (cmd === "api" && sub === "snapshot") {
  const counter = process.env.FAKE_HERDR_COUNTER;
  let n;
  try { n = Number(readFileSync(counter, "utf8")) + 1; } catch { n = 1; }
  writeFileSync(counter, String(n));
  if (process.env.FAKE_HERDR_HANG === String(n)) {
    process.on("SIGTERM", () => {
      writeFileSync(process.env.FAKE_HERDR_KILLED, "killed");
      process.exit(143);
    });
    setInterval(() => {}, 1000);
  } else {
    process.stdout.write(JSON.stringify({ result: { snapshot: { agents: [{
      pane_id: "w1:p1", agent: "claude", agent_status: "idle", cwd: "/repo/app",
      workspace_id: "w1", agent_session: { kind: "id", value: "sess-1" },
    }] } } }));
    process.exit(0);
  }
} else {
  process.stdout.write("{}");
}
`;

async function fakeHerdr(hang) {
  const dir = await mkdtemp(path.join(tmpdir(), "moshpit-fake-herdr-"));
  const bin = path.join(dir, "herdr");
  await writeFile(bin, `#!${process.execPath}\n${FAKE_HERDR}`);
  await chmod(bin, 0o755);
  const saved = {};
  const env = {
    FAKE_HERDR_COUNTER: path.join(dir, "counter"),
    FAKE_HERDR_KILLED: path.join(dir, "killed"),
    FAKE_HERDR_HANG: hang,
  };
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  const herdr = createHerdr({ bin });
  return {
    dir,
    herdr,
    killed: path.join(dir, "killed"),
    restore: () => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

test("a hung pre-scan snapshot stops the scoped request; the child is killed", { timeout: 10000 }, async () => {
  const fake = await fakeHerdr("1");
  try {
    await assert.rejects(
      scopedCatalog({
        snapshot: (options) => fake.herdr.snapshot(options),
        target: "w1:p1",
        sessionId: "sess-1",
        signal: AbortSignal.timeout(400),
        deadlineMs: 400,
      }),
      (error) => error instanceof ScanStoppedError && error.reason === "aborted",
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(await readFile(fake.killed, "utf8").catch(() => ""), "killed", "the owned herdr child was terminated");
  } finally {
    fake.restore();
    await rm(fake.dir, { recursive: true, force: true });
  }
});

test("a hung post-scan snapshot publishes nothing", { timeout: 10000 }, async () => {
  const fake = await fakeHerdr("2");
  const home = await mkdtemp(path.join(tmpdir(), "moshpit-scoped-home-"));
  try {
    await assert.rejects(
      scopedCatalog({
        snapshot: (options) => fake.herdr.snapshot(options),
        target: "w1:p1",
        sessionId: "sess-1",
        home,
        signal: AbortSignal.timeout(400),
        deadlineMs: 400,
      }),
      (error) => error instanceof ScanStoppedError && error.reason === "aborted",
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(await readFile(fake.killed, "utf8").catch(() => ""), "killed", "the owned herdr child was terminated");
  } finally {
    fake.restore();
    await rm(fake.dir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("an abort during a snapshot wait kills the child and rejects", { timeout: 10000 }, async () => {
  const fake = await fakeHerdr("1");
  try {
    const controller = new AbortController();
    const pending = scopedCatalog({
      snapshot: (options) => fake.herdr.snapshot(options),
      target: "w1:p1",
      sessionId: "sess-1",
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    await assert.rejects(pending, (error) => error instanceof ScanStoppedError && error.reason === "aborted");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(await readFile(fake.killed, "utf8").catch(() => ""), "killed", "the owned herdr child was terminated");
  } finally {
    fake.restore();
    await rm(fake.dir, { recursive: true, force: true });
  }
});

// The targeted read is a target identity/project read: an unrelated
// FIFO-backed pi session and an unrelated hanging project lookup must not
// hold discovery up.

const TARGETED_HERDR = `
import { appendFileSync } from "node:fs";
const [cmd, sub] = process.argv.slice(2);
appendFileSync(process.env.FAKE_HERDR_LOG, cmd + " " + sub + "\\n");
if (cmd === "api" && sub === "snapshot") {
  process.stdout.write(JSON.stringify({ result: { snapshot: { agents: [
    { pane_id: "w1:p1", agent: "claude", agent_status: "idle", cwd: "/repo/app",
      workspace_id: "w1", agent_session: { kind: "id", value: "sess-1" } },
    { pane_id: "w2:p1", agent: "pi", agent_status: "idle", cwd: "/repo/other",
      workspace_id: "w2", agent_session: { kind: "path", value: process.env.FAKE_HERDR_FIFO } },
  ] } } }));
  process.exit(0);
}
if (cmd === "worktree" && sub === "list") {
  const cwd = process.argv[process.argv.indexOf("--cwd") + 1];
  if (cwd !== "/repo/app") setInterval(() => {}, 1000);
  process.stdout.write(JSON.stringify({ result: { worktrees: [{ path: "/repo", branch: "main", is_detached: false }] } }));
  process.exit(0);
}
process.stdout.write("{}");
`;

test("the targeted read never opens session files, lists panes or resolves unrelated projects", { timeout: 10000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "moshpit-targeted-herdr-"));
  const bin = path.join(dir, "herdr");
  const log = path.join(dir, "calls.log");
  const fifo = path.join(dir, "session.jsonl");
  await new Promise((resolve, reject) => execFile("mkfifo", [fifo], (error) => (error ? reject(error) : resolve())));
  await writeFile(bin, `#!${process.execPath}\n${TARGETED_HERDR}`);
  await chmod(bin, 0o755);
  const home = await mkdtemp(path.join(tmpdir(), "moshpit-targeted-home-"));
  await writeTree(path.join(home, ".claude", "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: Ship it.\n---\n");
  const saved = {};
  for (const [key, value] of Object.entries({ FAKE_HERDR_LOG: log, FAKE_HERDR_FIFO: fifo })) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  const herdr = createHerdr({ bin });
  try {
    const catalog = await scopedCatalog({
      snapshot: (options) => herdr.snapshot(options),
      target: "w1:p1",
      sessionId: "sess-1",
      home,
      signal: AbortSignal.timeout(4000),
      deadlineMs: 4000,
    });
    assert.equal(catalog.commands.length, 1);
    assert.equal(catalog.scope.project, JSON.stringify(["/repo", "/repo/app"]));
    const calls = (await readFile(log, "utf8")).trim().split("\n");
    assert.deepEqual(calls.filter((call) => call.startsWith("pane list")), [], "no pane list on the targeted read");
    assert.deepEqual(calls.filter((call) => call.startsWith("api snapshot")), ["api snapshot", "api snapshot"]);
    assert.deepEqual(calls.filter((call) => call.startsWith("worktree list")), ["worktree list", "worktree list"]);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

// --- owned child lifecycle: an already-aborted signal rejects before any
// spawn; an abort escalates SIGTERM to SIGKILL; scoped reads cap output.

const STUB_DIR = await mkdtemp(path.join(tmpdir(), "moshpit-stubs-"));
after(async () => {
  await rm(STUB_DIR, { recursive: true, force: true });
});
const stub = async (name, body) => {
  const bin = path.join(STUB_DIR, name);
  await writeFile(bin, `#!${process.execPath}\n${body}`);
  await chmod(bin, 0o755);
  return bin;
};

test("an already-aborted signal rejects before spawning, missing binary or not", async () => {
  const started = path.join(STUB_DIR, "started");
  const bin = await stub(
    "herdr",
    `require("fs").writeFileSync(${JSON.stringify(started)}, "started");\nsetInterval(() => {}, 1000);`,
  );
  for (const candidate of [bin, "/nonexistent/herdr-binary"]) {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(run(candidate, [], controller.signal), (error) => /aborted/.test(error.message));
  }
  assert.equal(await readFile(started, "utf8").catch(() => ""), "", "no child was spawned");
});

test("an abort escalates to SIGKILL and the child actually stops", { timeout: 15000 }, async () => {
  const ticks = path.join(STUB_DIR, "ticks");
  const bin = await stub(
    "stub",
    `
const fs = require("fs");
process.on("SIGTERM", () => {});
setInterval(() => {
  try { fs.appendFileSync(process.env.STUB_TICKS, "t"); } catch {}
}, 20);
`,
  );
  const saved = process.env.STUB_TICKS;
  process.env.STUB_TICKS = ticks;
  try {
    const controller = new AbortController();
    const pending = run(bin, [], controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 150));
    controller.abort();
    await assert.rejects(pending, (error) => /aborted/.test(error.message));
    await new Promise((resolve) => setTimeout(resolve, 700));
    const count = () => readFile(ticks, "utf8").then((s) => s.length).catch(() => 0);
    const first = await count();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const second = await count();
    assert.equal(second, first, "the SIGTERM-resistant child stopped after the grace kill");
  } finally {
    if (saved === undefined) delete process.env.STUB_TICKS;
    else process.env.STUB_TICKS = saved;
    await rm(ticks, { force: true });
  }
});

test("scoped reads cap retained child output", async () => {
  const bin = await stub("big", `process.stdout.write("x".repeat(3 * 1024 * 1024));`);
  const out = await run(bin, [], new AbortController().signal);
  assert.ok(out.length < 2 * 1024 * 1024, `retained ${out.length} of 3145728 bytes`);
});

test("the project resolver bypasses its cache only for the targeted lookup", async () => {
  const calls = [];
  const listWorktrees = async (cwd, signal) => {
    calls.push([cwd, signal]);
    return { worktrees: [{ path: "/repo", branch: "main", is_detached: false }] };
  };
  const resolve = createProjectResolver(listWorktrees);
  const first = await resolve("/repo/app");
  const cached = await resolve("/repo/app");
  assert.equal(first.root, "/repo");
  assert.equal(cached, first, "ordinary polling keeps the cache");
  assert.equal(calls.length, 1);
  const fresh = await resolve("/repo/app", { fresh: true });
  assert.equal(fresh.root, "/repo");
  assert.equal(calls.length, 2, "the targeted lookup bypasses the cache");
  const after = await resolve("/repo/app");
  assert.equal(after, fresh, "the fresh result replaces the cached one");
  assert.equal(calls.length, 2);
});

test("an aborted scoped lookup keeps the cached root and never shares its promise", async () => {
  const calls = [];
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const listWorktrees = async (cwd, signal) => {
    calls.push(cwd);
    if (signal) {
      await new Promise((resolve, reject) => {
        if (signal.aborted) return reject(new Error("aborted"));
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        gate.then(resolve);
      });
    }
    return { worktrees: [{ path: "/repo", branch: "main", is_detached: false }] };
  };
  const resolve = createProjectResolver(listWorktrees);
  const first = await resolve("/repo/app");
  assert.equal(first.root, "/repo");
  const controller = new AbortController();
  const scoped = resolve("/repo/app", { fresh: true, signal: controller.signal });
  const normal = await resolve("/repo/app");
  assert.equal(normal, first, "ordinary polling did not reuse the signal-bound promise");
  controller.abort();
  await assert.rejects(scoped, (error) => /aborted/.test(error.message));
  const after = await resolve("/repo/app");
  assert.equal(after, first, "the aborted scoped lookup left the cached root in place");
  assert.equal(calls.length, 2, "the ordinary lookup ran its own worktree read");
  release();
});

// --- whole-read ownership: directory reads, iterator cleanup and closes
// stay on the shared stop; late results are observed, never unhandled.

test("a stalled directory read stops the scan at the deadline", { timeout: 10000 }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), "moshpit-s8-dirwait-"));
  const target = path.join(home, ".claude", "skills");
  await mkdir(target, { recursive: true });
  const { Dir } = await import("node:fs");
  const nativeRead = Dir.prototype.read;
  const nativeIterator = Dir.prototype[Symbol.asyncIterator];
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error?.code ?? String(error));
  process.on("unhandledRejection", onUnhandled);
  let entered = 0;
  Dir.prototype.read = function (callback) {
    if (this.path !== target) return nativeRead.apply(this, arguments);
    if (typeof callback === "function") return;
    return new Promise(() => {});
  };
  Dir.prototype[Symbol.asyncIterator] = function () {
    if (this.path !== target) return nativeIterator.call(this);
    entered += 1;
    return { next: () => new Promise(() => {}) };
  };
  const started = Date.now();
  try {
    await assert.rejects(
      scanAgentCommands({ kind: "claude", home, signal: AbortSignal.timeout(100), deadlineMs: 100 }),
      (error) => error instanceof ScanStoppedError,
    );
    assert.ok(Date.now() - started < 900, "the shared stop won, not an outer timeout");
    assert.ok(entered > 0, "the probe reached the real directory read");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(unhandled, [], "the pending read stayed observed");
  } finally {
    Dir.prototype.read = nativeRead;
    Dir.prototype[Symbol.asyncIterator] = nativeIterator;
    process.removeListener("unhandledRejection", onUnhandled);
    await rm(home, { recursive: true, force: true });
  }
});

test("a stalled close after a timed-out stat does not hold the caller", { timeout: 10000 }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), "moshpit-s8-closewait-"));
  const file = path.join(home, ".claude", "skills", "probe", "SKILL.md");
  await writeTree(file, "---\ndescription: Probe.\n---\n");
  // The default export is the mutable CJS module; syncBuiltinESMExports makes
  // the patch visible to the ESM binding commands.mjs imports.
  const fs = (await import("node:fs/promises")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const nativeOpen = fs.open;
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error?.code ?? String(error));
  process.on("unhandledRejection", onUnhandled);
  let closes = 0;
  const realCloses = [];
  fs.open = async (...args) => {
    const fd = await nativeOpen(...args);
    if (args[0] === file) {
      realCloses.push(fd.close.bind(fd));
      fd.stat = () => new Promise(() => {});
      fd.close = () => {
        closes += 1;
        return new Promise(() => {});
      };
    }
    return fd;
  };
  syncBuiltinESMExports();
  const started = Date.now();
  try {
    await assert.rejects(
      scanAgentCommands({ kind: "claude", home, signal: AbortSignal.timeout(100), deadlineMs: 100 }),
      (error) => error instanceof ScanStoppedError,
    );
    assert.ok(Date.now() - started < 900, "cleanup did not hold the bounded caller");
    assert.ok(closes > 0, "the descriptor close was attempted");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(unhandled, [], "the stalled close stayed observed");
  } finally {
    fs.open = nativeOpen;
    syncBuiltinESMExports();
    process.removeListener("unhandledRejection", onUnhandled);
    for (const close of realCloses) await close().catch(() => {});
    await rm(home, { recursive: true, force: true });
  }
});

test("an expired wait observes its already-started operation", { timeout: 10000 }, async () => {
  const fs = (await import("node:fs/promises")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const native = fs.realpath;
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error?.code ?? String(error));
  process.on("unhandledRejection", onUnhandled);
  let launched = false;
  fs.realpath = () => {
    launched = true;
    return new Promise((resolve, reject) =>
      setTimeout(() => reject(Object.assign(new Error("injected late filesystem failure"), { code: "EIO" })), 50),
    );
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      scanAgentCommands({
        kind: "claude",
        home: "/tmp/owned-race-fixture",
        deadlineMs: 100,
        now: () => (launched ? 101 : 0),
      }),
      (error) => error instanceof ScanStoppedError && error.reason === "deadline",
    );
    assert.ok(launched, "the operation started before the deadline expired");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(unhandled, [], "the late rejection was observed");
  } finally {
    fs.realpath = native;
    syncBuiltinESMExports();
    process.removeListener("unhandledRejection", onUnhandled);
  }
});
