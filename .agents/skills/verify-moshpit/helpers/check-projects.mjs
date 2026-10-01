import assert from "node:assert/strict";
import { createProjectResolver, projectFromWorktrees } from "../../../../bridge/projects.mjs";
import { groupAgentsByProject } from "../../../../src/lib/moshpit/projects.ts";

const repo = "/tmp/moshpit-projects/repo";
const nested = `${repo}/src/feature`;
const linked = "/tmp/moshpit-projects/repo-feat";
const detached = "/tmp/moshpit-projects/detached";
const listed = {
  worktrees: [
    { path: repo, branch: "main", is_detached: false },
    { path: linked, branch: "feat-chat", is_detached: false },
    { path: detached, branch: null, is_detached: true },
  ],
};

assert.deepEqual(projectFromWorktrees(nested, listed), { root: repo, branch: "main" });
assert.deepEqual(projectFromWorktrees(linked, listed), { root: linked, branch: "feat-chat" });
assert.deepEqual(projectFromWorktrees(detached, listed), { root: detached, branch: undefined });
assert.equal(projectFromWorktrees("/tmp/not-a-repo", listed), undefined);
assert.equal(projectFromWorktrees(nested, undefined), undefined);

const resolve = createProjectResolver(async (cwd) => {
  if (cwd.startsWith("/tmp/moshpit-projects/repo") || cwd === linked || cwd === detached) return listed;
  throw new Error("not_git_worktree");
});
assert.deepEqual(await resolve(nested), { root: repo, branch: "main" });
assert.deepEqual(await resolve(linked), { root: linked, branch: "feat-chat" });
assert.equal(await resolve("/tmp/scratch"), undefined);
assert.equal(await resolve(""), undefined);
assert.equal(await createProjectResolver()("/tmp/moshpit-projects/repo"), undefined);

const agents = [
  { id: "a", cwd: repo, projectRoot: repo, status: "blocked", workspace: "w1", attention: true },
  { id: "b", cwd: nested, projectRoot: repo, status: "working", workspace: "w2", attention: false },
  { id: "c", cwd: "/another/repo", status: "idle", workspace: "w1", attention: false },
  { id: "d", cwd: "", status: "idle", workspace: "w3", attention: false },
];
const groups = groupAgentsByProject(agents, "host-a");
assert.equal(groups.length, 3);
assert.deepEqual(groups[0].agents.map(agent => agent.id), ["a", "b"]);
assert.equal(groups[0].attention, 1);
assert.equal(groups[0].name, groups[1].name);
assert.notEqual(groups[0].id, groups[1].id, "Same-named repositories remain separate");
assert.equal(groups[2].name, "w3");
assert.notEqual(groups[0].id, groupAgentsByProject(agents, "host-b")[0].id, "Collapse state is host-specific");
console.log("ok   herdr worktree join, nested directories, linked worktrees, detached HEAD, folder/workspace fallback, same-name separation, host identity, attention counts");
