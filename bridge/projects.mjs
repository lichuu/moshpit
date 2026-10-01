import { isAbsolute } from "node:path";

function normalize(path) {
  return String(path ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
}

export function projectFromWorktrees(cwd, listed) {
  const directory = normalize(cwd);
  if (!directory || !listed?.worktrees?.length) return undefined;
  let best;
  for (const worktree of listed.worktrees) {
    const path = normalize(worktree.path);
    if (!path) continue;
    if (directory !== path && !directory.startsWith(`${path}/`)) continue;
    if (!best || path.length > best.path.length) best = worktree;
  }
  const path = normalize(best?.path);
  if (!path) return undefined;
  return {
    root: path,
    branch: best.is_detached ? undefined : best.branch?.trim() || undefined,
  };
}

export function createProjectResolver(listWorktrees) {
  const cache = new Map();
  return async (cwd) => {
    if (typeof cwd !== "string" || !isAbsolute(cwd) || typeof listWorktrees !== "function") return undefined;
    const existing = cache.get(cwd);
    if (existing && existing.expires > Date.now()) return existing.result;
    const result = Promise.resolve(listWorktrees(cwd))
      .then((listed) => projectFromWorktrees(cwd, listed))
      .catch(() => undefined);
    cache.set(cwd, { result, expires: Date.now() + 60000 }); // ponytail: 60s cwd cache; drop if branch flips need to show immediately
    if (cache.size > 256) cache.delete(cache.keys().next().value);
    return result;
  };
}
