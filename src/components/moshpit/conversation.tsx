import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, Check, ChevronDown, ChevronRight, Copy, Search, SquareTerminal } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import ChatMarkdown from "./chat-markdown";
import { isLongMessage } from "@/lib/moshpit/chat";
import type { Question, SessionEntry } from "@/lib/moshpit/session-protocol";
import type { AnswerCallback, BlockedDialog } from "@/lib/moshpit/types";

type Anchor = { entryId: string; offset: number };
// Only the reader decides whether to follow the bottom. A scroll event also
// comes from our own scrollTop writes, fired after applyReading returns when
// layout may have moved again, and from the browser's own clamping and scroll
// anchoring when the box resizes; neither says anything about intent. So a
// scroll event changes `following` only after a gesture on the pane (wheel,
// touch, pointer, key) set `intent`, and our next write that moves the pane
// clears it again.
//
// `open` and `nested` hold only the choices a reader made, for activity groups
// and single activities, that differ from the default: closed unless failed.
// `open` also holds long user messages by entry ID, closed by default.
type Reading = { top: number; following: boolean; applying: boolean; intent: boolean; anchor: Anchor | null; open: Map<string, boolean>; nested: Map<string, boolean> };
const readings = new Map<string, Reading>();
const freshReading = (): Reading => ({ top: 0, following: true, applying: false, intent: false, anchor: null, open: new Map(), nested: new Map() });

function captureAnchor(el: HTMLElement): Anchor | null {
  const root = el.getBoundingClientRect();
  for (const node of el.querySelectorAll<HTMLElement>("[data-entry-id]")) {
    const box = node.getBoundingClientRect();
    if (box.bottom > root.top + 1) {
      const entryId = node.dataset.entryId;
      if (entryId) return { entryId, offset: box.top - root.top };
    }
  }
  return null;
}

function restoreAnchor(el: HTMLElement, reading: Reading) {
  if (reading.anchor) {
    const card = el.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(reading.anchor.entryId)}"]`);
    if (card) {
      el.scrollTop += card.getBoundingClientRect().top - el.getBoundingClientRect().top - reading.anchor.offset;
      return;
    }
  }
  el.scrollTop = reading.top;
}

function applyReading(
  el: HTMLElement,
  reading: Reading,
  opts: { search: boolean; contentChanged: boolean; prepending: boolean; previousHeight: number },
  setUnseen: (v: boolean) => void,
) {
  reading.applying = true;
  const before = el.scrollTop;
  try {
    if (reading.following && !opts.search) el.scrollTop = el.scrollHeight;
    else {
      if (opts.prepending && !reading.anchor) el.scrollTop += el.scrollHeight - opts.previousHeight;
      else restoreAnchor(el, reading);
      // Older history lands above the reader, so a prepend is not new
      // activity and must not raise the chip the reader taps to jump down.
      if (opts.contentChanged && !opts.search && !opts.prepending) setUnseen(true);
    }
    reading.top = el.scrollTop;
    // A write that moved the pane supersedes the gesture that came before it.
    if (el.scrollTop !== before) reading.intent = false;
    if (!reading.following) reading.anchor = captureAnchor(el);
  } finally {
    reading.applying = false;
  }
}
const entryText = (entry: SessionEntry) =>
  entry.kind === "activity"
    ? `${entry.title}\n${entry.input}\n${entry.output}\n${entry.diff ?? ""}`
    : entry.kind === "question"
      ? entry.questions.flatMap((q) => [q.text, ...q.options.map((o) => o.label)]).join("\n")
      : entry.text;

type QuestionEntry = Extract<SessionEntry, { kind: "question" }>;
type ActivityEntry = Extract<SessionEntry, { kind: "activity" }>;

