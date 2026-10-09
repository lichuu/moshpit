import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Power } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Composer } from "@/components/moshpit/composer";
import { PaneSurface, type PaneHandle, type PaneStatus, type PaneTarget } from "@/components/moshpit/pane-surface";
import { extractLinks, linkKey } from "@/lib/moshpit/links";
import { bridgeUrl } from "@/lib/moshpit/bridge";
import { projectOf } from "@/lib/moshpit/label";
import { useLayout } from "@/lib/moshpit/use-layout";
import { useMoshpitStore } from "@/lib/moshpit/store";
import { draftSessionId, draftStore } from "@/lib/moshpit/drafts";
import { validateImage } from "@/lib/moshpit/image";
import { useDismiss } from "@/lib/moshpit/use-dismiss";
import { useMoreToRight } from "@/lib/moshpit/use-more-to-right";
import { cn } from "@/lib/utils";
import type { TermSize } from "@/lib/moshpit/types";

// Most-reached first: on a phone the strip scrolls, and whatever sits past
// the edge is a swipe away.
function keyBar(prefix: string) {
  return [
    "esc",
    "backspace",
    "ctrl+c",
    "tab",
    "up",
    "down",
    "left",
    "right",
    "shift+tab",
    prefix,
    "ctrl+d",
    "ctrl+l",
  ];
}

const SIZE_ORDER: TermSize[] = ["sm", "md", "lg"];
const SIZE_LABEL: Record<TermSize, string> = { sm: "S", md: "M", lg: "L" };
/**
 * Wrap and size behind one button. They are set-and-forget (pinch and
 * ctrl+wheel still resize), so they should not cost the key strip its width.
 */
