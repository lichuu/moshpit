import {
  ChevronLeft,
  Ellipsis,
  Link,
  LoaderCircle,
  MessageSquareText,
  Pencil,
  SquareTerminal,
  Terminal as TerminalIcon,
  X,
} from "lucide-react";
import { useId, useRef, useState } from "react";
import { ConfirmClose } from "@/components/moshpit/confirm-close";
import { StatusPill } from "@/components/moshpit/status-pill";
import { Steer } from "@/components/moshpit/steer";
import { Terminal, TerminalLinks } from "@/components/moshpit/terminal";
import { paneLabel, projectOf } from "@/lib/moshpit/label";
import { AgentIcon } from "@/components/moshpit/agent-icon";
import { useMoshpitStore } from "@/lib/moshpit/store";
import {
  targetIsCurrent,
  useBoundAction,
  type ActionTarget,
} from "@/lib/moshpit/use-bound-action";
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

type ShellAttempt = ActionTarget & { phase: "busy" | "failed" };

// Icon-only and quiet: on a phone the word "Back" cost the agent's name its
// width, and the border it had read as a second primary action next to Shell.
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
      className="-ml-2 flex size-11 shrink-0 items-center justify-center rounded-md text-muted tap-scale"
    >
      <ChevronLeft className="size-6" />
    </button>
  );
}

const headerButton =
  "flex h-11 shrink-0 items-center justify-center rounded-md text-muted shadow-border tap-scale";

/**
 * Shell stays one tap away. It is disabled for exactly as long as the request
 * is in flight, so a second tap cannot open a second shell, and a failure
 * leaves it red until the next attempt (the store also toasts the reason).
 */
function ShellButton({
  phase,
  onClick,
}: {
  phase: ShellAttempt["phase"] | null;
  onClick: () => void;
}) {
  const busy = phase === "busy";
  return (
    <button
      type="button"
      aria-label={busy ? "Opening shell…" : "Open shell here"}
      aria-busy={busy}
      disabled={busy}
      title={
        busy
          ? "Opening…"
          : phase === "failed"
            ? "The shell did not open. Tap to try again"
            : "Interactive shell in this project; the agent keeps working"
      }
      onClick={onClick}
      className={cn(
        headerButton,
        "min-w-11 gap-1.5 px-3 text-sm font-medium disabled:opacity-60",
        phase === "failed" && "text-red-500",
      )}
    >
      {busy ? (
        <LoaderCircle className="size-4 animate-spin" />
      ) : (
        <TerminalIcon className="size-4" />
      )}
      <span className="hidden sm:inline">{busy ? "Opening…" : "Shell"}</span>
    </button>
  );
}

/**
 * Everything that is not a daily action: the full title and pane ID (selectable,
 * since the header truncates the name), Rename and Close. A disclosure of
 * ordinary buttons, not an ARIA menu, so it needs no arrow-key handling: Tab
 * walks it, Escape closes it and returns focus to its button.
 */
