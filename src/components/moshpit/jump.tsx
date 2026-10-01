import { paneLabel, projectOf } from "@/lib/moshpit/label";
import { useLayout } from "@/lib/moshpit/use-layout";
import { useMoshpitStore } from "@/lib/moshpit/store";
import { StatusPill } from "@/components/moshpit/status-pill";
import { AgentIcon } from "@/components/moshpit/agent-icon";
import type { Agent } from "@/lib/moshpit/types";
import { cn } from "@/lib/utils";

/** Group by project directory: "wF" means nothing, "moshpit" does. */
function groupByProject(agents: Agent[]) {
  const m = new Map<string, Agent[]>();
  for (const a of agents) {
    const key = projectOf(a.cwd) || a.workspace;
    const list = m.get(key) ?? [];
    list.push(a);
    m.set(key, list);
  }
  return m;
}

export function JumpSheet() {
  const layout = useLayout();
  const wide = layout.regime === "wide";
  const open = useMoshpitStore((s) => s.jumpOpen);
  const setJumpOpen = useMoshpitStore((s) => s.setJumpOpen);
  const agents = useMoshpitStore((s) => s.agents);
  const selectAgent = useMoshpitStore((s) => s.selectAgent);
  const tab = useMoshpitStore((s) => s.tab);
  const setTab = useMoshpitStore((s) => s.setTab);
  const focusedPaneId = useMoshpitStore((s) => s.focusedPaneId);

  if (!open) return null;

  const groups = groupByProject(agents);

  return (
    <div
      className={
        wide
          ? "absolute inset-0 z-30 flex items-center justify-center"
          : "absolute inset-0 z-30 flex flex-col justify-end"
      }
    >
      <button
        type="button"
        className="absolute inset-0 bg-bg/70"
        aria-label="Close jump"
        onClick={() => setJumpOpen(false)}
      />
      <div
        className={
          wide
            ? "relative mx-auto max-h-sheet w-full max-w-md overflow-y-auto rounded-2xl bg-surface-2 px-4 pb-8 pt-4 shadow-border"
            : "relative mx-auto max-h-sheet w-full max-w-lg overflow-y-auto rounded-t-2xl bg-surface-2 px-4 pb-8 pt-4 shadow-border"
        }
      >
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-border-strong" />
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-subtle">
          Jump to
        </p>
        {[...groups.entries()].map(([ws, list]) => (
          <section key={ws} className="mt-4">
            <h3 className="text-sm font-medium">{ws}</h3>
            <ul className="mt-2 space-y-1.5">
              {list.map((agent) => (
                <li key={agent.id}>
                  <button
                    type="button"
                    onClick={() => {
                      selectAgent(agent.id);
                      if (wide && tab !== "moshpit" && tab !== "inbox") {
                        setTab("moshpit");
                      }
                    }}
                    className={cn(
                      "flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left",
                      focusedPaneId === agent.paneId
                        ? "bg-surface"
                        : "bg-transparent",
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">
                        {paneLabel(agent, agents).name}
                      </span>
                      <span className="mt-0.5 flex items-center gap-1.5 truncate text-2xs text-muted">
                        <AgentIcon kind={agent.kind} className="shrink-0" />
                        <span className="min-w-0 truncate">
                          {paneLabel(agent, agents).detail}
                          <span className="text-subtle"> · {agent.paneId}</span>
                        </span>
                      </span>
                    </span>
                    <StatusPill status={agent.status} className="shrink-0" />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
