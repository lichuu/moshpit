import { Power, SquareTerminal } from "lucide-react";
import { useCallback, useMemo } from "react";
import { Composer } from "@/components/moshpit/composer";
import { Conversation } from "@/components/moshpit/conversation";
import { NativePane } from "@/components/moshpit/native-pane";
import { attachInteraction, hideInteraction, interactionKey, interactionStale, noteInteractionDelivery, showInteraction, useNativeInteraction, useRoomForTranscript } from "@/lib/moshpit/native-interaction";
import { useLayout } from "@/lib/moshpit/use-layout";
import { useMoshpitStore } from "@/lib/moshpit/store";
import { Button } from "@/components/ui/button";
import { bridgeUrl } from "@/lib/moshpit/bridge";
import { useSession } from "@/lib/moshpit/session";
import { draftSessionId, type DraftKey } from "@/lib/moshpit/drafts";
import { askOptionKeys } from "@/lib/moshpit/ask-keys";
import type {
  SessionEntry,
  SessionResponse,
} from "@/lib/moshpit/session-protocol";
import type { Agent, AgentView } from "@/lib/moshpit/types";

function demoConversation(
  agent: Agent,
): Extract<SessionResponse, { kind: "available" }> {
  const entries: SessionEntry[] = [];
  for (const [index, line] of agent.lines.entries()) {
    const id = `demo:${agent.id}:${index}`;
    const previous = entries.at(-1);
    if (/^\s+[+-]/.test(line.text)) {
      if (previous?.kind === "activity" && previous.diff !== undefined)
        previous.diff += `\n${line.text}`;
      else
        entries.push({
          id,
          turnId: `demo:${agent.id}`,
          kind: "activity",
          title: "Recorded changes",
          input: "",
          output: "",
          diff: line.text,
          status: "complete",
        });
      continue;
    }
    const role = line.tone === "in" ? "user" : "assistant";
    if (previous?.kind === "message" && previous.role === role)
      previous.text += `\n${line.text}`;
    else
      entries.push({
        id,
        turnId: `demo:${agent.id}`,
        kind: "message",
        role,
        text: line.text,
      });
  }
  if (agent.question) {
    const questions = agent.question;
    entries.push({
      id: `demo:${agent.id}:question`,
      turnId: `demo:${agent.id}`,
      kind: "question",
      title: "Question",
      questions: questions.map((question) => ({
        text: question.text,
        multi: question.multi ?? false,
        options: question.options.map((option) => ({ label: option.label, description: option.description })),
        answers: question.answer ? [question.answer] : undefined,
      })),
      resolved: questions.length > 0 && questions.every((question) => Boolean(question.answer)),
      answer: questions.length === 1 ? questions[0]?.answer : undefined,
    });
  }
  return {
    kind: "available",
    agentId: agent.id,
    sessionId: agent.sessionId ?? `demo:${agent.id}`,
    entries,
    cursor: "demo",
    before: null,
    reset: false,
    capabilities: { inputModes: ["send"], stop: false, fit: false },
  };
}

