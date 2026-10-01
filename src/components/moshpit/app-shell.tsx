import { useState } from "react";
import { X } from "lucide-react";
import { AgentDetail } from "@/components/moshpit/agent-detail";
import { Header } from "@/components/moshpit/header";
import { Hosts } from "@/components/moshpit/hosts";
import { Inbox } from "@/components/moshpit/inbox";
import { JumpSheet } from "@/components/moshpit/jump";
import { Moshpit } from "@/components/moshpit/moshpit";
import { PrimaryNav } from "@/components/moshpit/primary-nav";
import { PwaStatus } from "@/components/moshpit/pwa";
import { useLayout } from "@/lib/moshpit/use-layout";
import { useMoshpitStore } from "@/lib/moshpit/store";

function DemoBanner() {
  const [dismissed, setDismissed] = useState(false);
  const demo = useMoshpitStore(
    (s) => s.hosts.find((h) => h.id === s.connectedHostId)?.demo ?? false,
  );
  if (dismissed || !demo) return null;
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border bg-surface/60 px-5 py-1">
      <span className="min-w-0 flex-1 truncate text-2xs text-subtle">
        You're exploring Demo herdr. Try replying to an agent.
      </span>
      <button
        type="button"
        aria-label="Dismiss"
        className="flex size-9 shrink-0 items-center justify-center rounded-sm text-subtle"
        onClick={() => setDismissed(true)}
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

function Body() {
  const layout = useLayout();
  const tab = useMoshpitStore((s) => s.tab);
  const connected = useMoshpitStore((s) => s.connectedHostId);
  const herdr = useMoshpitStore((s) => s.herdrRunning);
  const agentCount = useMoshpitStore((s) => s.agents.length);
  const live = Boolean(connected) && herdr;
  const pitPair =
    live &&
    layout.pane.kind === "pair" &&
    layout.pane.pair === "pit-steer" &&
    agentCount > 0;
  const inboxPair =
    live && layout.pane.kind === "pair" && layout.pane.pair === "inbox-steer";

  if (pitPair) {
    return (
      <div className="grid min-h-0 flex-1 grid-cols-[var(--layout-master)_minmax(0,1fr)]">
        <div className="flex min-h-0 min-w-0 flex-col overflow-clip border-r border-border">
          <Moshpit />
        </div>
        <div className="flex min-h-0 min-w-0 flex-col overflow-clip">
          <AgentDetail />
        </div>
      </div>
    );
  }

  if (inboxPair) {
    return (
      <div className="grid min-h-0 flex-1 grid-cols-[var(--layout-master)_minmax(0,1fr)]">
        <div className="flex min-h-0 min-w-0 flex-col overflow-clip border-r border-border">
          <Inbox />
        </div>
        <div className="flex min-h-0 min-w-0 flex-col overflow-clip">
          <AgentDetail />
        </div>
      </div>
    );
  }

  if (tab === "moshpit") return <Moshpit />;
  if (tab === "inbox") return <Inbox />;
  return <Hosts />;
}

export function AppShell() {
  const layout = useLayout();
  const detailOpen = useMoshpitStore((s) => Boolean(s.detailAgentId));

  if (layout.regime === "phone") {
    return (
      <div className="app-viewport flex w-full justify-center bg-bg">
        <div className="flex h-full w-full flex-col bg-bg">
          <PwaStatus />
          <div className="relative flex min-h-0 flex-1 flex-col overflow-clip">
            {detailOpen ? (
              <AgentDetail phone />
            ) : (
              <div className="flex min-h-0 flex-1 flex-col overflow-clip">
                <Header />
                <DemoBanner />
                <Body />
              </div>
            )}
            <JumpSheet />
          </div>
          <PrimaryNav />
        </div>
      </div>
    );
  }

  return (
    <div className="app-viewport flex w-full bg-bg">
      <PrimaryNav />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex min-h-0 w-full flex-1 flex-col">
          <PwaStatus />
          <div className="relative flex min-h-0 flex-1 flex-col overflow-clip">
            <Header />
            <DemoBanner />
            <Body />
            <JumpSheet />
          </div>
        </div>
      </div>
    </div>
  );
}
