import { useEffect, useRef, useState } from "react";
import { StatusPill } from "@/components/moshpit/status-pill";
import { AgentIcon } from "@/components/moshpit/agent-icon";
import { paneLabel } from "@/lib/moshpit/label";
import { useLayout } from "@/lib/moshpit/use-layout";
import { useMoshpitStore } from "@/lib/moshpit/store";
import type {
  AgentEvent,
  AgentStatus,
  AnswerOutcome,
  BlockedOption,
  EventKind,
  EventResolution,
} from "@/lib/moshpit/types";
import { cn, formatAgo } from "@/lib/utils";
import { Button } from "@/components/ui/button";

const KIND_LABEL: Record<EventKind, string> = {
  blocked: "blocked",
  tool: "tool",
  turn: "turn",
};

const RESOLUTION_LABEL: Record<EventResolution, string> = {
  approved: "approved",
  denied: "denied",
  answered: "answered",
};

function EventRow({
  event,
  agentName,
  agentStatus,
  options,
}: {
  event: AgentEvent;
  agentName: string;
  agentStatus: AgentStatus | undefined;
  options?: BlockedOption[];
}) {
  const prompt = useMoshpitStore((s) => s.prompt);
  const sendKeys = useMoshpitStore((s) => s.sendKeys);
  const answerDialog = useMoshpitStore((s) => s.answerDialog);
  const selectAgent = useMoshpitStore((s) => s.selectAgent);
  const blockedInsertion = useMoshpitStore((s) => Boolean(s.blockedInsertions[event.agentId]));
  const [answerLock, setAnswerLock] = useState<{ token: string | null; key: string; attempt: number } | null>(null);
  const answerAttempt = useRef(0);
  const waiting = event.kind === "blocked" && !event.resolved;
  const agentKind = useMoshpitStore((state) => state.agents.find((agent) => agent.id === event.agentId)?.kind);
  const dialog = useMoshpitStore((state) => state.agents.find((agent) => agent.id === event.agentId)?.blockedDialog);
  const choose = dialog?.kind === "choose" ? dialog : undefined;
  const answerToken = choose?.expected.token ?? null;
  const answerCardLocked = Boolean(answerLock && answerLock.token === answerToken);
  const showInsertState = waiting && !choose && blockedInsertion;
  useEffect(() => {
    if (!waiting || answerLock?.token !== answerToken) setAnswerLock(null);
  }, [waiting, answerToken, answerLock?.token]);
  // A live card knows its own keys, so it supplies the buttons; only when
  // there is none do we fall back to the keys read off the pane text.
  const tappable = choose?.options ?? (options ?? []).filter((o) => /^\d+$/.test(o.key));

  return (
    <article
      className={cn(
        "w-full rounded-xl bg-surface p-3 shadow-border",
        waiting && "border-l-[3px] border-l-blocked bg-blocked/10",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="truncate font-medium tracking-tight">{agentName}</p>
            {agentKind && <AgentIcon kind={agentKind} className="text-fg" />}
          </div>
          <p className="mt-0.5 text-2xs font-medium uppercase tracking-wide text-muted">
            {KIND_LABEL[event.kind]}
            {event.resolved ? (
              <>
                <span className="text-subtle"> · </span>
                {RESOLUTION_LABEL[event.resolved]}
              </>
            ) : null}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {agentStatus ? <StatusPill status={agentStatus} /> : null}
          <span className="text-2xs tabular-nums text-subtle">
            {formatAgo(event.at)}
          </span>
        </div>
      </div>
      <p
        className={cn(
          "mt-2 font-mono text-xs",
          waiting ? "text-blocked" : "text-fg/80",
        )}
      >
        {waiting && dialog?.question ? dialog.question : event.text}
      </p>
      {waiting ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {/* Real choices when the agent numbered them: the key is unambiguous,
              so the tap sends exactly what pressing it on the desktop would.
              Worded dialogs (Accept/Decline) are arrow-driven, so they fall
              through to Reply rather than guess a keystroke. */}
          {tappable.length ? (
            tappable.map((opt) => {
              const answerBusy = answerCardLocked && answerLock?.key === opt.key;
              const description = choose?.options.find((option) => option.key === opt.key)?.description;
              return <Button
                key={opt.key}
                aria-label={`${opt.key}. ${opt.label}`}
                size="sm"
                variant={/^\s*no\b/i.test(opt.label) ? "danger" : "default"}
                disabled={answerCardLocked}
                className={cn(
                  "h-auto min-h-9 max-w-full whitespace-normal break-words py-1.5 text-left",
                  answerBusy ? "disabled:opacity-100" : answerCardLocked ? "opacity-50" : undefined,
                )}
                onClick={() => {
                  if (answerCardLocked) return;
                  const token = choose?.expected.token ?? null;
                  const attempt = ++answerAttempt.current;
                  setAnswerLock({ token, key: opt.key, attempt });
                  // A token answer stays latched once it lands: the token is
                  // spent. A key read off the pane latches only while it is in
                  // flight -- the pane may still want another key, or Enter,
                  // and the row has to stay tappable for it.
                  const release = (outcome: AnswerOutcome) => {
                    if (choose && outcome.state !== "failed") return;
                    setAnswerLock((lock) => (lock?.attempt === attempt ? null : lock));
                  };
                  if (choose) {
                    answerDialog(event.agentId, choose.expected.token, opt.key, release);
                    return;
                  }
                  // A printed option key can be "10", which is text, not a key name.
                  sendKeys(event.agentId, { text: opt.key }, release);
                }}
              >
                <span>
                  {opt.key}. {opt.label}
                  {description ? (
                    <span className="mt-0.5 block text-xs text-subtle">{description}</span>
                  ) : null}
                </span>
              </Button>;
            })
          ) : options?.length ? (
            // Parsed, but arrow-navigated: show what the choices are and let
            // Reply drive them. Typing "y" at a menu picks whatever is
            // highlighted, which is how you approve the wrong thing.
            <span className="flex flex-wrap items-center gap-1.5 text-2xs text-muted">
              {options.map((opt) => (
                <span
                  key={opt.label}
                  className="rounded-full px-2 py-1 shadow-border"
                >
                  {opt.label}
                </span>
              ))}
            </span>
          ) : (
            showInsertState ? (
              <span role="status" className="text-xs text-muted">
                Typed into the pane — press Enter in Reply to submit.
              </span>
            ) : (
              <>
                <Button size="sm" aria-label="Type yes without submitting" onClick={() => {
                  void prompt(event.agentId, "y");
                }}>
                  Type y
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  aria-label="Type no without submitting"
                  onClick={() => {
                    void prompt(event.agentId, "n");
                  }}
                >
                  Type n
                </Button>
              </>
            )
          )}
          <Button
            size="sm"
            variant="secondary"
            onClick={() => selectAgent(event.agentId)}
          >
            Reply
          </Button>
        </div>
      ) : null}
    </article>
  );
}

/** A settled event: one line, no actions. It is history, not a task. */
function RecentRow({
  event,
  agentName,
}: {
  event: AgentEvent;
  agentName: string;
}) {
  const selectAgent = useMoshpitStore((s) => s.selectAgent);
  return (
    <button
      type="button"
      onClick={() => selectAgent(event.agentId)}
      className="flex w-full items-baseline gap-2 rounded-lg px-3 py-2 text-left shadow-border"
    >
      <span className="shrink-0 text-2xs uppercase tracking-wide text-subtle">
        {event.resolved
          ? RESOLUTION_LABEL[event.resolved]
          : KIND_LABEL[event.kind]}
      </span>
      <span className="min-w-0 flex-1 truncate text-xs text-fg/80">
        <span className="text-muted">{agentName}</span>
        <span className="text-subtle"> · </span>
        {event.text}
      </span>
      <span className="shrink-0 text-2xs tabular-nums text-subtle">
        {formatAgo(event.at)}
      </span>
    </button>
  );
}

export function Inbox() {
  const layout = useLayout();
  const wideDetail =
    layout.pane.kind === "pair" && layout.pane.pair === "inbox-steer";
  const events = useMoshpitStore((s) => s.events);
  const agents = useMoshpitStore((s) => s.agents);
  const connected = useMoshpitStore((s) => s.connectedHostId);
  const herdrRunning = useMoshpitStore((s) => s.herdrRunning);
  const startHerdr = useMoshpitStore((s) => s.startHerdr);
  const setTab = useMoshpitStore((s) => s.setTab);
  const demo = useMoshpitStore(
    (s) => s.hosts.find((h) => h.id === s.connectedHostId)?.demo ?? false,
  );
  const names = Object.fromEntries(
    agents.map((a) => [a.id, paneLabel(a, agents).name]),
  );
  const statuses = Object.fromEntries(agents.map((a) => [a.id, a.status]));
  const choices = Object.fromEntries(
    agents.map((a) => [a.id, a.blockedOptions]),
  );
  const list = [...events].sort((a, b) => b.at - a.at);
  // A blocked agent is a task; a finished turn is a receipt. Ranking them
  // together buried the one thing the phone exists to show you.
  const needsYou = list.filter((e) => e.kind === "blocked" && !e.resolved);
  const recent = list.filter((e) => !(e.kind === "blocked" && !e.resolved));

  if (!connected) {
    return (
      <div className="flex flex-1 flex-col items-start justify-center px-6">
        <h2 className="text-balance text-2xl font-medium tracking-display">
          Attach a host to see events.
        </h2>
        {wideDetail ? null : (
          <Button className="mt-6" onClick={() => setTab("hosts")}>
            Open Hosts
          </Button>
        )}
      </div>
    );
  }

  if (!herdrRunning) {
    return (
      <div className="flex flex-1 flex-col items-start justify-center px-6">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-blocked">
          herdr not running
        </p>
        <h2 className="mt-3 max-w-xs text-balance text-2xl font-medium tracking-display">
          Nothing in Inbox until herdr is up.
        </h2>
        <Button className="mt-6" onClick={startHerdr}>
          Start herdr
        </Button>
      </div>
    );
  }

  return (
    <div className="agent-list flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="px-5 pb-5 pt-6">
        <h2 className="text-xl font-medium tracking-tight">
          A moment of your time
        </h2>
        <p className="mt-1.5 text-xs text-muted">
          Decisions first. Everything else can wait.
        </p>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-4">
        {needsYou.length ? (
          <>
            <p className="px-1 pt-1 text-2xs font-medium uppercase tracking-[0.18em] text-blocked">
              Needs you
            </p>
            {needsYou.map((event) => (
              <EventRow
                key={event.id}
                event={event}
                agentName={names[event.agentId] ?? event.agentId}
                agentStatus={statuses[event.agentId]}
                options={choices[event.agentId]}
              />
            ))}
          </>
        ) : (
          <p className="px-1 py-8 text-center text-sm text-muted">
            {list.length
              ? "Nothing needs you."
              : demo
                ? "Nothing waiting. Simulate a block from Hosts, or wait for a turn."
                : "Nothing waiting. Blocked prompts and finished turns land here."}
          </p>
        )}

        {/* Everything else already happened. It is worth seeing, but it is not
            a task, so it does not compete with the rows that are. */}
        {recent.length ? (
          <>
            <p className="px-1 pb-1 pt-4 text-2xs font-medium uppercase tracking-[0.18em] text-subtle">
              Recent
            </p>
            {recent.map((event) => (
              <RecentRow
                key={event.id}
                event={event}
                agentName={names[event.agentId] ?? event.agentId}
              />
            ))}
          </>
        ) : null}
      </div>
    </div>
  );
}
