#!/usr/bin/env node
// Runs every node-level check in the helpers directory.
//
// These used to be a hand-maintained && chain inside package.json's "test"
// script. That had two costs: it was a single 700-character line that every
// concurrent feature branch collided on, and adding a check meant remembering
// to add it there — which is how 37 of 49 checks ended up wired into nothing
// and silently rotting.
//
// Discovery replaces the list. Anything named check-*.mjs that does not drive
// a browser runs here; browser checks belong to the Playwright suite.
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedEnv } from "../bridge/test-support.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HELPERS = path.join(ROOT, ".agents/skills/verify-moshpit/helpers");

// .agents is local-only. CI clones do not have it; skip rather than fail.
if (!existsSync(HELPERS)) {
  process.stdout.write("skipped: no .agents helpers in this checkout\n");
  process.exit(0);
}

// Checks that need a browser, a live bridge, or an argument they cannot be
// given here. Each needs a reason so the list cannot quietly become a dumping
// ground for anything inconvenient.
const EXCLUDED = new Map([
  ["check-add-host", "browser: covered by tests/demo/hosts.spec.ts"],
  ["check-connect-error", "browser: covered by tests/demo/hosts.spec.ts"],
  ["check-live-detail", "needs a real herdr host"],
  ["check-upload", "needs a real bridge with a state dir"],
  ["check-chat-upload", "needs a real bridge with a state dir"],
  ["check-shell-real", "drives a real, disposable named herdr session: needs MOSHPIT_PROBE_SESSION and an evidence directory"],
]);

function isBrowserCheck(source) {
  return /from\s+["']playwright["']/.test(source);
}

// A check that cannot run here (a missing build, say) exits with this code.
// It is reported as blocked: an unrun check is not a pass, so the run exits
// non-zero on one -- 77 rather than 1, so a caller can still tell "could not
// run" from "ran and failed".
const BLOCKED = 77;
// One hung check must fail, not stall the whole run. This is itself a
// MOSHPIT_* variable read from the caller's environment, so an unusable
// value has to fall back: `??` does not fire on an exported-empty string,
// and Number("") is 0, which would SIGKILL every check at 0ms.
const override = Number(process.env.MOSHPIT_CHECK_TIMEOUT_MS);
const TIMEOUT_MS = Number.isFinite(override) && override > 0 ? override : 120_000;

const run = (file) =>
  new Promise((resolve) => {
    // Own session, so the timeout can kill the whole group. A helper spawns
    // bridges; SIGKILL cannot be trapped and Node runs no finally block on a
    // signal either, so killing the helper alone leaves those bridges
    // reparented to init, still holding their ports and state directories.
    // Strip MOSHPIT_* once, here, as well as per helper. Every check that runs
    // today already builds its own environment, so this fixes nothing on its
    // own -- it means the next check to be written cannot reintroduce the
    // inherited-MOSHPIT_HERDR_BIN hazard by forgetting to. Nothing run here
    // reads one (check-pwa does, and is filtered out as a browser check).
    // Running a helper directly still inherits the caller's environment; that
    // hazard is the one documented in docs/specs.md.
    const child = spawn(process.execPath, [file], {
      stdio: "inherit",
      cwd: ROOT,
      env: isolatedEnv(),
      detached: true,
    });
    const killGroup = (signal) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        /* already gone */
      }
    };
    const timer = setTimeout(() => {
      process.stdout.write(`timed out after ${TIMEOUT_MS / 1000}s\n`);
      killGroup("SIGKILL");
    }, TIMEOUT_MS);
    // detached puts the child outside the terminal's foreground group, so
    // Ctrl+C reaches this runner but not the check. Pass it on.
    const forward = () => {
      killGroup("SIGTERM");
      process.exit(130);
    };
    process.once("SIGINT", forward);
    process.once("SIGTERM", forward);
    const done = (code) => {
      clearTimeout(timer);
      process.off("SIGINT", forward);
      process.off("SIGTERM", forward);
      resolve(code);
    };
    child.on("close", (code) => done(code ?? 1));
    child.on("error", () => done(1));
  });

const entries = (await readdir(HELPERS)).filter(
  (name) => name.startsWith("check-") && name.endsWith(".mjs"),
);

const failures = [];
const blocked = [];
let ran = 0;
for (const name of entries.sort()) {
  const id = name.replace(/\.mjs$/, "");
  if (EXCLUDED.has(id)) continue;
  const file = path.join(HELPERS, name);
  if (isBrowserCheck(await readFile(file, "utf8"))) continue;
  ran += 1;
  process.stdout.write(`\n── ${id}\n`);
  const code = await run(file);
  if (code === BLOCKED) blocked.push(id);
  else if (code !== 0) failures.push(id);
}

process.stdout.write(
  `\n${ran - failures.length - blocked.length}/${ran} node checks passed${
    blocked.length ? `; blocked: ${blocked.join(", ")}` : ""
  }${failures.length ? `; failed: ${failures.join(", ")}` : ""}\n`,
);
process.exit(failures.length ? 1 : blocked.length ? BLOCKED : 0);
