import { spawn } from "node:child_process";

// Pi is pluggable: most of its commands come from extensions that register
// them in code, so no disk scan can list them. Pi's RPC mode can
// (docs/rpc-commands.md, get_commands): it returns every extension command,
// prompt template and skill loaded for a working directory, with pi's own
// project-trust rules applied.
//
// This starts `pi --mode rpc --no-session --offline` in the pane's directory,
// asks once, and stops it. --no-session writes no session file; --offline
// skips model-catalog refreshes. Loading extensions runs their code, the same
// code the user's own pi already runs in that directory.
//
// Nothing waits on this at startup: the client shows the disk catalog first
// and asks for this one in the background. Results are cached per directory,
// one run is in flight per directory, and runs are serialised so several pi
// panes cannot start a burst of processes.

const REQUEST_ID = "moshpit-commands";
const MAX_OUTPUT = 1024 * 1024;
const LIMIT = 200;
const NAME_LIMIT = 80;
const DESCRIPTION_LIMIT = 300;

export function createPiCommands({
  bin = process.env.MOSHPIT_PI_BIN || "pi",
  timeoutMs = 10_000,
  ttlMs = 5 * 60_000,
  now = Date.now,
} = {}) {
  const cache = new Map();
  const inflight = new Map();
  let queue = Promise.resolve();

  function list(cwd) {
    if (typeof cwd !== "string" || !cwd.startsWith("/")) {
      return Promise.reject(new Error("pi commands need an absolute working directory"));
    }
    const hit = cache.get(cwd);
    if (hit && now() - hit.at < ttlMs) return Promise.resolve(hit.commands);
    const pending = inflight.get(cwd);
    if (pending) return pending;
    const run = queue.then(() => ask(bin, cwd, timeoutMs));
    // The queue only orders runs; one run's failure must not fail the next.
    queue = run.catch(() => {});
    const settled = run.then(
      (commands) => {
        cache.set(cwd, { at: now(), commands });
        return commands;
      },
    ).finally(() => inflight.delete(cwd));
    inflight.set(cwd, settled);
    return settled;
  }

  return { list };
}

function ask(bin, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, ["--mode", "rpc", "--no-session", "--offline"], {
        cwd,
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch (error) {
      reject(error);
      return;
    }
    let done = false;
    let buffered = "";
    let size = 0;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.stdin.end(); } catch { /* already gone */ }
      // Pi exits when stdin closes; the kill is the guaranteed cleanup.
      const grace = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill();
      }, 500);
      grace.unref?.();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("pi did not answer in time")), timeoutMs);
    timer.unref?.();
    child.on("error", (error) => finish(error));
    child.on("close", () => finish(new Error("pi exited without listing commands")));
    child.stdin.on("error", () => {});
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_OUTPUT) {
        finish(new Error("pi output too large"));
        return;
      }
      buffered += chunk;
      // Strict JSONL: records end at LF only. A generic line reader would
      // also split on U+2028/U+2029, which are legal inside JSON strings.
      let at;
      while ((at = buffered.indexOf("\n")) !== -1) {
        const line = buffered.slice(0, at).replace(/\r$/, "");
        buffered = buffered.slice(at + 1);
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          continue; // not ours; stdout is protocol-only, but be lenient
        }
        if (record?.type !== "response" || record.id !== REQUEST_ID) continue;
        if (record.success !== true) {
          finish(new Error(typeof record.error === "string" ? record.error : "pi refused get_commands"));
          return;
        }
        finish(null, normalise(record.data?.commands));
        return;
      }
    });
    child.stdin.write(`${JSON.stringify({ id: REQUEST_ID, type: "get_commands" })}\n`);
  });
}

// Pi names a skill command "skill:<name>" and everything else by its bare
// name; each runs as "/" + name.
function normalise(commands) {
  if (!Array.isArray(commands)) throw new Error("pi returned no command list");
  const out = [];
  const seen = new Set();
  for (const command of commands) {
    if (!command || typeof command !== "object") continue;
    const name = typeof command.name === "string" ? command.name.trim().slice(0, NAME_LIMIT) : "";
    if (!name || /\s/.test(name)) continue;
    const invocation = `/${name}`;
    if (seen.has(invocation)) continue;
    seen.add(invocation);
    out.push({
      name: name.startsWith("skill:") ? name.slice("skill:".length) : name,
      invocation,
      description: typeof command.description === "string" ? command.description.slice(0, DESCRIPTION_LIMIT) : "",
    });
    if (out.length >= LIMIT) break;
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