// Tool calls read like Claude Code on the web: one quiet line per turn that
// tallies what the agent did, and one line per call inside it. Each harness
// names its tools differently (Claude "Bash" with JSON input, grok "Execute
// `cmd`", codex "shell", pi "bash"), so the first word of the title picks the
// kind and the input, when it parses, supplies the target.
type ActivityKind = "read" | "edit" | "run" | "search" | "fetch" | "other";
const kindWords: Record<Exclude<ActivityKind, "other">, string[]> = {
  read: ["read", "view", "cat", "read_file", "readfile"],
  edit: ["edit", "write", "multiedit", "apply_patch", "patch", "str_replace", "str_replace_editor", "create", "notebookedit", "write_file", "edit_file"],
  run: ["bash", "shell", "execute", "exec", "exec_command", "local_shell", "run", "terminal", "command"],
  search: ["grep", "glob", "search", "find", "ls", "list", "websearch", "web_search"],
  fetch: ["fetch", "webfetch", "web_fetch", "curl"],
};
const phrases: Record<ActivityKind, { done: string; doing: string; one: string; many: string }> = {
  read: { done: "Read", doing: "Reading", one: "a file", many: "files" },
  edit: { done: "Edited", doing: "Editing", one: "a file", many: "files" },
  run: { done: "Ran", doing: "Running", one: "a command", many: "commands" },
  search: { done: "Searched", doing: "Searching", one: "once", many: "times" },
  fetch: { done: "Fetched", doing: "Fetching", one: "a page", many: "pages" },
  other: { done: "Used", doing: "Using", one: "a tool", many: "tools" },
};

