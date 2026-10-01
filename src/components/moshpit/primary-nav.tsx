import { Inbox, Radio, Server, ArrowUpRight } from "lucide-react";
import { MoshpitMark } from "@/components/moshpit/mark";
import { useLayout } from "@/lib/moshpit/layout-context";
import {
  blockedCount,
  inboxUnread,
  useMoshpitStore,
} from "@/lib/moshpit/store";
import type { TabId } from "@/lib/moshpit/types";
import { cn } from "@/lib/utils";

const ITEMS: { id: TabId; label: string; icon: typeof Radio }[] = [
  { id: "moshpit", label: "moshpit", icon: Radio },
  { id: "inbox", label: "Inbox", icon: Inbox },
  { id: "hosts", label: "Hosts", icon: Server },
];

export function PrimaryNav() {
  const layout = useLayout();
  const tab = useMoshpitStore((s) => s.tab);
  const setTab = useMoshpitStore((s) => s.setTab);
  const blocked = useMoshpitStore((s) => blockedCount(s.agents));
  const unread = useMoshpitStore((s) => inboxUnread(s.events));
  const connected = useMoshpitStore((s) => s.connectedHostId);
  const herdrRunning = useMoshpitStore((s) => s.herdrRunning);
  const host = useMoshpitStore((s) =>
    s.hosts.find((h) => h.id === s.connectedHostId),
  );
  const side = layout.chrome === "side";

  return (
    <nav
      className={
        side
          ? "workspace-nav flex w-[var(--layout-sidebar)] shrink-0 flex-col gap-1 border-r border-border px-3 pt-4 pb-4"
          : "workspace-nav grid shrink-0 grid-cols-3 border-t border-border pb-safe"
      }
      aria-label="Primary"
    >
      {side ? (
        <>
          <div className="sidebar-brand flex items-center gap-2.5 px-3 pb-10 pt-3">
            <MoshpitMark className="size-8 shrink-0" />
            <span className="sidebar-label text-xl font-semibold tracking-tight">
              moshpit<span className="text-accent">.</span>
            </span>
          </div>
          <p className="sidebar-heading px-3 pb-2 text-2xs font-medium uppercase tracking-[0.15em] text-subtle">
            Workspace
          </p>
        </>
      ) : null}
      {ITEMS.map((item) => {
        const active = tab === item.id;
        const Icon = item.icon;
        const badge =
          item.id === "moshpit" && connected && blocked > 0
            ? blocked
            : item.id === "inbox" && connected && herdrRunning && unread > 0
              ? unread
              : 0;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => setTab(item.id)}
            className={cn(
              "relative rounded-lg font-medium",
              side
                ? "flex h-11 items-center gap-3 px-3 text-sm"
                : "flex h-14 flex-col items-center justify-center gap-0.5 text-2xs",
              active ? "text-fg md:bg-bg/70" : "text-muted",
            )}
            title={item.label === "moshpit" ? "Your agents" : item.label}
            aria-current={active ? "page" : undefined}
          >
            <span className="relative">
              <Icon className="size-5" strokeWidth={active ? 2.2 : 1.7} />
              {badge ? (
                <span className="absolute -right-2 -top-1 min-w-3.5 rounded-full bg-blocked px-1 text-center text-2xs leading-4 text-blocked-fg tabular-nums">
                  {badge}
                </span>
              ) : null}
            </span>
            <span className={side ? "sidebar-label" : undefined}>
              {item.label}
            </span>
          </button>
        );
      })}
      {side ? (
        <div className="sidebar-footer mt-auto px-3 pt-8">
          <div className="mb-5 rounded-xl border border-border bg-bg/60 p-3">
            <p className="flex items-center gap-2 text-xs font-medium">
              <Server className="size-3.5 shrink-0 text-muted" />
              <span className="min-w-0 truncate" title={host?.label}>
                {host?.label ?? "Your machines"}
              </span>
            </p>
            <p className="mt-1.5 text-2xs leading-relaxed text-muted">
              {host?.demo
                ? "A small herd to explore."
                : host
                  ? "Available through your tailnet."
                  : "Connect a host to bring your agents here."}
            </p>
            <button
              type="button"
              onClick={() => setTab("hosts")}
              className="mt-2 flex min-h-9 items-center gap-1 text-xs text-accent"
            >
              Manage hosts <ArrowUpRight className="size-3" />
            </button>
          </div>
          <p className="text-2xs text-subtle">
            Built around <a
              href="https://herdr.dev"
              target="_blank"
              rel="noreferrer"
              className="font-mono text-muted underline"
            >
              herdr
            </a>
          </p>
          <p className="mt-1 text-2xs text-subtle">
            Your agents. Your machines.
          </p>
        </div>
      ) : null}
    </nav>
  );
}
