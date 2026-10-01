import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { boundaryEnv, freePort, isolatedEnv, pairDevice, passwordEnv } from "../../../../bridge/test-support.mjs";

// V1 companion-shell and worktree evidence against a real herdr, never the
// user's: a disposable *named* herdr session (MOSHPIT_PROBE_SESSION) that this
// check starts, drives through an isolated bridge, and deletes. `agent start`
// is refused by the wrapper, so no coding agent is ever launched; that is also
// the worktree's "agent failed to start" path.
//
//   MOSHPIT_PROBE_SESSION=moshpit-probe node check-shell-real.mjs <evidence-dir>
//
// Exits 77 (blocked) when it cannot run: no session name, the default session
// named, no herdr, or no evidence directory.

const BLOCKED = 77;
const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const session = process.env.MOSHPIT_PROBE_SESSION;
const evidence = process.argv[2];
if (!session || session === "default" || !/^[a-z][a-z0-9-]{0,40}$/.test(session) || !evidence) {
  console.log("blocked: set MOSHPIT_PROBE_SESSION to a disposable session name and pass an evidence directory");
  process.exit(BLOCKED);
}
try { await run("herdr", ["--version"]); } catch {
  console.log("blocked: herdr is not installed");
  process.exit(BLOCKED);
}

// Inside a herdr pane the HERDR_* variables would point every call at the
// user's own session; strip them so only --session decides.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("HERDR_")));
const herdr = (...args) => run("herdr", ["--session", session, ...args], { env }).then((r) => JSON.parse(r.stdout));
const panes = async () => (await herdr("pane", "list")).result.panes;
const results = [];
const record = (caseId, ok, detail) => {
  results.push({ caseId, status: ok ? "pass" : "fail", detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${caseId}: ${detail}`);
};

await mkdir(evidence, { recursive: true });
const dir = await mkdtemp(path.join(tmpdir(), "moshpit-shell-real-"));
let client;
let bridge;
try {
  // The session: a headless client starts its server, then leaves.
  // A pty with no size makes herdr's terminal backend refuse new tabs.
  client = spawn("script", ["-qfc", `stty cols 160 rows 48; herdr session attach ${session}`, "/dev/null"], { env: { ...env, TERM: "xterm-256color" }, stdio: "ignore" });
  for (let i = 0; ; i++) {
    try { await panes(); break; } catch { if (i > 40) throw new Error("the probe session never started"); await new Promise((r) => setTimeout(r, 250)); }
  }

  // A disposable repository with uncommitted work in it.
  const repo = path.join(dir, "repo");
  await mkdir(repo);
  const git = (...args) => run("git", ["-C", repo, ...args]).then((r) => r.stdout.trim());
  await git("init", "-q", "-b", "main");
  await git("-c", "user.email=probe@example.invalid", "-c", "user.name=probe", "commit", "-q", "--allow-empty", "-m", "base");
  await writeFile(path.join(repo, "dirty.txt"), "uncommitted work\n");
  const statusBefore = await git("status", "--porcelain");

  const wrapper = path.join(dir, "herdr-probe");
  await writeFile(wrapper, `#!/usr/bin/env bash
if [ "$1" = agent ] && [ "$2" = start ]; then echo '{"error":{"code":"probe_refused","message":"agent start is refused in this probe"}}'; exit 1; fi
exec env ${Object.keys(process.env).filter((k) => k.startsWith("HERDR_")).map((k) => `-u ${k}`).join(" ")} herdr --session ${session} "$@"
`, { mode: 0o700 });

  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const startBridge = async () => {
    const child = spawn(process.execPath, [path.join(root, "bridge/index.mjs")], {
      env: { ...isolatedEnv(), ...boundaryEnv(port), ...await passwordEnv(dir, "probe-pass"), MOSHPIT_STATE_DIR: path.join(dir, "state"), MOSHPIT_HERDR_BIN: wrapper },
      stdio: ["ignore", "ignore", process.env.CHECK_SHELL_DEBUG ? "inherit" : "ignore"],
    });
    for (let i = 0; ; i++) {
      try { await fetch(`${origin}/api/vapid`, { headers: { origin } }); return child; } catch {
        if (child.exitCode !== null || i > 100) throw new Error("bridge did not start");
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  };
  bridge = await startBridge();
  const login = async () => {
    const res = await fetch(`${origin}/api/login`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ password: "probe-pass" }) });
    return { origin, authorization: `Bearer ${(await res.json()).token}` };
  };
  let headers = await login();
  const device = await pairDevice(origin, headers, { stateDir: path.join(dir, "state") });
  headers = { ...headers, "x-moshpit-device": device };
  const action = async (body) => {
    const res = await fetch(`${origin}/api/action`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  const [neighbour] = await panes();

  // Creation and reuse.
  const first = await action({ kind: "open-shell", cwd: repo });
  const again = await action({ kind: "open-shell", cwd: repo });
  const shellPane = first.body?.paneId;
  record("V1-shell-create", first.status === 200 && (await panes()).some((p) => p.pane_id === shellPane && p.label === "moshpit shell"), `open-shell → ${first.status} ${shellPane ?? JSON.stringify(first.body)}`);
  record("V1-shell-reuse", Boolean(shellPane) && again.body?.paneId === shellPane, `second open-shell for the same directory → ${again.body?.paneId}`);

  // Input isolation: typed text runs in the shell's directory only.
  const typed = await action({ kind: "keys", target: shellPane, keys: [{ text: "echo SHELL_OK > shell-marker.txt" }, "enter"] });
  let marker = false;
  for (let i = 0; i < 40 && !marker; i++) { marker = existsSync(path.join(repo, "shell-marker.txt")); if (!marker) await new Promise((r) => setTimeout(r, 100)); }
  const neighbourText = (await run("herdr", ["--session", session, "pane", "read", neighbour.pane_id], { env })).stdout;
  record("V1-shell-input-isolation", typed.status === 200 && marker && !neighbourText.includes("SHELL_OK"), `keys → ${typed.status}; marker in repo: ${marker}; neighbour pane saw it: ${neighbourText.includes("SHELL_OK")}`);
  await rm(path.join(repo, "shell-marker.txt"), { force: true });

  // Bridge restart: the shell is re-adopted by its label, not duplicated.
  bridge.kill("SIGKILL");
  await new Promise((r) => bridge.once("exit", r));
  bridge = await startBridge();
  headers = { ...(await login()), "x-moshpit-device": device };
  const adopted = await action({ kind: "open-shell", cwd: repo });
  const shellCount = (await panes()).filter((p) => p.label === "moshpit shell").length;
  record("V1-shell-bridge-restart", adopted.body?.paneId === shellPane && shellCount === 1, `after restart open-shell → ${adopted.body?.paneId}; labelled shells: ${shellCount}`);

  // A shell pane closed behind the bridge's back is recreated, not resurrected.
  await herdr("pane", "close", shellPane);
  const recreated = await action({ kind: "open-shell", cwd: repo });
  record("V1-shell-stale-recreate", recreated.status === 200 && recreated.body?.paneId && recreated.body.paneId !== shellPane, `after an outside close → ${recreated.body?.paneId}`);

  // Close isolation: closing the shell leaves its neighbour.
  const closed = await action({ kind: "close", target: recreated.body.paneId });
  const left = await panes();
  record("V1-shell-close-isolation", closed.status === 200 && !left.some((p) => p.pane_id === recreated.body.paneId) && left.some((p) => p.pane_id === neighbour.pane_id), `close → ${closed.status}; neighbour kept: ${left.some((p) => p.pane_id === neighbour.pane_id)}`);

  // Worktree launch in the dirty repository.
  const start = (checkout) => action({ kind: "start", cwd: repo, agentKind: "codex", ...(checkout ? { checkout } : {}) });
  const badRef = await start({ baseRef: "no-such-ref", branch: "probe-a" });
  record("V1-worktree-invalid-ref", badRef.status === 400, `unknown base ref → ${badRef.status}`);
  const badName = await start({ baseRef: "main", branch: "bad..name" });
  record("V1-worktree-invalid-branch", badName.status === 400, `invalid branch → ${badName.status}`);
  const launched = await start({ baseRef: "main", branch: "probe-wt" });
  const worktrees = await git("worktree", "list", "--porcelain");
  const retained = launched.body?.partial?.path;
  record("V1-worktree-retained-after-failure", launched.status === 422 && worktrees.includes("probe-wt"), `agent start refused → ${launched.status}; worktree kept: ${worktrees.includes("probe-wt")}`);
  const collision = await start({ baseRef: "main", branch: "probe-wt" });
  record("V1-worktree-collision", collision.status === 400, `same branch again → ${collision.status}`);
  // The client retries a partial launch as a plain start in the retained
  // checkout; that must not create another worktree or branch.
  const branchesBefore = await git("branch", "--list");
  const retry = retained ? await action({ kind: "start", cwd: retained, agentKind: "codex" }) : null;
  record("V1-worktree-retry-reuses", Boolean(retained) && (await git("worktree", "list", "--porcelain")) === worktrees && (await git("branch", "--list")) === branchesBefore, `retry in ${retained} → ${retry?.status} (agent start is refused here); worktrees and branches unchanged`);
  record("V1-worktree-original-untouched", (await git("status", "--porcelain")) === statusBefore && (await readFile(path.join(repo, "dirty.txt"), "utf8")) === "uncommitted work\n", "the dirty file and git status are unchanged");
  await writeFile(path.join(evidence, "launch-response.json"), JSON.stringify({ launched, retained }, null, 2));
} catch (error) {
  record("V1-shell-real-run", false, error instanceof Error ? error.message : String(error));
} finally {
  if (bridge && bridge.exitCode === null) bridge.kill("SIGKILL");
  client?.kill();
  await run("herdr", ["session", "stop", session], { env }).catch(() => {});
  await run("herdr", ["session", "delete", session], { env }).catch(() => {});
  await writeFile(path.join(evidence, "results.json"), JSON.stringify({ at: new Date().toISOString(), session, results }, null, 2));
  await rm(dir, { recursive: true, force: true });
}
process.exit(results.every((r) => r.status === "pass") ? 0 : 1);
