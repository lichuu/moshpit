import {
  ChevronLeft,
  Ellipsis,
  Link,
  MessageSquareText,
  Pencil,
  SquareTerminal,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { StatusPill } from "@/components/moshpit/status-pill";
import { Steer } from "@/components/moshpit/steer";
import { Terminal, TerminalLinks } from "@/components/moshpit/terminal";
import { paneLabel, projectOf } from "@/lib/moshpit/label";
import { AgentIcon } from "@/components/moshpit/agent-icon";
import { useMoshpitStore } from "@/lib/moshpit/store";
import { useDismiss } from "@/lib/moshpit/use-dismiss";
import type { AgentView } from "@/lib/moshpit/types";
import { cn } from "@/lib/utils";

const VIEWS: {
  id: AgentView;
  label: string;
  ariaLabel: string;
  icon: typeof MessageSquareText;
}[] = [
  {
    id: "chat",
    label: "Chat",
    ariaLabel: "Chat view",
    icon: MessageSquareText,
  },
  {
    id: "terminal",
    label: "Terminal",
    ariaLabel: "Terminal view",
    icon: SquareTerminal,
  },
  {
    id: "links",
    label: "Links",
    ariaLabel: "Links view",
    icon: Link,
  },
];

// Icon-only: on a phone the word "Back" cost the agent's name its width. It
// keeps the bordered button shape, matching the actions menu opposite, so it
// still reads as something to tap.
function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label="Back"
      // Keep focus where it is on press. With the soft keyboard up, the press
      // blurred the composer, the keyboard's close resized the app under the
      // finger, and the tap never landed: the first tap only closed the
      // keyboard. Send avoids the same trap the same way.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      autoFocus
      className="flex size-10 shrink-0 items-center justify-center rounded-md text-muted shadow-border tap-scale"
    >
      <ChevronLeft className="size-5" />
    </button>
  );
}

/**
 * Phone header actions. Three buttons beside the name left it a few
 * characters wide; the name is what identifies the pane, so it gets the row.
 */