export function Steer(_props: { view: Exclude<AgentView, "terminal"> }) {
  const layout = useLayout();
  const wideDetail =
    layout.pane.kind === "pair" && layout.pane.pair === "pit-steer";
  const agents = useMoshpitStore((s) => s.agents);
  const selectedId = useMoshpitStore((s) => s.selectedAgentId);
  const connected = useMoshpitStore((s) => s.connectedHostId);
  const herdrRunning = useMoshpitStore((s) => s.herdrRunning);
  const startHerdr = useMoshpitStore((s) => s.startHerdr);
  const setTab = useMoshpitStore((s) => s.setTab);
  const setDetailView = useMoshpitStore((s) => s.setDetailView);
  const answerAgent = useMoshpitStore((s) => s.answerAgent);
  const answerDialog = useMoshpitStore((s) => s.answerDialog);
  const agent = agents.find((a) => a.id === selectedId) ?? agents[0];
  const host = useMoshpitStore((s) => s.hosts.find((h) => h.id === connected));
  const url = host && !host.demo && herdrRunning ? bridgeUrl(host) : "";
  const demo = useMemo(
    () => (host?.demo && agent ? demoConversation(agent) : undefined),
    [host?.demo, agent],
  );
  const session = useSession(url, agent?.id ?? "", demo);
  const available =
    session.value?.kind === "available" ? session.value : undefined;
  // The raw herdr session identity: the submission guard validates against it,
  // so the reader's hashed stream ID must not substitute here.
  const sessionId = agent?.sessionId ?? (agent && host?.demo ? draftSessionId(agent, true) : undefined);
  const tick = useMoshpitStore((s) => s.tick);
  const interactionId = connected && agent ? interactionKey(connected, agent.id) : undefined;
  const interaction = useNativeInteraction(interactionId);
  const paneOpen = Boolean(interaction?.visible);
  // On a short screen the open pane takes the transcript's place. The reader
  // keeps its position by session, so closing the pane returns to it.
  const roomForTranscript = useRoomForTranscript();
  const paneFills = paneOpen && !roomForTranscript;
  const agentSessionId = agent?.sessionId;
  // Stable identities: Composer is memo()'d, and these ride its props.
  const togglePane = useCallback(() => {
    if (!interactionId) return;
    if (!interaction) attachInteraction(interactionId, agentSessionId);
    else if (interaction.visible) { hideInteraction(interactionId); return; }
    // A hidden panel whose pane moved on reattaches: asking for the pane is
    // the explicit step, and what it shows is the session running now.
    else if (interactionStale(interaction, agentSessionId)) attachInteraction(interactionId, agentSessionId);
    else showInteraction(interactionId);
    // Opening checks the pane's identity now, not at the next poll.
    if (url) tick();
  }, [interactionId, interaction, agentSessionId, tick, url]);
  const nativePane = useMemo(() => ({ open: paneOpen, onToggle: togglePane }), [paneOpen, togglePane]);
  // A delivered command can end or replace the session. The snapshot is read
  // again at once, so a panel on the old session lets go without waiting.
  const delivered = useCallback((requestId: string) => {
    if (!interactionId) return;
    noteInteractionDelivery(interactionId, requestId);
    if (url) tick();
  }, [interactionId, tick, url]);

  if (!connected || !agent) {
    return (
      <div className="flex flex-1 flex-col items-start justify-center px-6">
        <h2 className="text-balance text-2xl font-medium tracking-display">
          Pick an agent from moshpit.
        </h2>
        {wideDetail ? null : (
          <Button className="mt-6" onClick={() => setTab("moshpit")}>
            Open moshpit
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
          Nothing to steer until herdr is up.
        </h2>
        <Button className="mt-6" onClick={startHerdr}>
          <Power className="size-4" />
          Start herdr
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {session.error && (
        <p
          role="status"
          className="shrink-0 border-b border-border px-4 py-2 text-xs text-blocked"
        >
          {session.error}. Reconnecting. Your loaded conversation is preserved.
        </p>
      )}
      {paneFills ? null : available ? (
        <Conversation
          key={JSON.stringify([url || connected, available.sessionId])}
          sessionId={JSON.stringify([url || connected, available.sessionId])}
          epoch={session.epoch}
          entries={available.entries}
          working={agent.status === "working"}
          before={available.before}
          loadOlder={() => void session.loadOlder()}
          loadingOlder={session.loadingOlder}
          dialog={agent.blockedDialog}
          blocked={agent.status === "blocked"}
          onAnswer={(question, optionIndex, printedKey, onOutcome) => {
            const choose = agent.blockedDialog?.kind === "choose" ? agent.blockedDialog : undefined;
            // The card's own key for the row that was tapped, or nothing. The
            // row is only tappable when the card printed one, so the key that
            // goes out is always the one the row showed.
            if (choose) {
              // Every latched row has to be released, so a row that somehow
              // has no printed key reports the refusal rather than staying
              // stuck on the tap.
              if (printedKey) answerDialog(agent.id, choose.expected.token, printedKey, onOutcome);
              else onOutcome?.({ state: "failed", message: "That row has no key to send." });
              return;
            }
            answerAgent(agent.id, askOptionKeys(agent.kind, question, optionIndex), onOutcome);
          }}
          onUseTerminal={() => setDetailView("terminal")}
          nativePane={nativePane}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-start justify-center gap-4 overflow-auto px-6 py-8">
          <p role="status" className="text-sm text-muted">
            {session.value?.kind === "unavailable"
              ? session.value.reason
              : session.error
                ? "Conversation could not be loaded. The terminal is still available."
                : "Loading conversation…"}
          </p>
          <Button variant="outline" onClick={() => setDetailView("terminal")}>
            <SquareTerminal className="size-4" />
            Open Terminal
          </Button>
        </div>
      )}
      {interaction?.visible && interactionId && host && sessionId && (
        <NativePane
          agent={agent}
          host={host}
          hostUrl={url}
          interactionId={interactionId}
          record={interaction}
          draftKey={[connected, sessionId, "conversation"] as DraftKey}
          fill={paneFills}
        />
      )}
      {sessionId && (
        <Composer
          agent={agent}
          sessionId={sessionId}
          nativePane={nativePane}
          onDelivered={delivered}
          liveQuestion={agent.blockedDialog?.kind === "choose" && agent.blockedDialog.family === "claude-ask-user-review-v1"
            ? false
            : available?.entries.some((entry) => entry.kind === "question" && !entry.resolved)}
          capabilities={
            available?.capabilities ?? {
              inputModes: ["send"],
              stop: false,
              fit: false,
            }
          }
        />
      )}
    </div>
  );
}
