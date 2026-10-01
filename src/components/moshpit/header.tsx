import { Search } from "lucide-react";
import { MoshpitMark } from "@/components/moshpit/mark";
import { useLayout } from "@/lib/moshpit/layout-context";
import { blockedCount, useMoshpitStore } from "@/lib/moshpit/store";

const TITLES = {
  moshpit: "Your workspace",
  inbox: "Inbox",
  hosts: "Hosts",
} as const;

export function Header() {
  const layout = useLayout();
  const tab = useMoshpitStore((s) => s.tab);
  const hosts = useMoshpitStore((s) => s.hosts);
  const connectedId = useMoshpitStore((s) => s.connectedHostId);
  const herdrRunning = useMoshpitStore((s) => s.herdrRunning);
  const agents = useMoshpitStore((s) => s.agents);
  const setJumpOpen = useMoshpitStore((s) => s.setJumpOpen);
  const host = hosts.find((h) => h.id === connectedId);
  const blocked = blockedCount(agents);
  const wide = layout.regime === "wide";

  return (
    <header className="flex shrink-0 items-center gap-3 border-b border-border px-5 pb-4 pt-4 lg:px-7 lg:py-5">
      {wide ? null : <MoshpitMark className="size-7 shrink-0" />}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <h1 className="text-lg font-medium tracking-tight">
            {wide ? TITLES[tab] : tab === "moshpit" ? "moshpit" : TITLES[tab]}
          </h1>
          {host?.demo ? (
            <span className="text-2xs font-medium uppercase tracking-[0.16em] text-subtle">
              demo
            </span>
          ) : null}
        </div>
        <p className="truncate text-xs text-muted">
          {host
            ? herdrRunning
              ? `${host.label} · ${agents.length} agents${
                  blocked ? ` · ${blocked} blocked` : ""
                }`
              : `${host.label} · herdr not running`
            : "A home for your coding agents"}
        </p>
      </div>
      <button
        type="button"
        onClick={() => setJumpOpen(true)}
        className="flex h-11 items-center justify-center gap-2 rounded-xl border border-border px-3 text-muted hover:bg-surface disabled:opacity-40"
        aria-label="Jump to agent"
        disabled={!connectedId || !herdrRunning}
      >
        <Search className="size-4" />
        {wide ? <span className="text-xs">Find an agent</span> : null}
      </button>
    </header>
  );
}
