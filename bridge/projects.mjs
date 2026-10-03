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
  const remember = (cwd, value) => {
    cache.set(cwd, { result: Promise.resolve(value), expires: Date.now() + 60000 });
    if (cache.size > 256) cache.delete(cache.keys().next().value);
  };
  return async (cwd, { fresh = false, signal } = {}) => {
    if (typeof cwd !== "string" || !isAbsolute(cwd) || typeof listWorktrees !== "function") return undefined;
    if (!fresh) {
      const existing = cache.get(cwd);
      if (existing && existing.expires > Date.now()) return existing.result;
    }
    if (signal) {
      // A signal-bound lookup is scoped work: it never becomes the shared
      // cached promise, an abort keeps any valid cached root in place, and a
      // success refreshes the cache for ordinary polling.
      try {
        const value = projectFromWorktrees(cwd, await listWorktrees(cwd, signal));
        remember(cwd, value);
        return value;
      } catch (error) {
        if (signal.aborted) throw error;
        return undefined;
      }
    }
    const result = Promise.resolve(listWorktrees(cwd))
      .then((listed) => projectFromWorktrees(cwd, listed))
      .catch(() => undefined);
    cache.set(cwd, { result, expires: Date.now() + 60000 }); // ponytail: 60s cwd cache; drop if branch flips need to show immediately
    if (cache.size > 256) cache.delete(cache.keys().next().value);
    return result;
  };
}
