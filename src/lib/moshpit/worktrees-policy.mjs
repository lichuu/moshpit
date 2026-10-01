// Single source of truth for the worktree destination policy. The bridge
// (server, node) and the app (client, vite) both import this module, so the
// preview shown in New agent always matches where the host actually creates
// the checkout.
export function worktreeDestination(repoRoot, branch) {
  const root = String(repoRoot).replace(/\\/g, "/").replace(/\/+$/, "");
  return `${root}-worktrees/${branch}`;
}

export function defaultWorktreeBranch() {
  return `wt-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;
}
