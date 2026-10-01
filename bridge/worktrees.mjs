import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { worktreeDestination } from "../src/lib/moshpit/worktrees-policy.mjs";

// Thrown for caller-supplied input problems (bad refs, names, collisions) so
// the handler can answer 400; infrastructure failures stay 500.
export class WorktreeInputError extends Error {}

function inputError(message) {
  return new WorktreeInputError(message);
}

/** The repository toplevel for a path (which may be a subdirectory). */
export async function repoToplevel(cwd) {
  const dir = String(cwd).replace(/\/+$/, "");
  if (!dir) throw inputError("A project path is required.");
  if (dir.startsWith("-")) throw inputError("A project path may not start with a dash.");
  try {
    return (await run("git", ["-C", dir, "rev-parse", "--show-toplevel"])).trim();
  } catch {
    throw inputError(`Not a Git repository: ${dir}`);
  }
}
/**
 * The main worktree's path — the anchor for the destination policy.
 *
 * A project can itself be a linked worktree. Anchoring on its own toplevel
 * put new checkouts at "<linked>-worktrees/<branch>", so they nested a level
 * deeper each time instead of collecting beside the repository. Refs are
 * still resolved in the project's own worktree, where HEAD means what the
 * caller sees; only the destination moves. Falls back to the toplevel when
 * the porcelain is not shaped as expected, so an unusual layout keeps
 * working rather than producing a path nobody asked for.
 */
export async function mainWorktreeRoot(cwd) {
  const toplevel = await repoToplevel(cwd);
  try {
    const first = (await run("git", ["-C", toplevel, "worktree", "list", "--porcelain"])).split("\n")[0];
    const match = /^worktree (.+)$/.exec(first.trim());
    const root = match?.[1]?.replace(/\/+$/, "");
    return root || toplevel;
  } catch {
    return toplevel;
  }
}

function run(bin, args) {
  // Invokes git as an argv element (never a shell string) and rejects on
  // nonzero exit, mirroring the herdr module's runner pattern.
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out = [];
    const err = [];
    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => err.push(c));
    child.on("error", reject);
    child.on("close", (code) => {
      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = Buffer.concat(err).toString("utf8");
      if (code !== 0) {
        reject(new Error(stderr.trim() || `${bin} exited ${code}`));
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * Creates a fresh branch + worktree from a base ref, then starts the agent
 * inside it. The destination is server-chosen (see worktrees-policy.mjs);
 * clients only provide the repository path, base ref and branch name.
 *
 * Returns a discriminated union:
 *   { state: "started", paneId, path, branch }
 *   { state: "created-agent-failed", path, branch, error }
 * The partial result keeps the created worktree on disk — nothing is ever
 * deleted here, so a retry can start the agent in the retained directory.
 */
export async function createWorktreeAgent({ repoCwd, baseRef, branch, agentKind, model, startAgent }) {
  const base = String(baseRef).trim();
  const name = String(branch).trim();
  if (!base) throw inputError("A base ref is required.");
  if (!name) throw inputError("A branch name is required.");
  if (base.startsWith("-")) throw inputError("A base ref may not start with a dash.");
  if (name.startsWith("-")) throw inputError("A branch name may not start with a dash.");
  if (name.length > 200) throw inputError("A branch name must be under 200 characters.");
  const cwd = String(repoCwd).replace(/\/+$/, "");
  if (!cwd) throw inputError("A project path is required.");
  const repoRoot = await repoToplevel(cwd);
  try {
    await run("git", ["-C", repoRoot, "check-ref-format", "--branch", name]);
  } catch {
    throw inputError(`Invalid branch name: ${name}`);
  }
  const branchExists = await run("git", ["-C", repoRoot, "show-ref", "--verify", "--quiet", `refs/heads/${name}`])
    .then(() => true)
    .catch(() => false);
  if (branchExists) throw inputError(`Branch already exists: ${name}`);
  let baseCommit;
  try {
    baseCommit = (await run("git", ["-C", repoRoot, "rev-parse", "--verify", `${base}^{commit}`])).trim();
  } catch {
    throw inputError(`Unknown base ref: ${base}`);
  }
  // Refs resolved above in the project's own worktree; the destination is
  // anchored on the main one so checkouts collect beside the repository.
  const destination = worktreeDestination(await mainWorktreeRoot(cwd), name);
  if (existsSync(destination)) throw inputError(`Destination already exists: ${destination}`);
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    await run("git", ["-C", repoRoot, "worktree", "add", "-b", name, destination, baseCommit]);
  } catch (err) {
    throw new Error(`Worktree creation failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const { paneId } = await startAgent({ cwd: destination, agentKind, model });
    if (typeof paneId !== "string" || !paneId) throw new Error("Agent start returned no pane.");
    return { state: "started", paneId, path: destination, branch: name };
  } catch (err) {
    return {
      state: "created-agent-failed",
      path: destination,
      branch: name,
      error: err instanceof Error ? err.message : "Agent start failed.",
    };
  }
}
