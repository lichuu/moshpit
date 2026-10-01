import { ArrowUpRight, ChevronDown, Folder, GitBranch, LoaderCircle, Plus, Power, Sprout, SquareTerminal, X } from "lucide-react";
import { AgentIcon } from "@/components/moshpit/agent-icon";
import { useId, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { groupAgentsByProject, type ProjectGroup } from "@/lib/moshpit/projects";
import { useLayout } from "@/lib/moshpit/use-layout";
import {
  blockedCount,
  sortedAgents,
  useMoshpitStore,
} from "@/lib/moshpit/store";
import type { Agent, FilterId } from "@/lib/moshpit/types";
import { cn, formatAgo } from "@/lib/utils";
import { StatusPill } from "@/components/moshpit/status-pill";
import { Button } from "@/components/ui/button";
import { paneLabel, projectOf } from "@/lib/moshpit/label";
import { fetchRepoRoot } from "@/lib/moshpit/bridge";
import { defaultWorktreeBranch, worktreeDestination } from "@/lib/moshpit/worktrees-policy.mjs";

const FILTERS: { id: FilterId; label: string }[] = [
  { id: "all", label: "All" },
  { id: "blocked", label: "Blocked" },
  { id: "working", label: "Working" },
  { id: "done", label: "Done" },
];

function AgentCard({ agent, all }: { agent: Agent; all: Agent[] }) {
  const select = useMoshpitStore((s) => s.selectAgent);
  const blocked = agent.status === "blocked";
  const selected = useMoshpitStore((s) => s.selectedAgentId === agent.id);
  const layout = useLayout();
  return (
    <button
      type="button"
      onClick={() => select(agent.id)}
      aria-pressed={layout.regime === "wide" ? selected : undefined}
      className={cn(
        "agent-card w-full rounded-xl border border-transparent p-4 text-left",
        blocked && "border-l-blocked",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="truncate font-medium tracking-tight">
              {paneLabel(agent, all).name}
            </p>
            {agent.attention ? (
              <span className="size-1.5 shrink-0 rounded-full bg-blocked" />
            ) : null}
          </div>
          <p className="mt-0.5 truncate text-xs text-muted">
            {agent.workspace} <span className="text-subtle">/ {agent.tab}</span>
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <StatusPill status={agent.status} />
          <span className="text-2xs tabular-nums text-subtle">
            {formatAgo(agent.statusChangedAt)}
          </span>
        </div>
      </div>
      {agent.lastOutput.trim() && agent.lastOutput.trim() !== (agent.title?.trim() || agent.name) && <p
        className={cn(
          "mt-3 line-clamp-2 text-[13px] leading-5",
          blocked ? "text-blocked" : "text-fg/80",
        )}
      >
        {agent.lastOutput}
      </p>}
      <div className="mt-3 flex items-center gap-1.5 text-2xs text-subtle">
        <AgentIcon kind={agent.kind} />
        {agent.kind}
        {agent.model ? (
          <>
            <span className="mx-1 text-border-strong">/</span>
            <span className="truncate">{agent.model}</span>
          </>
        ) : null}
        {agent.branch ? (
          <>
            <span className="mx-1 text-border-strong">/</span>
            <GitBranch className="size-3" />
            <span className="truncate">{agent.branch}</span>
          </>
        ) : null}
      </div>
    </button>
  );
}

function ShellsSection() {
  const shells = useMoshpitStore((s) => s.shells);
  const selectShell = useMoshpitStore((s) => s.selectShell);
  const openShell = useMoshpitStore((s) => s.openShell);
  if (shells.length === 0) return null;
  return (
    <section className="mt-2" aria-label="Companion shells">
      <div className="flex items-center gap-2 px-2 py-2">
        <SquareTerminal className="size-4 shrink-0 text-accent" />
        <span className="text-sm font-medium">Companion shells</span>
        <span className="text-2xs tabular-nums text-muted">{shells.length}</span>
      </div>
      <div className="space-y-1">
        {shells.map((shell) => (
          <button
            key={shell.id}
            type="button"
            onClick={() =>
              shell.alive === false
                ? void openShell(shell.cwd)
                : selectShell(shell.id)
            }
            className="w-full rounded-xl border border-transparent p-4 text-left hover:bg-surface"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="truncate font-medium tracking-tight">Shell</p>
                  <span className="shrink-0 rounded-md bg-accent/10 px-1.5 py-0.5 text-2xs font-medium text-accent">
                    {shell.alive === false ? "gone" : "shell"}
                  </span>
                </div>
                <p className="mt-0.5 truncate text-xs text-muted">
                  interactive · {projectOf(shell.cwd) || shell.cwd}
                </p>
              </div>
              {shell.alive === false ? (
                <span className="shrink-0 text-2xs text-muted">tap to recreate</span>
              ) : null}
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}

function HerdrDown() {
  const startHerdr = useMoshpitStore((s) => s.startHerdr);
  return (
    <div className="flex flex-1 flex-col items-start justify-center px-6">
      <p className="text-xs font-medium uppercase tracking-[0.18em] text-blocked">
        herdr not running
      </p>
      <h2 className="mt-3 max-w-xs text-balance text-2xl font-medium tracking-display">
        The box is reachable, but herdr isn’t up.
      </h2>
      <p className="mt-3 max-w-xs text-pretty text-sm leading-normal text-muted">
        One tap starts it and the snapshot starts flowing.
      </p>
      <Button className="mt-6" onClick={startHerdr}>
        <Power className="size-4" />
        Start herdr
      </Button>
    </div>
  );
}

function NewAgentSheet({
  project,
  open,
  onClose,
}: {
  project: ProjectGroup;
  open: boolean;
  onClose: () => void;
}) {
  const kinds = useMoshpitStore((s) => s.availableKinds);
  const createAgent = useMoshpitStore((s) => s.createAgent);
  const [busy, setBusy] = useState<string | null>(null);
  const [model, setModel] = useState("");
  const [worktree, setWorktree] = useState(false);
  const [baseRef, setBaseRef] = useState("HEAD");
  const [branch, setBranch] = useState("");
  const [partial, setPartial] = useState<{ path: string; branch: string; kind: string; message?: string } | null>(null);
  const [repoRoot, setRepoRoot] = useState<string | null>(null);
  const worktreeInvalid = worktree && (!baseRef.trim() || !branch.trim());
  // The host resolves the worktree destination from the project's repository
  // root (a subdirectory project's destination sits next to the repo, not
  // next to the folder). Probe it on real hosts; without one the preview is
  // an explicit estimate.
  const probeRepoRoot = () => {
    const state = useMoshpitStore.getState();
    const host = state.hosts.find((h) => h.id === state.connectedHostId);
    if (!host?.tailnetUrl) return;
    const hostId = state.connectedHostId;
    void fetchRepoRoot(host.tailnetUrl.replace(/\/$/, ""), project.path)
      .then((root) => {
        // A host switch in flight would resolve the previous host's root.
        if (useMoshpitStore.getState().connectedHostId !== hostId) return;
        setRepoRoot(root);
      })
      .catch(() => { /* stays an estimate */ });
  };
  // The sheet stays mounted per project, so its state outlives a close.
  // Reopening with the previous branch name still in the field launched
  // straight into "Branch already exists".
  function reset() {
    setPartial(null);
    setWorktree(false);
    setBranch("");
    setBaseRef("HEAD");
  }
  async function start(kind: string, directory = project.path, retry = false) {
    if (busy !== null) return; // never two concurrent starts (double-tapped retry)
    // Picking a different kind after a partial is a retry with a different
    // agent, not a fresh launch: the worktree and its branch already exist, so
    // re-running git would only fail with "Branch already exists" and strand
    // the checkout that was kept for exactly this.
    const retained =
      !retry && partial && worktree && partial.branch === branch.trim() ? partial : null;
    if (retained) {
      directory = retained.path;
      retry = true;
    }
    if (!retry) setPartial(null);
    setBusy(kind);
    const result = await createAgent(directory, kind, kind === "pi" ? model : undefined, worktree && directory === project.path && baseRef.trim() && branch.trim() ? { baseRef: baseRef.trim(), branch: branch.trim() } : undefined);
    setBusy(null);
    if (result.state === "started") {
      setPartial(null);
      onClose();
      return;
    }
    if (result.partial) {
      setPartial({ path: result.partial.path, branch: result.partial.branch, kind, message: result.message });
      return;
    }
    // A failed retry with no fresh partial: the retained worktree is
    // unchanged, so the previous partial stays visible and retryable — now
    // naming the kind that was just attempted.
    if (retained) setPartial({ ...retained, kind });
  }
  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) { onClose(); reset(); } }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm" />
        <Dialog.Content className="fixed bottom-0 left-1/2 z-50 max-h-[90dvh] w-full max-w-lg -translate-x-1/2 overflow-y-auto rounded-t-3xl border border-border bg-bg p-6 pb-safe shadow-xl sm:bottom-auto sm:top-1/2 sm:-translate-y-1/2 sm:rounded-3xl sm:p-8">
          <Dialog.Title className="text-2xl font-medium tracking-tight">
            New agent in {project.name}
          </Dialog.Title>
          <Dialog.Description className="mt-3 text-sm leading-6 text-muted">
            {kinds.length
              ? "Starts a session in this project from the agents installed on the host."
              : "No supported agent is on this host's PATH."}
          </Dialog.Description>
          <Dialog.Close
            aria-label="Close new agent"
            className="absolute right-4 top-4 flex size-11 items-center justify-center rounded-xl text-muted hover:bg-surface"
          >
            <X className="size-5" />
          </Dialog.Close>
          <div className="mt-6 grid grid-cols-2 gap-2">
            {kinds.map((kind) => (
              <button
                key={kind}
                type="button"
                disabled={Boolean(busy) || worktreeInvalid}
                onClick={() => void start(kind)}
                className="flex min-h-12 items-center gap-2 rounded-xl border border-border px-3 text-left text-sm hover:bg-surface disabled:opacity-40"
              >
                <span aria-hidden="true"><AgentIcon kind={kind} /></span>
                <span className="truncate">{busy === kind ? "Starting…" : kind}</span>
              </button>
            ))}
          </div>
          <div className="mt-4">
            <span className="text-xs font-medium uppercase tracking-[0.14em] text-muted">Checkout</span>
            <div className="mt-2 grid grid-cols-2 gap-2" role="group" aria-label="Checkout">
              <button
                type="button"
                aria-pressed={!worktree}
                onClick={() => setWorktree(false)}
                className={cn(
                  "min-h-12 rounded-xl border border-border px-3 text-left text-sm hover:bg-surface",
                  !worktree && "border-blocked bg-surface",
                )}
              >
                In this project
              </button>
              <button
                type="button"
                aria-pressed={worktree}
                onClick={() => {
                  setWorktree(true);
                  setBranch((current) => current || defaultWorktreeBranch());
                  probeRepoRoot();
                }}
                className={cn(
                  "min-h-12 rounded-xl border border-border px-3 text-left text-sm hover:bg-surface",
                  worktree && "border-blocked bg-surface",
                )}
              >
                New worktree
              </button>
            </div>
            {worktree ? (
              <div className="mt-3 space-y-3">
                <label className="block">
                  <span className="text-xs font-medium uppercase tracking-[0.14em] text-muted">Base ref</span>
                  <input
                    value={baseRef}
                    onChange={(e) => setBaseRef(e.target.value)}
                    placeholder="HEAD"
                    className="mt-2 w-full rounded-xl border border-border bg-bg px-3 py-2.5 text-sm outline-none focus:border-blocked"
                  />
                </label>
                <label className="block">
                  <span className="text-xs font-medium uppercase tracking-[0.14em] text-muted">Branch</span>
                  <input
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                    placeholder={defaultWorktreeBranch()}
                    className="mt-2 w-full rounded-xl border border-border bg-bg px-3 py-2.5 text-sm outline-none focus:border-blocked"
                  />
                </label>
                <p className="text-xs leading-5 text-subtle">
                  {project.name}: <span className="font-mono">{worktreeDestination(repoRoot ?? project.path, branch.trim() || "branch")}</span>
                  {repoRoot
                    ? ""
                    : " (estimate — the host resolves the project's repo root; the worktree is created next to that root)"}.
                  Your current checkout is never touched.
                </p>
              </div>
            ) : null}
          </div>
          {partial ? (
            <div className="mt-4 rounded-xl border border-blocked bg-blocked/10 p-4" role="alert">
              <p className="text-sm font-medium text-blocked">Worktree created, agent failed</p>
              {partial.message ? <p className="mt-1 text-xs leading-5 text-blocked">{partial.message}</p> : null}
              <p className="mt-1 break-all text-xs leading-5 text-muted">
                Kept at <span className="font-mono">{partial.path}</span> on branch <span className="font-mono">{partial.branch}</span>. Retry starts {partial.kind} inside it without recreating the worktree.
              </p>
              <Button className="mt-3" disabled={busy !== null} onClick={() => void start(partial.kind, partial.path, true)}>
                Retry in worktree
              </Button>
            </div>
          ) : null}
          {kinds.includes("pi") ? (
            <label className="mt-4 block">
              <span className="text-xs font-medium uppercase tracking-[0.14em] text-muted">pi model (optional)</span>
              <input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="provider/model, blank for the default"
                className="mt-2 w-full rounded-xl border border-border bg-bg px-3 py-2.5 text-sm outline-none focus:border-blocked"
              />
              {model.trim() ? (
                <span className="mt-1.5 block text-xs text-subtle">
                  Applies to pi only. Other kinds start on their own default.
                </span>
              ) : null}
            </label>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ProjectSection({ project, all, filter }: { project: ProjectGroup; all: Agent[]; filter: FilterId }) {
  const regionId = useId();
  const collapsed = useMoshpitStore((state) => state.collapsedProjects.includes(project.id));
  const toggle = useMoshpitStore((state) => state.toggleProject);
  const [adding, setAdding] = useState(false);
  const visible = sortedAgents(project.agents, filter);
  const expanded = filter !== "all" || !collapsed;
  if (visible.length === 0) return null;
  return (
    <section className="project-group mb-4 min-w-0">
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label={`Project ${project.name}`}
          aria-expanded={expanded}
          aria-controls={regionId}
          onClick={() => toggle(project.id)}
          disabled={filter !== "all"}
          className="flex min-h-12 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-surface"
          title={project.path}
        >
          <ChevronDown className={cn("size-4 shrink-0 text-muted transition-transform", !expanded && "-rotate-90")} />
          <Folder className="size-4 shrink-0 text-accent" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{project.name}</span>
            <span className="block truncate text-2xs text-subtle">{project.path}</span>
          </span>
          {project.attention > 0 && <span className="shrink-0 rounded-md bg-blocked/10 px-1.5 py-1 text-2xs text-blocked" aria-label={`${project.attention} need attention`}>{project.attention} waiting</span>}
          <span className="text-2xs tabular-nums text-muted">{filter === "all" ? project.agents.length : `${visible.length}/${project.agents.length}`}</span>
        </button>
        <button
          type="button"
          aria-label={`New agent in ${project.name}`}
          onClick={() => setAdding(true)}
          className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface hover:text-fg"
        >
          <Plus className="size-4" />
        </button>
      </div>
      <NewAgentSheet project={project} open={adding} onClose={() => setAdding(false)} />
      <div id={regionId} hidden={!expanded} className="ml-4 space-y-1 border-l border-border pl-2">
        {visible.map((agent) => <AgentCard key={agent.id} agent={agent} all={all} />)}
      </div>
    </section>
  );
}

export function Moshpit() {
  const layout = useLayout();
  const wideMaster =
    layout.pane.kind === "pair" && layout.pane.pair === "pit-steer";
  const connected = useMoshpitStore((s) => s.connectedHostId);
  const herdrRunning = useMoshpitStore((s) => s.herdrRunning);
  const agents = useMoshpitStore((s) => s.agents);
  const filter = useMoshpitStore((s) => s.filter);
  const setFilter = useMoshpitStore((s) => s.setFilter);
  const setTab = useMoshpitStore((s) => s.setTab);
  const connectHost = useMoshpitStore((s) => s.connectHost);
  const hasDemo = useMoshpitStore((s) => s.hosts.some((host) => host.demo));
  // Connected means this session read a snapshot from the host and nothing
  // has failed since; a remembered host id alone is not a connection.
  const herdReceived = useMoshpitStore(
    (s) => s.connectedHostId !== null && s.snapshotHostId === s.connectedHostId && s.hostAccess.status === "ready" && !s.connectError,
  );
  const connectedLabel = useMoshpitStore((s) => s.hosts.find((host) => host.id === s.connectedHostId)?.label ?? "your host");
  const demoConnected = useMoshpitStore(
    (s) => s.hosts.find((host) => host.id === s.connectedHostId)?.demo,
  );
  const list = sortedAgents(agents, filter);
  const projects = groupAgentsByProject(sortedAgents(agents, "all"), connected ?? "");
  const blocked = blockedCount(agents);

  if (!connected) {
    return (
      <div className="mx-auto flex w-full max-w-xl flex-1 flex-col items-start justify-center px-6 pb-12">
        <div className="mb-6 flex size-14 items-center justify-center rounded-2xl bg-accent/10 text-accent">
          <Sprout className="size-7" strokeWidth={1.4} />
        </div>
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-subtle">
          No host
        </p>
        <h2 className="mt-3 max-w-xs text-balance text-2xl font-medium tracking-display">
          Attach a host to see who’s blocked.
        </h2>
        <p className="mt-3 max-w-xs text-pretty text-sm leading-normal text-muted">
          {hasDemo
            ? "Explore with Demo herdr, or connect your own machine through its Tailscale bridge."
            : "Add your machine's herdr bridge to bring your coding agents into one workspace."}
        </p>
        <div className="mt-6 flex gap-2">
          {hasDemo ? (
            <Button onClick={() => connectHost("demo", "explicit")}>
              Connect Demo herdr
            </Button>
          ) : null}
          <Button
            variant={hasDemo ? "secondary" : "default"}
            onClick={() => setTab("hosts")}
          >
            {hasDemo ? "Hosts" : "Connect a host"}
            <ArrowUpRight className="size-4" />
          </Button>
        </div>
        {!hasDemo ? (
          <a
            className="mt-5 inline-flex min-h-11 items-center text-sm text-muted underline decoration-border-strong underline-offset-4"
            href="/?demo=1"
          >
            Take a look around with the demo
          </a>
        ) : null}
      </div>
    );
  }

  if (!demoConnected && agents.length === 0 && herdReceived) {
    return (
      <div className="mx-auto flex w-full max-w-xl flex-1 flex-col items-start justify-center px-6 pb-12">
        <div className="mb-6 flex size-14 items-center justify-center rounded-2xl bg-working/10 text-working">
          <Sprout className="size-7" strokeWidth={1.4} />
        </div>
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-subtle">
          Connected to {connectedLabel}
        </p>
        <h2 className="mt-3 max-w-xs text-balance text-2xl font-medium tracking-display">
          No agents yet.
        </h2>
        <p className="mt-3 max-w-sm text-pretty text-sm leading-normal text-muted">
          Start one in herdr on the host: run herdr, open a pane in your
          project, and start your coding agent there, such as claude or codex.
          It appears here within a few seconds. After that, New agent beside
          the project starts more from this app.
        </p>
        <Button className="mt-6" variant="secondary" onClick={() => setTab("hosts")}>
          Open Hosts
        </Button>
      </div>
    );
  }

  if (!demoConnected && agents.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
        <LoaderCircle className="mb-5 size-8 animate-spin text-accent" />
        <h2 className="text-2xl font-medium tracking-tight">
          Waiting for your herd.
        </h2>
        <p className="mt-3 max-w-sm text-sm leading-6 text-muted">
          Your agents will appear when your host is reachable. Check that
          Tailscale and your herdr bridge are running.
        </p>
        <Button
          className="mt-6"
          variant="secondary"
          onClick={() => setTab("hosts")}
        >
          Open Hosts
        </Button>
      </div>
    );
  }

  if (!herdrRunning) {
    return <HerdrDown />;
  }

  return (
    <div className="agent-list flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="px-5 pb-5 pt-6">
        <div className="flex items-baseline justify-between">
          <h2 className="text-xl font-medium tracking-tight">Your projects</h2>
          <span className="font-mono text-xs text-subtle">
            {String(agents.length).padStart(2, "0")}
          </span>
        </div>
        <p className="mt-1.5 text-xs text-muted">
          {blocked
            ? `${blocked} ${blocked === 1 ? "agent needs" : "agents need"} a moment of your time.`
            : "Everyone has what they need."}
        </p>
      </div>
      <div
        className={
          wideMaster
            ? "flex flex-wrap gap-1 px-4 pb-4"
            : "flex gap-1 overflow-x-auto px-4 pb-4"
        }
      >
        {FILTERS.map((f) => {
          const active = filter === f.id;
          return (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              aria-pressed={active}
              className={cn(
                "h-11 shrink-0 rounded-lg px-2.5 text-xs font-medium",
                active ? "bg-surface-2 text-fg" : "text-muted hover:bg-surface",
              )}
            >
              {f.label}
              {f.id === "blocked" && blocked > 0 ? (
                <span className="ml-1.5 tabular-nums">{blocked}</span>
              ) : null}
            </button>
          );
        })}
      </div>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 pb-4">
        {list.length === 0 ? (
          <p className="px-1 py-10 text-center text-sm text-muted">
            Nothing in this filter.
          </p>
        ) : (
          projects.map((project) => (
            <ProjectSection key={project.id} project={project} all={agents} filter={filter} />
          ))
        )}
        <ShellsSection />
      </div>
    </div>
  );
}