function AgentActions({
  title,
  paneId,
  closing,
  closeRef,
  onRename,
  onClose,
}: {
  title: string;
  paneId: string;
  /** The close dialog is up; the panel must stay mounted for focus to return. */
  closing: boolean;
  closeRef: React.RefObject<HTMLButtonElement | null>;
  onRename: () => void;
  onClose: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  const toggle = useRef<HTMLButtonElement | null>(null);
  const panelId = useId();
  useDismiss(open && !closing, () => setOpen(false), root, () =>
    toggle.current?.focus(),
  );
  const item =
    "flex h-11 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm tap-scale";
  return (
    <div ref={root} className="relative shrink-0">
      <button
        ref={toggle}
        type="button"
        aria-label="More actions"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
        className={cn(headerButton, "w-11", open && "bg-surface-2")}
      >
        <Ellipsis className="size-4" />
      </button>
      {open ? (
        <div
          id={panelId}
          role="group"
          aria-label="Agent actions"
          className="absolute right-0 top-12 z-30 w-64 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-bg p-1.5 shadow-lg"
        >
          <div className="px-2.5 pb-2 pt-1.5">
            <p className="text-2xs text-subtle">Title</p>
            <p className="select-text break-words text-sm">{title}</p>
            <p className="mt-2 text-2xs text-subtle">Pane</p>
            <p className="select-text break-all font-mono text-xs text-muted">
              {paneId}
            </p>
          </div>
          <div className="mx-1 mb-1 h-px bg-border" />
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
          <button
            ref={closeRef}
            type="button"
            aria-label="Close pane"
            onClick={onClose}
            className={cn(item, "text-red-500")}
          >
            <X className="size-4" />
            Close pane
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
  const hostId = useMoshpitStore((state) => state.connectedHostId);
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

  const agent =
    agents.find((candidate) => candidate.id === selectedId) ?? agents[0];

  // Each pending action carries the host and pane it was started for, and
  // reads as nothing once the detail view shows any other pane or host. That
  // covers the old bug where a confirmation armed on one pane closed another.
  const shown: ActionTarget | null = shell
    ? { hostId, id: shell.id }
    : agent
      ? { hostId, id: agent.id }
      : null;
  const [renaming, setRenaming] = useBoundAction<ActionTarget & { draft: string }>(shown);
  const [closing, setClosing] = useBoundAction<ActionTarget>(shown);
  const [shellAttempt, setShellAttempt] = useBoundAction<ShellAttempt>(shown);
  const renameSettled = useRef(false);
  const closeTrigger = useRef<HTMLButtonElement | null>(null);

  const confirmClose = (target: ActionTarget) => {
    setClosing(null);
    // The store may have moved on between render and tap.
    if (targetIsCurrent(target)) void closeAgent(target.id);
  };

  if (shell) {
    const target = { hostId, id: shell.id };
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
                  ref={closeTrigger}
                  type="button"
                  aria-label="Close shell"
                  onClick={() => setClosing(target)}
                  className={cn(headerButton, "w-11")}
                >
                  <X className="size-4" />
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
        <ConfirmClose
          open={closing !== null}
          title="Close this shell?"
          description="Close ends the shell pane and anything running in it. The files in its checkout stay as they are."
          confirmLabel="Close shell"
          onCancel={() => setClosing(null)}
          onConfirm={() => closing && confirmClose(closing)}
          restoreFocus={() => closeTrigger.current}
        />
      </section>
    );
  }

  if (!agent) return null;

  const label = paneLabel(agent, agents);
  const target = { hostId, id: agent.id };
  const openRename = () => {
    renameSettled.current = false;
    setRenaming({ ...target, draft: label.name });
  };
  const settleRename = (commit: boolean) => {
    if (renameSettled.current || !renaming) return;
    renameSettled.current = true;
    setRenaming(null);
    if (commit && targetIsCurrent(renaming)) {
      void renameAgent(renaming.id, renaming.draft);
    }
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
    const attempt: ShellAttempt = { ...target, phase: "busy" };
    setShellAttempt(attempt);
    // Settles on the real outcome of the request. A newer attempt, or a
    // different pane on screen by then, has already replaced or cleared this
    // one, and the store keeps the user where they are.
    void openShell(agent.cwd, () => targetIsCurrent(target)).then((ok) =>
      setShellAttempt((now) =>
        now === attempt ? (ok ? null : { ...attempt, phase: "failed" }) : now,
      ),
    );
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
            {renaming ? (
              <div className="flex min-w-0 items-center gap-2">
                <input
                  autoFocus
                  value={renaming.draft}
                  onChange={(event) =>
                    setRenaming({ ...renaming, draft: event.target.value })
                  }
                  maxLength={100}
                  aria-label="New name"
                  onKeyDown={onRenameKey}
                  className="h-11 w-full min-w-0 border-b border-border bg-transparent text-lg font-medium tracking-tight outline-none"
                />
                <button
                  type="button"
                  aria-label="Cancel rename"
                  onClick={() => settleRename(false)}
                  className={cn(headerButton, "px-3 text-sm font-medium")}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  aria-label="Save rename"
                  onClick={() => settleRename(true)}
                  disabled={!renaming.draft.trim()}
                  className={cn(headerButton, "px-3 text-sm font-medium disabled:opacity-40")}
                >
                  Save
                </button>
              </div>
            ) : (
              <h2 className="line-clamp-2 break-words text-lg font-medium leading-tight tracking-tight">
                {label.name}
              </h2>
            )}
            <p className="mt-1 flex min-w-0 items-center gap-2 text-xs text-muted">
              <StatusPill status={agent.status} live className="shrink-0" />
              <AgentIcon kind={agent.kind} className="shrink-0" />
              <span className="truncate [text-wrap:nowrap]">{label.detail}</span>
            </p>
          </div>
          {/* Beside the whole title block, not in the name row, so it centres
              on both lines the way Back does opposite. Renaming borrows the
              row for the field, and these are the wrong controls to leave
              live mid-rename. */}
          {renaming ? null : (
            <>
              <ShellButton
                phase={shellAttempt?.phase ?? null}
                onClick={openShellHere}
              />
              <AgentActions
                key={agent.id}
                title={label.name}
                paneId={agent.paneId}
                closing={closing !== null}
                closeRef={closeTrigger}
                onRename={openRename}
                onClose={() => setClosing(target)}
              />
            </>
          )}
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

      <ConfirmClose
        open={closing !== null}
        title={`Close ${label.name}?`}
        description="Close ends the pane and the agent running in it. The files in its checkout stay as they are."
        confirmLabel="Close pane"
        onCancel={() => setClosing(null)}
        onConfirm={() => closing && confirmClose(closing)}
        restoreFocus={() => closeTrigger.current}
      />
    </section>
  );
}
