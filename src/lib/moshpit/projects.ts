import type { Agent } from "./types";

export type ProjectGroup = {
  id: string;
  name: string;
  path: string;
  agents: Agent[];
  attention: number;
};

export function groupAgentsByProject(agents: Agent[], hostId: string): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();
  for (const agent of agents) {
    const directory = (agent.projectRoot || agent.cwd).replace(/\\/g, "/").replace(/\/+$/, "");
    const path = directory || agent.workspace || "Unassigned";
    const id = JSON.stringify([hostId, directory ? "directory" : "workspace", path]);
    let group = groups.get(id);
    if (!group) {
      group = { id, name: path.split("/").at(-1) || path, path, agents: [], attention: 0 };
      groups.set(id, group);
    }
    group.agents.push(agent);
    if (agent.status === "blocked" || agent.attention) group.attention++;
  }
  return [...groups.values()];
}