function ActionsMenu({ openingShell, confirmingClose, onShell, onRename, onClose }: {
  openingShell: boolean;
  confirmingClose: boolean;
  onShell: () => void;
  onRename: () => void;
  onClose: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  useDismiss(open, () => setOpen(false), root);
  const item =
    "flex h-11 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm tap-scale";
  return (
    <div ref={root} className="relative shrink-0">
      <button
        type="button"
        aria-label="More actions"
        aria-expanded={open}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex size-10 items-center justify-center rounded-md text-muted shadow-border tap-scale",
          open && "bg-surface-2",
        )}
      >
        <Ellipsis className="size-4" />
      </button>
      {open ? (
        <div
          role="group"
          aria-label="Agent actions"
          className="absolute right-0 top-12 z-30 w-52 rounded-xl border border-border bg-bg p-1.5 shadow-lg"
        >
          <button
            type="button"
            aria-label={openingShell ? "Opening shell…" : "Open shell here"}
            onClick={() => {
              setOpen(false);
              onShell();
            }}
            className={item}
          >
            <SquareTerminal className="size-4 text-muted" />
            {openingShell ? "Opening…" : "Open shell here"}
          </button>
          <button
            type="button"
            aria-label="Rename agent"
            onClick={() => {
              setOpen(false);
              onRename();
            }}
            className={item}
          >
            <Pencil className="size-4 text-muted" />
            Rename
          </button>
          {/* The first tap arms, the second closes: the menu stays open so the
              confirm lands where the finger already is. */}
          <button
            type="button"
            aria-label={confirmingClose ? "Really close?" : "Close pane"}
            onClick={() => {
              if (confirmingClose) setOpen(false);
              onClose();
            }}
            className={cn(item, confirmingClose && "text-red-500")}
          >
            <X className="size-4" />
            {confirmingClose ? "Really close?" : "Close pane"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function AgentDetail({ phone = false }: { phone?: boolean }) {
  const agents = useMoshpitStore((state) => state.agents);
  const selectedId = useMoshpitStore((state) => state.selectedAgentId);
  const selectedShellId = useMoshpitStore((state) => state.selectedShellId);
  const shells = useMoshpitStore((state) => state.shells);
  const shell = selectedShellId
    ? shells.find((s) => s.id === selectedShellId)
    : undefined;
  const detailView = useMoshpitStore((state) => state.detailView);
  const closeDetail = useMoshpitStore((state) => state.closeDetail);
  const setDetailView = useMoshpitStore((state) => state.setDetailView);
  const renameAgent = useMoshpitStore((state) => state.renameAgent);
  const closeAgent = useMoshpitStore((state) => state.closeAgent);
  const openShell = useMoshpitStore((state) => state.openShell);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  // Keyed by the pane the confirm was armed for. One shared boolean meant a
  // confirm armed on a shell was still live when the user switched to an
  // agent, so a single tap closed that agent's pane with no confirmation.
  const [closeConfirm, setCloseConfirm] = useState<string | null>(null);
  const renameSettled = useRef(false);
  useEffect(() => {
    if (!closeConfirm) return;
    const timer = window.setTimeout(() => setCloseConfirm(null), 4000);
    return () => window.clearTimeout(timer);
  }, [closeConfirm]);
  // A shell in a dead pane (closed on the host) still shows as a target the
  // user can recreate from: the open action re-checks the pane.
  const [openingShell, setOpeningShell] = useState(false);
  useEffect(() => {
    if (!openingShell) return;
    const timer = window.setTimeout(() => setOpeningShell(false), 10000);
    return () => window.clearTimeout(timer);
  }, [openingShell]);

  const agent =
    agents.find((candidate) => candidate.id === selectedId) ?? agents[0];

  const onCloseTap = (target: string) => {
    if (closeConfirm !== target) {
      setCloseConfirm(target);
      return;
    }
    setCloseConfirm(null);
    void closeAgent(target);
  };

  if (shell) {
    return (
      <section
        className="flex min-h-0 flex-1 flex-col bg-bg"
        role={phone ? "dialog" : undefined}
        aria-label={phone ? "Shell detail" : undefined}
      >
        <header
          className={cn(
            "shrink-0 border-b border-border px-4 pb-0 lg:px-7",
            phone ? "pt-4" : "pt-6",
          )}
        >
          <div className="flex min-w-0 items-center gap-2">
            {phone ? (
              <BackButton onClick={closeDetail} />
            ) : null}
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <h2 className="truncate text-base font-medium tracking-tight">
                  Shell
                </h2>
                <span className="shrink-0 rounded-md bg-accent/10 px-1.5 py-1 text-2xs font-medium text-accent">
                  companion shell
                </span>
                <button
                  type="button"
                  aria-label={closeConfirm === shell.id ? "Really close?" : "Close shell"}
                  onClick={() => onCloseTap(shell.id)}
                  className={cn(
                    "flex h-10 shrink-0 items-center justify-center rounded-md px-2 text-sm font-medium shadow-border tap-scale",
                    closeConfirm === shell.id ? "text-red-500" : "text-muted",
                  )}
                >
                  {closeConfirm === shell.id ? "Really close?" : <X className="size-4" />}
                </button>
              </div>
              <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
                <SquareTerminal className="size-3.5 shrink-0" />
                <span className="truncate [text-wrap:nowrap]">
                  interactive shell · {projectOf(shell.cwd) || shell.cwd}
                  <span className="text-subtle"> · {shell.id}</span>
                </span>
              </p>
              <p className="mt-1 text-xs text-subtle">
                Commands here affect this checkout, not the agent's session.
              </p>
            </div>
          </div>
        </header>
        <Terminal />
      </section>
    );
  }

  if (!agent) return null;

  const label = paneLabel(agent, agents);
  const openRename = () => {
    renameSettled.current = false;
    setDraft(label.name);
    setRenaming(true);
  };
  const settleRename = (commit: boolean) => {
    if (renameSettled.current) return;
    renameSettled.current = true;
    setRenaming(false);
    if (commit) void renameAgent(agent.id, draft);
  };
  const onRenameKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      settleRename(true);
    } else if (event.key === "Escape") {
      settleRename(false);
    }
  };
  const openShellHere = () => {
    setOpeningShell(true);
    void openShell(agent.cwd).finally(() => setOpeningShell(false));
  };

  return (
    <section
      className="flex min-h-0 flex-1 flex-col bg-bg"
      role={phone ? "dialog" : undefined}
      aria-label={phone ? "Agent detail" : undefined}
    >
      <header
        className={cn(
          "shrink-0 border-b border-border px-4 pb-0 lg:px-7",
          phone ? "pt-4" : "pt-6",
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          {phone ? (
            <BackButton onClick={closeDetail} />
          ) : null}
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              {renaming ? (
                <>
                  <input
                    autoFocus
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    maxLength={100}
                    aria-label="New name"
                    onKeyDown={onRenameKey}
                    className="w-full min-w-0 border-b border-border bg-transparent text-base font-medium tracking-tight outline-none"
                  />
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      aria-label="Cancel rename"
                      onClick={() => settleRename(false)}
                      className="flex h-9 shrink-0 items-center rounded-md px-2 text-sm font-medium text-muted shadow-border tap-scale"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      aria-label="Save rename"
                      onClick={() => settleRename(true)}
                      disabled={!draft.trim()}
                      className="flex h-9 shrink-0 items-center rounded-md px-2 text-sm font-medium text-muted shadow-border tap-scale disabled:opacity-40"
                    >
                      Save
                    </button>
                  </div>
                </>
              ) : (
                <h2 className="truncate text-base font-medium tracking-tight">
                  {label.name}
                </h2>
              )}
              {/* Renaming borrows the whole row. These sat beside the input and
                  squeezed it to zero width at phone sizes, so the field you were
                  meant to type in was not visible at all. They are also the wrong
                  controls to leave live mid-rename. */}
              {!renaming && (
                <>
                <StatusPill status={agent.status} className="shrink-0" />
                {phone ? null : (
                  <>
                    <button
                      type="button"
                      aria-label={openingShell ? "Opening shell…" : "Open shell here"}
                      title={
                        openingShell
                          ? "Opening…"
                          : "Interactive shell in this project; the agent keeps working"
                      }
                      onClick={openShellHere}
                      className="flex h-10 shrink-0 items-center justify-center rounded-md px-2 text-sm font-medium text-muted shadow-border tap-scale disabled:opacity-50"
                    >
                      {openingShell ? "Opening…" : "Shell"}
                    </button>
                    <button
                      type="button"
                      aria-label="Rename agent"
                      onClick={openRename}
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-sm font-medium text-muted shadow-border tap-scale"
                    >
                      <Pencil className="size-4" />
                    </button>
                    <button
                      type="button"
                      aria-label={closeConfirm === agent.id ? "Really close?" : "Close pane"}
                      onClick={() => onCloseTap(agent.id)}
                      className={cn(
                        "flex h-10 shrink-0 items-center justify-center rounded-md px-2 text-sm font-medium shadow-border tap-scale",
                        closeConfirm === agent.id ? "text-red-500" : "text-muted",
                      )}
                    >
                      {closeConfirm === agent.id ? "Really close?" : <X className="size-4" />}
                    </button>
                  </>
                )}
                </>
              )}
            </div>
            <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
              <AgentIcon kind={agent.kind} className="shrink-0" />
              <span className="truncate [text-wrap:nowrap]">
                {label.detail}
                <span className="text-subtle"> · {agent.paneId}</span>
              </span>
            </p>
          </div>
          {/* Beside the whole title block, not in the name row, so it centres
              on both lines the way Back does opposite. */}
          {phone && !renaming ? (
            <ActionsMenu
              openingShell={openingShell}
              confirmingClose={closeConfirm === agent.id}
              onShell={openShellHere}
              onRename={openRename}
              onClose={() => onCloseTap(agent.id)}
            />
          ) : null}
        </div>

        <nav aria-label="Agent views" className="detail-views mt-4 flex gap-4">
          {VIEWS.map((view) => {
            const active = detailView === view.id;
            const Icon = view.icon;
            return (
              <button
                key={view.id}
                type="button"
                aria-label={view.ariaLabel}
                aria-current={active ? "page" : undefined}
                onClick={() => setDetailView(view.id)}
                className={cn(
                  "flex h-11 flex-1 items-center justify-center gap-2 border-b-2 text-xs font-medium lg:flex-none lg:px-3",
                  active
                    ? "border-accent text-accent"
                    : "border-transparent text-muted hover:text-fg",
                )}
              >
                <Icon className="size-4" strokeWidth={active ? 2.2 : 1.7} />
                {view.label}
              </button>
            );
          })}
        </nav>
      </header>

      {detailView === "terminal" ? (
        <Terminal />
      ) : detailView === "links" ? (
        <TerminalLinks />
      ) : (
        <Steer view={detailView} />
      )}
    </section>
  );
}
