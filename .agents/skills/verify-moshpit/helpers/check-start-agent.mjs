import assert from "node:assert/strict";
import { accessSync, constants as fsConstants } from "node:fs";
import { chmod, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHerdr, isHerdrKind, pathKinds } from "../../../../bridge/herdr.mjs";

function canExec(file) {
  try {
    accessSync(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const dir = path.join(tmpdir(), `moshpit-kinds-${process.pid}`);
await rm(dir, { recursive: true, force: true });
await mkdir(dir);
await writeFile(path.join(dir, "pi"), "#!/bin/sh\n");
await writeFile(path.join(dir, "crush"), "#!/bin/sh\n");
await writeFile(path.join(dir, "omp"), "#!/bin/sh\n");
await chmod(path.join(dir, "pi"), 0o755);
await chmod(path.join(dir, "crush"), 0o755);
await chmod(path.join(dir, "omp"), 0o644);
assert.deepEqual(pathKinds(dir, canExec), ["pi"]);
await rm(dir, { recursive: true, force: true });
assert.equal(isHerdrKind("pi"), true);
assert.equal(isHerdrKind("crush"), false);

const herdr = createHerdr({});
const first = await herdr.startAgent({ cwd: "/tmp/x", agentKind: "pi" });
assert.match(first.paneId, /^demo:p/);
const snap = await herdr.snapshot();
assert.ok(Array.isArray(snap.kinds));
assert.ok(!snap.kinds.includes("crush"));
const started = snap.agents.find((agent) => agent.id === first.paneId);
assert.equal(started.kind, "pi");
assert.equal(started.cwd, "/tmp/x");
assert.ok(snap.panes.some((pane) => pane.id === first.paneId));
const second = await herdr.startAgent({ cwd: "/tmp/x", agentKind: "pi" });
assert.notEqual(second.paneId, first.paneId);
await herdr.prompt(first.paneId, "hi");
const after = await herdr.snapshot();
assert.ok(
  after.agents
    .find((agent) => agent.id === first.paneId)
    .lines.some((line) => line.text.includes("hi")),
);
console.log("ok   pathKinds intersects PATH with herdr kinds; demo startAgent adds a pane");