function DisplayOptions({ onDone }: { onDone: () => void }) {
  const termSize = useMoshpitStore((s) => s.settings.termSize);
  const wrap = useMoshpitStore((s) => s.settings.termWrap);
  const updateSettings = useMoshpitStore((s) => s.updateSettings);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);

  useDismiss(open, () => setOpen(false), root, onDone);

  return (
    <div ref={root} className="relative shrink-0">
      <button
        type="button"
        aria-label="Display options"
        aria-expanded={open}
        title="Wrap and text size"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex h-9 items-center justify-center rounded-sm px-2.5 text-xs font-medium text-muted shadow-border",
          open && "bg-surface-2",
        )}
      >
        Aa
      </button>
      {open ? (
        <div
          role="group"
          aria-label="Terminal display"
          className="absolute bottom-11 right-0 z-20 w-56 rounded-xl border border-border bg-bg p-2 shadow-lg"
        >
          <button
            type="button"
            aria-label="Wrap long lines"
            aria-pressed={wrap}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => updateSettings({ termWrap: !wrap })}
            className="flex h-10 w-full items-center justify-between rounded-lg px-2 text-sm"
          >
            Wrap long lines
            <span
              aria-hidden
              className={cn(
                "flex size-4 items-center justify-center rounded-sm shadow-border",
                wrap && "text-fg",
              )}
            >
              {wrap ? <Check className="size-3" /> : null}
            </span>
          </button>
          <div className="flex items-center justify-between px-2 pt-1">
            <span className="text-sm">Text size</span>
            <div className="flex gap-1">
              {SIZE_ORDER.map((size) => (
                <button
                  key={size}
                  type="button"
                  aria-label={`Text size ${SIZE_LABEL[size]}`}
                  aria-pressed={termSize === size}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => updateSettings({ termSize: size })}
                  className={cn(
                    "size-9 rounded-sm text-xs font-medium",
                    termSize === size ? "bg-surface-2 text-fg shadow-border" : "text-muted",
                  )}
                >
                  {SIZE_LABEL[size]}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ShellView() {
  const startHerdr = useMoshpitStore((s) => s.startHerdr);
  const host = useMoshpitStore((s) =>
    s.hosts.find((h) => h.id === s.connectedHostId),
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col items-start justify-center px-6">
      <p className="text-xs font-medium uppercase tracking-[0.18em] text-blocked">
        herdr not running
      </p>
      <h2 className="mt-3 max-w-sm text-balance text-2xl font-medium tracking-display">
        Nothing to attach to on {host?.label ?? "this host"}.
      </h2>
      <p className="mt-3 max-w-sm text-sm text-muted">
        The bridge answered, but herdr reported no panes. Start it on the
        machine and the panes appear here.
      </p>
      {host?.demo ? (
        <Button className="mt-6" onClick={startHerdr}>
          <Power className="size-4" />
          Start herdr
        </Button>
      ) : null}
    </div>
  );
}

const PANE_LABEL: Record<PaneStatus["state"], string> = {
  connecting: "Connecting to the pane",
  connected: "Live PTY",
  retrying: "Reconnecting to the pane",
  disconnected: "Pane disconnected",
};

/** The pane's connection, said in words once it is anything but live. */
export function PaneStatusLabel({ status, shell, paneId }: { status: PaneStatus; shell: boolean; paneId: string }) {
  const live = status.state === "connected";
  const name = live && shell ? "Live shell PTY" : PANE_LABEL[status.state];
  const text =
    status.state === "connecting" ? "Connecting…"
      : status.state === "retrying" ? `Reconnecting${status.attempt > 1 ? ` · ${status.attempt}` : ""}`
        : status.state === "disconnected" ? (typeof navigator !== "undefined" && !navigator.onLine ? "Offline" : "Disconnected")
          : null;
  return (
    <span
      role="status"
      aria-label={name}
      title={live ? `${name} · ${paneId}` : [name, status.error].filter(Boolean).join(" — ") + " — the pane below may be stale"}
      className="flex shrink-0 items-center gap-1.5"
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          live ? "bg-working motion-pulse" : status.state === "connecting" ? "bg-subtle" : "bg-blocked",
        )}
      />
      {text ? <span aria-hidden className="text-2xs font-medium text-muted">{text}</span> : null}
    </span>
  );
}

export function Terminal() {
  const layout = useLayout();
  const agents = useMoshpitStore((s) => s.agents);
  const shells = useMoshpitStore((s) => s.shells);
  const selectedShellId = useMoshpitStore((s) => s.selectedShellId);
  const focusedPaneId = useMoshpitStore((s) => s.focusedPaneId);
  const selectedAgentId = useMoshpitStore((s) => s.selectedAgentId);
  const connected = useMoshpitStore((s) => s.connectedHostId);
  const herdrRunning = useMoshpitStore((s) => s.herdrRunning);
  const sendKeys = useMoshpitStore((s) => s.sendKeys);
  const addAgentLinks = useMoshpitStore((s) => s.addAgentLinks);
  const prefix = useMoshpitStore((s) => s.settings.prefix);

  // A selected shell wins over the agent: its pane is the terminal target,
  // and input must never leak into the coding agent's pane.
  const shell = selectedShellId
    ? shells.find((s) => s.id === selectedShellId)
    : undefined;
  const agent = shell
    ? undefined
    : agents.find((a) => a.paneId === focusedPaneId) ??
      agents.find((a) => a.id === selectedAgentId) ??
      agents[0];
  const targetId = shell?.id ?? agent?.id;
  // The composer is agent-shaped; a shell borrows the shape for its pane id
  // without a session of its own (terminal mode only, unresolved session).
  // Memoised on the shell's identity: Composer is memo()'d, so a fresh object
  // literal here re-rendered it on every terminal frame.
  const composerAgent = useMemo(() => shell
    ? {
        id: shell.id,
        name: "shell",
        kind: "shell",
        status: "working" as const,
        workspace: "",
        tab: "shell",
        paneId: shell.id,
        cwd: shell.cwd,
        branch: "",
        lastOutput: "",
        lines: [],
        attention: false,
        statusChangedAt: 0,
        workTicks: 0,
        ticks: 0,
        nextStatus: null,
        blockedPrompt: null,
      }
    : agent, [shell, agent]);

  const strip = useRef<HTMLDivElement | null>(null);
  const [quickSlot, setQuickSlot] = useState<HTMLDivElement | null>(null);
  const moreKeys = useMoreToRight(strip, layout.regime !== "wide");
  const surface = useRef<PaneHandle | null>(null);
  const terminalRoot = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<PaneStatus>({ state: "connecting", attempt: 0, error: null });
  const [paneFocused, setPaneFocused] = useState(false);
  const host = useMoshpitStore(
    (s) => s.hosts.find((h) => h.id === s.connectedHostId) ?? null,
  );
  const hostUrl = host ? bridgeUrl(host) : "";
  const terminalDraft = connected && composerAgent
    ? draftStore([connected, draftSessionId(composerAgent, Boolean(host?.demo)), "terminal"])
    : undefined;
  const attachImage = useCallback((image: File) => {
    if (!terminalDraft || terminalDraft.getSnapshot().draft.submission?.state === "submitting") return;
    const error = validateImage(image);
    if (error) { toast(error); return; }
    terminalDraft.update({ attachment: image });
    requestAnimationFrame(() => terminalRoot.current?.querySelector<HTMLTextAreaElement>('textarea[aria-label="Terminal input"]')?.focus());
  }, [terminalDraft]);
  useEffect(() => {
    const pasteImage = (event: ClipboardEvent) => {
      const image = event.clipboardData?.files[0];
      if (!image || !terminalRoot.current?.contains(document.activeElement)) return;
      event.preventDefault();
      event.stopPropagation();
      attachImage(image);
    };
    document.addEventListener("paste", pasteImage, true);
    return () => document.removeEventListener("paste", pasteImage, true);
  }, [attachImage]);

  // Demo host: the pane view is the seeded log, not a bridge stream.
  const demoSource = host?.tailnetUrl ? undefined : shell ? shell.lines : agent?.lines;
  const demoLines = useMemo(
    () => (host?.tailnetUrl ? undefined : (demoSource ?? []).slice(-60).map((l) => l.text)),
    [host?.tailnetUrl, demoSource],
  );
  useEffect(() => {
    // Demo-only: the seed lines are the pane's output here. Real-herdr
    // snapshot lines are title-only and never feed the link list. Shell panes
    // are skipped: link lists are keyed by agent session and the Links view
    // resolves an agent, so a shell has nowhere to show them.
    const state = useMoshpitStore.getState();
    const h = state.hosts.find((x) => x.id === state.connectedHostId);
    if (!h || h.tailnetUrl || shell || !agent || !demoLines) return;
    addAgentLinks(linkKey(h.id, agent.id, agent.sessionId, h.demo), extractLinks(demoLines.join("\n")));
  }, [demoLines, agent, shell, addAgentLinks]);

  if (!connected || !targetId) {
    return (
      <div className="flex flex-1 flex-col items-start justify-center px-6">
        <h2 className="text-balance text-2xl font-medium tracking-display">
          No pane attached.
        </h2>
      </div>
    );
  }

  if (!herdrRunning) {
    return <ShellView />;
  }

  const target: PaneTarget = { hostId: connected, url: hostUrl, paneId: targetId, nativeSessionId: agent?.sessionId };
  const send = (key: string) => {
    if (!surface.current) sendKeys(targetId, key);
    else surface.current.send(key);
  };

  // The composer's own draft for this pane: the text lands there unsent,
  // after anything already typed, for review and an explicit submit.
  function transfer(text: string) {
    const draft = terminalDraft;
    if (!draft) return;
    const current = draft.getSnapshot().draft.text;
    draft.update({ text: current ? `${current}\n${text}` : text });
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Terminal input"]')?.focus());
  }

  function swipe(dir: "left" | "right") {
    for (const key of [prefix, dir === "left" ? "l" : "h"]) send(key);
    toast(
      dir === "left" ? `${prefix} l — next tab` : `${prefix} h — previous tab`,
    );
  }

  return (
    <div ref={terminalRoot} className="flex min-h-0 min-w-0 flex-1 flex-col"
      onDragOverCapture={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
      onDropCapture={(event) => {
        if (event.target instanceof Element && event.target.closest(".composer-wrap")) return;
        const image = event.dataTransfer.files[0];
        if (!image) return;
        event.preventDefault();
        event.stopPropagation();
        attachImage(image);
      }}>
      <PaneSurface
        // One mount per host and pane: a switch starts from empty rows, and
        // nothing from the old socket can reach the new one. Layout changes
        // (rotation, resize) keep the mount and its connection.
        key={JSON.stringify([target.hostId, target.url, target.paneId])}
        target={target}
        label={shell ? `Shell pane ${shell.id}` : `Pane ${agent?.paneId}`}
        demoLines={demoLines}
        linkKey={host && agent && host.tailnetUrl ? linkKey(host.id, agent.id, agent.sessionId, host.demo) : null}
        handle={surface}
        fallbackSend={(key) => sendKeys(targetId, key)}
        onStatus={setStatus}
        onFocusChange={setPaneFocused}
        onSwipe={swipe}
        onTransfer={transfer}
        autoFocus={layout.regime === "wide"}
      />
      <div className="terminal-keys border-t border-border bg-bg px-3 pb-3 pt-2">
        {/* Liveness, keys and size share one row. The pane name lives in the
            detail header, and a permanently displayed hint is worth less than
            the ~70px of pane it used to cost. */}
        <div className="mb-2 flex items-center gap-2">
          <PaneStatusLabel status={status} shell={Boolean(shell)} paneId={shell?.id ?? agent?.paneId ?? targetId} />
          {shell ? (
            <span
              aria-label="Input goes to the companion shell, not the agent"
              className="shrink-0 rounded-md bg-accent/10 px-1.5 py-1 text-2xs font-medium text-accent"
            >
              shell · {projectOf(shell.cwd)}
            </span>
          ) : null}
          <div
            ref={strip}
            className={
              layout.regime === "wide"
                ? "flex min-w-0 flex-1 flex-wrap gap-1"
                : "flex min-w-0 flex-1 gap-1 overflow-x-auto"
            }
            // A key cut clean in half reads as broken; a fade reads as "more".
            style={
              moreKeys
                ? {
                    maskImage: "linear-gradient(to right, black calc(100% - 28px), transparent)",
                    WebkitMaskImage: "linear-gradient(to right, black calc(100% - 28px), transparent)",
                  }
                : undefined
            }
          >
            {keyBar(prefix).map((k) => (
              <button
                key={k}
                type="button"
                aria-label={k === "backspace" ? "Backspace" : undefined}
                // Keep focus on the pane so the key bar never interrupts typing.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  send(k);
                  surface.current?.focus();
                }}
                className="h-9 shrink-0 rounded-sm bg-surface-2 px-2.5 font-mono text-xs text-muted shadow-border"
              >
                {k === "backspace" ? "⌫" : k.startsWith("ctrl+") ? `^${k.slice(5).toUpperCase()}` : k}
              </button>
            ))}
          </div>
          {/* Touch has no Escape-to-blur: while the pane holds raw input,
              this hands the page back for scrolling, selecting or the
              composer. */}
          {paneFocused && layout.regime !== "wide" ? (
            <button
              type="button"
              aria-label="Leave terminal input"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => surface.current?.blur()}
              className="h-9 shrink-0 rounded-sm px-2.5 text-xs font-medium text-muted shadow-border"
            >
              Done
            </button>
          ) : null}
          {/* The composer portals its command and quick-reply buttons in here. */}
          <div ref={setQuickSlot} className="flex shrink-0 gap-1 empty:hidden" />
          <DisplayOptions onDone={() => surface.current?.focus()} />
        </div>
      </div>
      {composerAgent && <Composer agent={composerAgent} mode="terminal" quickRepliesSlot={quickSlot} />}
    </div>
  );
}