function describeActivity(activity: ActivityEntry): { kind: ActivityKind; label: string } {
  const [first = "", ...rest] = activity.title.trim().split(/\s+/);
  const word = first.replace(/[:`]/g, "").toLowerCase();
  const kind = (Object.keys(kindWords) as (keyof typeof kindWords)[]).find((k) => kindWords[k].includes(word)) ?? "other";
  let input: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(activity.input);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) input = parsed as Record<string, unknown>;
  } catch { /* plain text input */ }
  const field = (...keys: string[]) => {
    for (const key of keys) {
      const value = input?.[key];
      if (typeof value === "string" && value) return value;
      if (Array.isArray(value) && value.length) return value.join(" ");
    }
  };
  const fromTitle = rest.join(" ").replace(/^`|`$/g, "");
  const label = (kind === "run" ? field("command", "cmd")
    : kind === "fetch" ? field("url")
    : kind === "search" ? field("pattern", "query", "path")
    : field("file_path", "path", "file", "notebook_path"))
    ?? (fromTitle || (kind === "other" ? activity.title : ""));
  return { kind, label: label.split("\n")[0] };
}

function activitySummary(activities: ActivityEntry[]) {
  const running = [...activities].reverse().find((a) => a.status === "running");
  if (running) {
    const { kind, label } = describeActivity(running);
    return `${phrases[kind].doing} ${label || phrases[kind].one}`;
  }
  const counts = new Map<ActivityKind, number>();
  for (const a of activities) {
    const { kind } = describeActivity(a);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const text = [...counts].map(([kind, n], i) => {
    const p = phrases[kind];
    const verb = i ? p.done.toLowerCase() : p.done;
    return `${verb} ${n === 1 ? p.one : `${n} ${p.many}`}`;
  }).join(", ");
  const failed = activities.filter((a) => a.status === "failed").length;
  return failed ? `${text} · ${failed} failed` : text;
}

function QuestionCard({ entry, dialog, blocked, onAnswer, onUseTerminal }: {
  entry: QuestionEntry;
  dialog?: BlockedDialog;
  blocked?: boolean;
  onAnswer?: (question: Question, optionIndex: number, printedKey?: string, onOutcome?: AnswerCallback) => void;
  onUseTerminal?: () => void;
}) {
  const [sent, setSent] = useState<{ token: string | null; id: string; attempt: number } | null>(null);
  const answerAttempt = useRef(0);
  // A tap sends keys positioned against whatever question the TUI is showing,
  // and the keys carry no question index, so a card with more than one
  // question could answer the wrong one. Route those to the Terminal, the
  // same escape multi-select already takes. A live `choose` dialog carries
  // the agent's own printed keys, so its matching question stays tappable
  // even in a multi-question card; the printed key is shown on the row.
  const choose = dialog?.kind === "choose" ? dialog : undefined;
  const compact = (text: string) => text.replace(/\s+/gu, " ").trim();
  const matches = (question: Question) => choose && compact(choose.question) === compact(question.text);
  const live = (question: Question) =>
    choose && !entry.resolved && !question.multi && matches(question) && entry.questions.filter(matches).length === 1 ? choose : undefined;
  const single = entry.questions.length === 1 && !entry.questions[0].multi;
  const dialogToken = choose?.expected.token ?? null;
  const cardLocked = Boolean(
    sent && (choose ? sent.token === dialogToken : sent.token === null),
  );
  useEffect(() => {
    if (entry.resolved) setSent(null);
  }, [entry.resolved]);
  useEffect(() => {
    setSent((current) => current && current.token !== dialogToken ? null : current);
  }, [dialogToken]);
  const canAnswer = Boolean(onAnswer) && Boolean(blocked) && !entry.resolved && (
    choose ? entry.questions.some((question) => live(question)) : !dialog && single
  );
  // The key a row sends is the one the card printed beside that label. The
  // tool call's option list and the card's need not line up, so taking the
  // key at the same position would send one the row does not show. No match,
  // no tap — the Terminal button below takes the card instead.
  const printedKey = (question: Question, label: string) => {
    const option = question.options.find((item) => item.label === label);
    const candidates = live(question)?.options.filter((item) =>
      (item.label === label && (!item.description || !option?.description)) || (option && compact(`${item.label} ${item.description ?? ""}`) === compact(`${option.label} ${option.description ?? ""}`)),
    );
    return candidates?.length === 1 ? candidates[0].key : undefined;
  };
  const tappable = (question: Question, label: string) =>
    canAnswer && !cardLocked && (choose ? printedKey(question, label) !== undefined : single);
  // A card routes to Terminal when no exact live question can supply its own
  // printed keys. An unreadable dialog must never guess a positional key.
  const liveQuestion = choose
    ? entry.questions.find((question) => live(question))
    : undefined;
  const needsTerminal =
    !entry.resolved &&
    !cardLocked && choose?.family !== "claude-ask-user-review-v1" &&
    (choose
      ? !liveQuestion ||
        liveQuestion.multi ||
        liveQuestion.options.some((option) => !tappable(liveQuestion, option.label))
      : !single || Boolean(dialog));
  const chosen = (question: Question) => {
    // A keyed result names the labels it picked, per question. The substring
    // match below is for harnesses that only echo the answer back as text.
    const picked = question.answers?.[0];
    if (picked) return picked;
    const answer = entry.answer?.toLowerCase();
    if (!answer) return null;
    // Longest label first: "Yes" is a substring of "Yes, and deploy", so
    // first-match-in-option-order would tick the wrong row.
    const byLength = [...question.options].sort((a, b) => b.label.length - a.label.length);
    return (
      byLength.find((o) => o.label.toLowerCase() === answer)?.label ??
      byLength.find((o) => answer.includes(o.label.toLowerCase()))?.label ??
      null
    );
  };
  return (
    <article
      data-entry-id={entry.id}
      data-role="question"
      className={cn(
        "min-w-0 rounded-xl border p-3",
        entry.resolved ? "border-border bg-surface/40" : "border-working/40 bg-surface/60",
      )}
    >
      <p className="mb-2 text-xs font-medium uppercase tracking-[0.14em] text-working">
        {entry.title}
        {entry.resolved ? " · answered" : canAnswer ? " · waiting on you" : ""}
      </p>
      {entry.questions.map((question, questionIndex) => {
        const selected = chosen(question);
        const answerable = question.options.some((o) => tappable(question, o.label));
        return (
          <div key={questionIndex} className={cn(questionIndex ? "mt-3 border-t border-border pt-3" : "", canAnswer && !answerable && "opacity-70")}>
            <p className="break-words text-sm font-medium">{question.text}</p>
            {question.multi ? (
              <div className="mt-2 space-y-1">
                {question.options.map((option) => (
                  <p key={option.label} className="flex items-baseline gap-2 break-words text-sm text-muted">
                    <span className="text-subtle">{question.answers?.includes(option.label) ? "☑" : "☐"}</span>
                    {option.label}
                  </p>
                ))}
              </div>
            ) : (
              <div className="mt-2 space-y-2">
                {question.options.map((option, optionIndex) => {
                  const isChosen = selected === option.label;
                  const printed = printedKey(question, option.label);
                  const canTap = tappable(question, option.label);
                  const wasSent = Boolean(
                    sent &&
                    sent.token === dialogToken &&
                    sent.id === `${questionIndex}:${optionIndex}`,
                  );
                  const busy = wasSent && cardLocked;
                  return (
                    <button
                      key={option.label}
                      type="button"
                      aria-label={`Answer ${question.text}: ${option.label}`}
                      disabled={!canTap}
                      onClick={() => {
                        const attempt = ++answerAttempt.current;
                        setSent({
                          token: dialogToken,
                          id: `${questionIndex}:${optionIndex}`,
                          attempt,
                        });
                        onAnswer?.(question, optionIndex, printed, (outcome) => {
                          // A token answer stays latched once it lands: the
                          // token is spent. A keyed answer latches only while
                          // it is in flight, because landing does not mean the
                          // pane is done asking -- it may want another key.
                          if (choose && outcome.state !== "failed") return;
                          setSent((current) => current?.attempt === attempt ? null : current);
                        });
                      }}
                      className={cn(
                        "flex min-h-11 w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm tap-scale",
                        busy ? "border-accent bg-accent/10" : isChosen ? "border-working/60 bg-working/10" : "border-border",
                        busy ? "opacity-100" : cardLocked || !canTap ? "opacity-70" : undefined,
                      )}
                    >
                      {printed ? (
                        <span className="shrink-0 rounded-md border border-border px-1.5 font-mono text-xs text-subtle">{printed}</span>
                      ) : null}
                      {/* Labels and descriptions wrap: a long one used to run the
                          row off the side of a phone, hiding its tail. */}
                      <span className="min-w-0 flex-1 break-words">
                        {option.label}
                        {option.description ? <span className="mt-0.5 block text-xs text-subtle">{option.description}</span> : null}
                      </span>
                      {isChosen ? <Check className="size-4 shrink-0 text-working" /> : null}
                      {wasSent && !isChosen ? <span className="shrink-0 text-xs text-working">sent</span> : null}
                    </button>
                  );
                })}
              </div>
            )}
            {/* A keyed result answers each question separately; a plain text
                one is the whole entry's answer, and repeats under each. */}
            {entry.resolved && (question.answers?.length || entry.answer) ? (
              <p className="mt-2 text-xs text-muted">
                Answered: {question.answers?.length ? question.answers.join(", ") : entry.answer}
              </p>
            ) : null}
          </div>
        );
      })}
      {needsTerminal && onUseTerminal ? (
        <button
          type="button"
          onClick={onUseTerminal}
          className="mt-3 flex h-11 w-full items-center justify-center rounded-lg border border-border text-sm font-medium tap-scale"
        >
          Answer in Terminal
        </button>
      ) : null}
      {!entry.resolved && single && !choose ? (
        <p className="mt-2 text-xs text-subtle">Or type your own answer in the composer below.</p>
      ) : null}
    </article>
  );
}

// The collapse is a clamp on the rendered block, never a cut in the Markdown
// source, so a fence or a link can't be broken. `clipped` marks that the clamp
// really hides something, so a message that fits gets no fade. There is no
// height animation: the reader's anchor must hold on the frame of the tap.
function ClampedText({ text, collapsed, id }: { text: string; collapsed: boolean; id: string }) {
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const mark = () => { el.dataset.clipped = String(collapsed && el.scrollHeight > el.clientHeight + 1); };
    mark();
    const observer = new ResizeObserver(mark);
    observer.observe(el);
    return () => observer.disconnect();
  }, [collapsed, text]);
  return <div ref={box} id={id} data-collapsed={collapsed} className="message-clamp"><ChatMarkdown text={text} /></div>;
}

function UserMessage({ text, expanded, forced, onToggle, onCopy }: {
  text: string; expanded: boolean; forced: boolean; onToggle: (open: boolean) => void; onCopy: () => void;
}) {
  const textId = useId();
  const copy = <button type="button" aria-label="Copy message" onClick={onCopy} className="flex h-8 items-center gap-1 text-xs text-subtle"><Copy className="size-3" /> Copy</button>;
  return <>
    <ClampedText id={textId} text={text} collapsed={!expanded} />
    <div className="mt-1 flex items-center gap-4">
      {/* Search forces the message open, so it has nothing to toggle there. */}
      {!forced && <button type="button" aria-expanded={expanded} aria-controls={textId} onClick={() => onToggle(!expanded)} className="-ml-1 flex h-11 min-w-11 items-center gap-1 rounded-lg px-1 text-xs font-medium text-muted">
        <ChevronDown className={cn("size-3.5", expanded && "rotate-180")} />
        {expanded ? "Show less" : "Show more"}
      </button>}
      {copy}
    </div>
  </>;
}

const marker = "list-none [&::-webkit-details-marker]:hidden";

function ActivityGroup({ id, activities, search, reading, onCopy }: {
  id: string; activities: ActivityEntry[]; search: boolean; reading: Reading; onCopy: (activity: ActivityEntry) => void;
}) {
  const running = activities.some((a) => a.status === "running");
  const failed = activities.some((a) => a.status === "failed");
  // A toggle event also follows our own open changes (first render, a status
  // change, search forcing it open), so only a state that differs from the
  // default is recorded as the reader's choice.
  const choose = (map: Map<string, boolean>, key: string, open: boolean, byDefault: boolean) => {
    if (search) return;
    if (open === byDefault) map.delete(key);
    else map.set(key, open);
  };
  return <details data-entry-id={id} open={search || (reading.open.get(id) ?? failed)} onToggle={(e) => choose(reading.open, id, e.currentTarget.open, failed)} className="group/activity text-sm">
    <summary className={cn(marker, "flex min-h-8 cursor-pointer items-center gap-2 text-muted")}>
      {running
        ? <span className="size-1.5 shrink-0 rounded-full bg-working motion-blink" />
        : <ChevronRight className="size-4 shrink-0 transition-transform group-open/activity:rotate-90" />}
      <span className={cn("min-w-0 truncate", failed && "text-blocked")}>{activitySummary(activities)}</span>
    </summary>
    <div className="ml-2 mt-1 border-l border-border pl-3">
      {activities.map((activity) => {
        const { kind, label } = describeActivity(activity);
        const byStatus = activity.status === "failed";
        return <details key={activity.id} data-activity-id={activity.id} open={search || (reading.nested.get(activity.id) ?? byStatus)} onToggle={(e) => choose(reading.nested, activity.id, e.currentTarget.open, byStatus)} className="group/row">
          <summary className={cn(marker, "flex min-h-8 cursor-pointer items-center gap-2", activity.status === "failed" ? "text-blocked" : "text-muted")}>
            <span className="shrink-0 text-fg">{phrases[kind].done}</span>
            <span className="min-w-0 truncate font-mono text-xs">{label}</span>
            {activity.status === "running" && <span className="size-1.5 shrink-0 rounded-full bg-working motion-blink" />}
            {activity.status === "failed" && <span className="shrink-0 text-xs">failed</span>}
          </summary>
          <div className="mb-2 rounded-lg bg-surface/40 px-3 py-1">
            {activity.input && <pre className="my-2 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">{activity.input}</pre>}
            {activity.diff && <pre className="my-2 overflow-auto font-mono text-xs">{activity.diff.split("\n").map((line, i) => <div key={i} className={line.startsWith("+") ? "bg-working/10 text-working" : line.startsWith("-") ? "bg-blocked/10 text-blocked" : ""}>{line || " "}</div>)}</pre>}
            {activity.output && <pre className="my-2 max-h-96 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">{activity.output}</pre>}
            <button type="button" onClick={() => onCopy(activity)} className="py-2 text-xs text-muted">Copy activity</button>
          </div>
        </details>;
      })}
    </div>
  </details>;
}

export function Conversation({ sessionId, epoch = 0, entries, working, before, loadOlder, loadingOlder, dialog, blocked, onAnswer, onUseTerminal, nativePane }: {
  /** The toggle for the agent's live pane shown inside Chat. */
  nativePane?: { open: boolean; onToggle: () => void };
  sessionId: string; epoch?: number; entries: SessionEntry[]; working: boolean; before: string | null; loadOlder: () => void; loadingOlder: boolean;
  dialog?: BlockedDialog;
  blocked?: boolean;
  onAnswer?: (question: Question, optionIndex: number, printedKey?: string, onOutcome?: AnswerCallback) => void; onUseTerminal?: () => void;
}) {
  const normal = useRef(readings.get(sessionId) ?? freshReading());
  // Search owns its own coordinates and expansion: filtered results and
  // forced-open groups must not overwrite where the reader was, so clearing
  // the search returns them there. It starts from the normal position.
  const searching = useRef<Reading | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const previousHeight = useRef(0);
  const prepending = useRef(false);
  const previousEntries = useRef(entries);
  const mounted = useRef(false);
  const [search, setSearch] = useState("");
  const [unseen, setUnseen] = useState(false);
  // Counts message expansion toggles: the choice lives in `Reading.open`, which
  // renders nothing by itself, and the layout effect re-enters applyReading.
  const [toggles, setToggles] = useState(0);
  if (search) searching.current ??= { ...freshReading(), following: false, top: normal.current.top, anchor: normal.current.anchor };
  else searching.current = null;
  // The reading every scroll path reads and writes: the search one while a
  // query is typed, otherwise the normal one.
  const reading = useRef(normal.current);
  reading.current = searching.current ?? normal.current;
  const seenEpoch = useRef(epoch);
  // A reset stream drops the choices for entries it no longer has; ordinary
  // polls only add entries, so they never prune.
  if (seenEpoch.current !== epoch) {
    seenEpoch.current = epoch;
    const ids = new Set(entries.map((entry) => entry.id));
    for (const map of [normal.current.open, normal.current.nested]) for (const id of map.keys()) if (!ids.has(id)) map.delete(id);
  }
  useLayoutEffect(() => {
    const element = scroll.current;
    if (!element) return;
    if (!mounted.current) {
      if (reading.current.following) element.scrollTop = element.scrollHeight;
      else restoreAnchor(element, reading.current);
      mounted.current = true;
    } else {
      applyReading(element, reading.current, {
        search: Boolean(search),
        contentChanged: entries !== previousEntries.current,
        prepending: prepending.current && !loadingOlder,
        previousHeight: previousHeight.current,
      }, setUnseen);
      if (prepending.current && !loadingOlder) prepending.current = false;
    }
    previousEntries.current = entries;
    readings.set(sessionId, normal.current);
  }, [entries, loadingOlder, search, sessionId, toggles]);

  useEffect(() => {
    const element = scroll.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      applyReading(element, reading.current, { search: Boolean(search), contentChanged: false, prepending: false, previousHeight: 0 }, setUnseen);
    });
    // The box and what it holds: an image, a toggled group or a reflow after
    // the box resized all change the content height, not the box.
    observer.observe(element);
    const content = element.querySelector(".conversation-pad");
    if (content) observer.observe(content);
    return () => observer.disconnect();
  }, [search]);

  const visible = search ? entries.filter((entry) => entryText(entry).toLowerCase().includes(search.toLowerCase())) : entries;
  const groups: { id: string; activities: Extract<SessionEntry, { kind: "activity" }>[]; entry?: Exclude<SessionEntry, { kind: "activity" }> }[] = [];
  for (const entry of visible) {
    const last = groups.at(-1);
    if (entry.kind === "activity") {
      if (last && !last.entry && last.activities[0]?.turnId === entry.turnId) last.activities.push(entry);
      else groups.push({ id: entry.id, activities: [entry] });
    } else groups.push({ id: entry.id, entry, activities: [] });
  }
  function userScroll() {
    reading.current.intent = true;
  }
  // Only a state that differs from the default (collapsed) is a choice.
  function toggleMessage(id: string, open: boolean) {
    if (open) normal.current.open.set(id, true);
    else normal.current.open.delete(id);
    setToggles((n) => n + 1);
  }
  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); toast("Copied"); }
    catch { toast("Could not copy. Select the text to copy it."); }
  }
  const showWorking = working && !search;
  // While the agent works, Working sits above the turn's latest tool group
  // and stays there, so the group does not shift as each tool starts and ends.
  const trailing = showWorking && groups.at(-1)?.activities.length ? groups.length - 1 : -1;
  const workingLine = <p role="status" className="flex items-center gap-2 text-sm text-muted"><span className="size-1.5 rounded-full bg-working motion-blink" /> Working</p>;
  return <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
    <div className="mx-4 mt-2 flex shrink-0 items-center gap-2 text-muted">
      <label className="flex min-w-0 flex-1 items-center gap-2">
        <Search className="size-4 shrink-0" />
        <input aria-label="Search conversation" placeholder="Search loaded history" value={search} onChange={(e) => setSearch(e.target.value)} className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none" />
      </label>
      {nativePane && <button type="button" aria-label={nativePane.open ? "Hide native pane" : "Show native pane"} aria-pressed={nativePane.open} title="The agent's live pane, for menus and prompts a command opens" onClick={nativePane.onToggle} className={cn("flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium shadow-border", nativePane.open ? "bg-surface-2 text-fg" : "text-muted")}>
        <SquareTerminal className="size-4" />
        Pane
      </button>}
    </div>
    <div ref={scroll} className="conversation min-h-0 flex-1 overflow-y-auto" onLoadCapture={() => {
      if (scroll.current) applyReading(scroll.current, reading.current, { search: Boolean(search), contentChanged: false, prepending: false, previousHeight: 0 }, setUnseen);
    }} onWheel={userScroll} onTouchStart={userScroll} onPointerDown={userScroll} onKeyDown={userScroll} onScroll={(event) => {
      const el = event.currentTarget;
      reading.current.top = el.scrollTop;
      if (reading.current.applying || !reading.current.intent) return;
      const following = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      reading.current.following = following;
      reading.current.anchor = following ? null : captureAnchor(el);
      if (following) setUnseen(false);
    }}>
      <div className="conversation-pad">
      {before && <button type="button" disabled={loadingOlder} className="mb-6 rounded-lg border border-border px-4 py-2 text-sm text-muted" onClick={() => {
        previousHeight.current = scroll.current?.scrollHeight ?? 0;
        prepending.current = true;
        loadOlder();
      }}>{loadingOlder ? "Loading history…" : "Load older history"}</button>}
      <div className="space-y-6">
        {groups.map((group, index) => {
          const entry = group.entry;
          if (index === trailing) return <Fragment key={group.id}>
            {workingLine}
            <ActivityGroup id={group.id} activities={group.activities} search={false} reading={normal.current} onCopy={(a) => void copy(entryText(a))} />
          </Fragment>;
          return entry?.kind === "question" ? (
            <QuestionCard key={group.id} entry={entry} dialog={dialog} blocked={blocked} onAnswer={onAnswer} onUseTerminal={onUseTerminal} />
          ) : entry && "text" in entry ? (
            <article key={group.id} data-entry-id={group.id} data-role={entry.kind === "message" ? entry.role === "assistant" ? "agent" : "user" : "system"} className={entry.kind === "status" ? "text-xs text-muted" : entry.role === "user" ? "ml-auto max-w-[92%] rounded-xl bg-surface px-3 py-2" : "min-w-0 rounded-xl border border-border p-3 text-base leading-relaxed"}>
              {entry.kind === "message" && entry.role === "user" && isLongMessage(entry.text)
                ? <UserMessage text={entry.text} expanded={Boolean(search) || (normal.current.open.get(group.id) ?? false)} forced={Boolean(search)} onToggle={(open) => toggleMessage(group.id, open)} onCopy={() => void copy(entry.text)} />
                : <>
                  <ChatMarkdown text={entry.text} />
                  {entry.kind === "message" && <button type="button" aria-label="Copy message" onClick={() => void copy(entry?.text ?? "")} className="mt-1 flex h-8 items-center gap-1 text-xs text-subtle"><Copy className="size-3" /> Copy</button>}
                </>}
            </article>
          ) : (
            <ActivityGroup key={group.id} id={group.id} activities={group.activities} search={Boolean(search)} reading={normal.current} onCopy={(a) => void copy(entryText(a))} />
          );
        })}
        {search && !visible.length && <p className="text-sm text-muted">No matches in loaded history.</p>}
        {showWorking && trailing < 0 && workingLine}
      </div>
      </div>
    </div>
    {unseen && !search && <button type="button" onClick={() => {
      reading.current.following = true;
      reading.current.anchor = null;
      if (scroll.current) applyReading(scroll.current, reading.current, { search: false, contentChanged: false, prepending: false, previousHeight: 0 }, setUnseen);
      setUnseen(false);
    }} className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-bg px-4 py-2 text-sm shadow-sm"><ArrowDown className="size-4" /> New activity</button>}
  </div>;
}
