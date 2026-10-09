import { useRef, useState } from "react";
import { SquareTerminal, X } from "lucide-react";
import { PaneSurface, type PaneHandle, type PaneStatus, type PaneTarget } from "@/components/moshpit/pane-surface";
import { PaneStatusLabel } from "@/components/moshpit/terminal";
import { useMoreToRight } from "@/lib/moshpit/use-more-to-right";
import { linkKey } from "@/lib/moshpit/links";
import { draftStore, type DraftKey } from "@/lib/moshpit/drafts";
import { attachInteraction, hideInteraction, interactionStale, type NativeInteraction } from "@/lib/moshpit/native-interaction";
import { useLayout } from "@/lib/moshpit/use-layout";
import { useMoshpitStore } from "@/lib/moshpit/store";
import { cn } from "@/lib/utils";
import type { Agent, Host } from "@/lib/moshpit/types";

// What a menu or a prompt needs, in the order a thumb reaches for it. Typing
// goes through the pane itself or the composer below.
const KEYS: { key: string; label: string; name?: string }[] = [
  { key: "up", label: "↑", name: "Up" },
  { key: "down", label: "↓", name: "Down" },
  { key: "enter", label: "enter" },
  { key: "esc", label: "esc" },
  { key: "left", label: "←", name: "Left" },
  { key: "right", label: "→", name: "Right" },
  { key: "tab", label: "tab" },
  { key: "shift+tab", label: "shift+tab" },
  { key: "backspace", label: "⌫", name: "Backspace" },
];

/**
 * The agent's live pane inside Chat, for the menus and prompts a command
 * opens. It is the same surface Terminal uses, attached with its own ticket.
 * Closing it only stops showing the pane: nothing is sent, and whatever runs
 * there keeps running.
 */
export function NativePane({ agent, host, hostUrl, interactionId, record, draftKey, fill }: {
  agent: Agent;
  host: Host;
  /** The bridge origin, or "" on the demo host. */
  hostUrl: string;
  interactionId: string;
  record: NativeInteraction;
  /** The Chat draft, where a paste the pane cannot take is moved, unsent. */
  draftKey: DraftKey;
  /** Takes the transcript's place instead of sitting under it. */
  fill: boolean;
}) {
  const layout = useLayout();
  const sendKeys = useMoshpitStore((s) => s.sendKeys);
  const setDetailView = useMoshpitStore((s) => s.setDetailView);
  const surface = useRef<PaneHandle | null>(null);
  const [status, setStatus] = useState<PaneStatus>({ state: "connecting", attempt: 0, error: null });
  const [focused, setFocused] = useState(false);
  const strip = useRef<HTMLDivElement | null>(null);
  const moreKeys = useMoreToRight(strip, true);

  if (interactionStale(record, agent.sessionId)) {
    return (
      <section aria-label="Native pane" className={cn("border-t border-border bg-surface/40 px-4 py-3", fill ? "flex min-h-0 flex-1 flex-col justify-center" : "shrink-0")}>
        <p role="status" className="text-sm text-muted">
          This pane started a different session, so the panel let go of it. Nothing is sent from here until you reattach.
        </p>
        <div className="mt-2 flex gap-2">
          <button type="button" onClick={() => attachInteraction(interactionId, agent.sessionId)} className="h-10 rounded-lg bg-surface-2 px-3 text-sm font-medium shadow-border tap-scale">
            Reattach
          </button>
          <button type="button" onClick={() => hideInteraction(interactionId)} className="h-10 rounded-lg px-3 text-sm text-muted shadow-border tap-scale">
            Close
          </button>
        </div>
      </section>
    );
  }

  const target: PaneTarget = { hostId: host.id, url: hostUrl, paneId: agent.id, nativeSessionId: record.nativeSessionId };
  const demoLines = hostUrl ? undefined : agent.lines.slice(-60).map((line) => line.text);

  function transfer(text: string) {
    const draft = draftStore(draftKey);
    const current = draft.getSnapshot().draft.text;
    draft.update({ text: current ? `${current}\n${text}` : text });
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message agent"]')?.focus());
  }

  return (
    <section aria-label="Native pane" className={cn("flex flex-col border-t border-border", fill ? "min-h-0 flex-1" : "min-h-36 shrink-0 basis-[40%]")}>
      <PaneSurface
        // A fresh mount per attachment: reopening or reattaching takes a new
        // ticket, and nothing from an earlier socket can reach this one.
        key={JSON.stringify([target.hostId, target.url, target.paneId, record.attachment])}
        target={target}
        bindSession
        label={`Native pane ${agent.paneId}`}
        demoLines={demoLines}
        linkKey={hostUrl ? linkKey(host.id, agent.id, agent.sessionId, host.demo) : null}
        handle={surface}
        fallbackSend={(key) => sendKeys(agent.id, key)}
        onStatus={setStatus}
        onFocusChange={setFocused}
        // Swiping between herdr tabs belongs to Terminal; here it would move
        // the pane out from under the conversation.
        onSwipe={() => {}}
        onTransfer={transfer}
        autoFocus={layout.regime === "wide"}
      />
      <div className="flex items-center gap-2 border-t border-border bg-bg px-3 py-2">
        <PaneStatusLabel status={status} shell={false} paneId={agent.paneId} />
        <div
          ref={strip}
          role="group"
          aria-label="Pane keys"
          className="flex min-w-0 flex-1 gap-1 overflow-x-auto"
          // A key cut clean in half reads as broken; a fade reads as "more".
          style={moreKeys ? {
            maskImage: "linear-gradient(to right, black calc(100% - 28px), transparent)",
            WebkitMaskImage: "linear-gradient(to right, black calc(100% - 28px), transparent)",
          } : undefined}
        >
          {KEYS.map(({ key, label, name }) => (
            <button
              key={key}
              type="button"
              aria-label={name}
              // Focus stays where it was, so a key never closes the keyboard
              // or takes the caret out of the composer.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => { if (!surface.current) sendKeys(agent.id, key); else surface.current.send(key); }}
              className="h-9 min-w-9 shrink-0 rounded-sm bg-surface-2 px-2.5 font-mono text-xs text-muted shadow-border"
            >
              {label}
            </button>
          ))}
        </div>
        {focused && layout.regime !== "wide" ? (
          <button type="button" aria-label="Leave pane input" onMouseDown={(event) => event.preventDefault()} onClick={() => surface.current?.blur()} className="h-9 shrink-0 rounded-sm px-2.5 text-xs font-medium text-muted shadow-border">
            Done
          </button>
        ) : null}
        <button type="button" aria-label="Open in Terminal" title="Open the full Terminal view" onClick={() => setDetailView("terminal")} className="flex size-9 shrink-0 items-center justify-center rounded-sm text-muted shadow-border">
          <SquareTerminal className="size-4" />
        </button>
        <button type="button" aria-label="Close native pane" title="Hide the pane. Nothing is sent, and it keeps running." onClick={() => hideInteraction(interactionId)} className="flex size-9 shrink-0 items-center justify-center rounded-sm text-muted shadow-border">
          <X className="size-4" />
        </button>
      </div>
    </section>
  );
}