/**
 * URLs observed in this agent's terminal output, with explicit Open and Copy.
 * The list lives in the store: it survives view switches, not reloads.
 */
export function TerminalLinks() {
  const agents = useMoshpitStore((s) => s.agents);
  const focusedPaneId = useMoshpitStore((s) => s.focusedPaneId);
  const selectedAgentId = useMoshpitStore((s) => s.selectedAgentId);
  const connected = useMoshpitStore((s) => s.connectedHostId);
  const hosts = useMoshpitStore((s) => s.hosts);
  const agentLinks = useMoshpitStore((s) => s.agentLinks);

  const agent =
    agents.find((a) => a.paneId === focusedPaneId) ??
    agents.find((a) => a.id === selectedAgentId) ??
    agents[0];
  const host = hosts.find((h) => h.id === connected);
  const links =
    host && agent
      ? (agentLinks[linkKey(host.id, agent.id, agent.sessionId, host.demo)] ?? [])
      : [];

  // The Clipboard API needs a secure context; plain-HTTP deployments fall
  // back to select-and-copy, and to a message when that is blocked too.
  const blockedCopy = {
    description:
      "Clipboard is blocked on this connection. Tap the link to open it instead.",
  };
  async function copy(url: string) {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(url);
        toast("Link copied", { description: url });
        return;
      } catch {
        /* fall through */
      }
    }
    let field: HTMLTextAreaElement | null = null;
    try {
      field = document.createElement("textarea");
      field.value = url;
      field.style.position = "fixed";
      field.style.opacity = "0";
      document.body.appendChild(field);
      field.select();
      if (document.execCommand("copy")) {
        toast("Link copied", { description: url });
      } else {
        toast("Copy unavailable", blockedCopy);
      }
    } catch {
      toast("Copy unavailable", blockedCopy);
    } finally {
      field?.remove();
    }
  }

  if (!connected || !agent) {
    return (
      <div className="flex flex-1 flex-col items-start justify-center px-6">
        <h2 className="text-balance text-2xl font-medium tracking-display">
          No pane attached.
        </h2>
      </div>
    );
  }

  if (!links.length) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-start justify-center px-6">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-blocked">
          no links
        </p>
        <h2 className="mt-3 max-w-sm text-balance text-2xl font-medium tracking-display">
          Nothing observed in this pane yet.
        </h2>
        <p className="mt-3 max-w-sm text-sm text-muted">
          URLs printed to the terminal show up here. Open the Terminal view
          and watch for them — the list survives view switches, not a reload.
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ul
        aria-label="Terminal links"
        className="min-h-0 flex-1 divide-y divide-border overflow-y-auto"
      >
        {links.map((url) => (
          <li key={url} className="flex items-center gap-2 px-4 py-2.5">
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="min-w-0 flex-1 truncate font-mono text-sm"
            >
              {url}
            </a>
            <button
              type="button"
              aria-label={`Copy ${url}`}
              onClick={() => void copy(url)}
              className="h-9 shrink-0 rounded-sm bg-surface-2 px-2.5 font-mono text-xs text-muted shadow-border tap-scale"
            >
              Copy
            </button>
          </li>
        ))}
      </ul>
      <p className="shrink-0 px-4 pb-3 pt-2 text-xs text-muted">
        These are the URLs this pane has printed, not its full history. Open
        is an explicit tap, in a new tab. Localhost links point at this
        device, not the remote host — to reach a service running locally on
        the host, use its reachable Tailscale address.
      </p>
    </div>
  );
}
