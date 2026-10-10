import { ArrowUp, BookMarked, ChevronDown, Keyboard, LoaderCircle, Mic, Paperclip, Pencil, Reply, Slash, Square, Trash2, X } from "lucide-react";
import { memo, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { toast } from "sonner";
import { useMoshpitStore } from "@/lib/moshpit/store";
import { newId } from "@/lib/moshpit/events";
import { draftSessionId, draftStore, listDrafts, useDraft } from "@/lib/moshpit/drafts";
import type { DraftKey } from "@/lib/moshpit/drafts";
import { bridgeUrl, encodeImage, fetchCommands, uploadFile, type StoredFile } from "@/lib/moshpit/bridge";
import { commandScope, detectCommandToken, insertPrefix, insertSuggestion, matchCommands, mergeCatalog, type CommandSuggestion, type DisplayCatalog, type RemoteCatalog, type TokenRange } from "@/lib/moshpit/commands";
import { builtinCommands, collisionPolicy } from "@/lib/moshpit/builtin-commands";
import { submitSession } from "@/lib/moshpit/session";
import { ContextMeter } from "@/components/moshpit/context-meter";
import { hasContextMeter } from "@/lib/moshpit/context-meter";
import type { ContextUsage, InputMode, Receipt, SessionCapabilities } from "@/lib/moshpit/session-protocol";
import type { Agent, Snippet } from "@/lib/moshpit/types";
import { SNIPPET_LIMITS, validateSnippet } from "@/lib/moshpit/snippets";
import { quickRepliesFor, type QuickReply } from "@/lib/moshpit/quick-replies";
import { useDismiss } from "@/lib/moshpit/use-dismiss";
import { cn } from "@/lib/utils";
import { useOnline } from "@/lib/moshpit/network";
import { validateImage } from "@/lib/moshpit/image";
import { DEMO_FILE_DIRECTORY, formatBytes, insertQuotedPath, isImageFile, validateFile } from "@/lib/moshpit/file-upload";
import { FileSendDialog } from "@/components/moshpit/file-send-dialog";
import { reviewCommentLabel, withReviewComments } from "@/lib/moshpit/review-comments";
import { ReviewCommentsChip } from "@/components/moshpit/review-comments-chip";

type Recognition = {
  lang: string; interimResults: boolean; continuous: boolean;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null; onerror: (() => void) | null;
  start(): void; stop(): void;
};
function speechConstructor(): (new () => Recognition) | undefined {
  if (typeof window === "undefined") return;
  if ("SpeechRecognition" in window && typeof window.SpeechRecognition === "function") return window.SpeechRecognition as new () => Recognition;
  if ("webkitSpeechRecognition" in window && typeof window.webkitSpeechRecognition === "function") return window.webkitSpeechRecognition as new () => Recognition;
}

type Props = {
  agent: Agent; sessionId?: string; capabilities?: SessionCapabilities; mode?: "chat" | "terminal"; liveQuestion?: boolean;
  /** Terminal key bar slot: quick replies render there as a popover button instead of a full-width row. */
  quickRepliesSlot?: HTMLElement | null;
  /** Chat only: the agent's live pane shown inside Chat, offered after a delivery. */
  nativePane?: { open: boolean; onToggle: () => void };
  /** Called once a submission is delivered, with its request ID. */
  onDelivered?: (requestId: string) => void;
  /** Chat only: context use of the session's latest model call, when the bridge reports it. */
  context?: ContextUsage;
  /** Opens the Changes sheet, where review comments are written. `returnTo` takes focus back when it closes. */
  onOpenChanges?: (returnTo: HTMLElement | null) => void;
};

// A message that opens with a command is the command's, so staged comments
// would become its arguments instead of reaching the agent.
const commandLike = (text: string) => /^\s*[/$][\w:.-]*(\s|$)/.test(text);

/**
 * Quick replies as one key-bar button, beside the display options. A
 * full-width row between the key bar and the input cost the pane a row of
 * height on every screen, for replies used now and then.
 */
function QuickRepliesMenu({ replies, disabled, onPick }: {
  replies: readonly QuickReply[];
  disabled: boolean;
  onPick: (reply: QuickReply) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  useDismiss(open, () => setOpen(false), root);
  return <div ref={root} className="quick-replies relative shrink-0">
    <button
      type="button"
      aria-label="Quick replies"
      aria-expanded={open}
      title="Quick replies"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => setOpen((v) => !v)}
      className={cn("flex size-9 items-center justify-center rounded-sm text-muted shadow-border", open && "bg-surface-2")}
    ><Reply className="size-4" aria-hidden="true" /></button>
    {open && <section aria-label="Quick replies" className="absolute bottom-11 right-0 z-20 w-64 rounded-xl border border-border bg-bg p-2 shadow-lg">
      <div className="quick-replies-list flex flex-wrap gap-2">
        {replies.map((reply) => <button
          key={reply.id}
          type="button"
          disabled={disabled}
          onMouseDown={(e) => e.preventDefault()}
          className="min-h-10 rounded-lg border border-border bg-bg px-3 py-2 text-left text-sm tap-scale disabled:opacity-50"
          onClick={() => { setOpen(false); onPick(reply); }}
        >{reply.label}</button>)}
      </div>
    </section>}
  </div>;
}
const fallbackCapabilities: SessionCapabilities = { inputModes: [], stop: false, fit: false };
export const Composer = memo(function Composer(props: Props) {
  const hostId = useMoshpitStore((s) => s.connectedHostId) ?? "disconnected";
  const demo = useMoshpitStore((s) => Boolean(s.hosts.find((h) => h.id === s.connectedHostId)?.demo));
  const sessionId = props.sessionId ?? draftSessionId(props.agent, demo);
  const key: DraftKey = [hostId, sessionId, props.mode === "terminal" ? "terminal" : "conversation"];
  return <SessionComposer key={JSON.stringify(key)} {...props} draftKey={key} />;
});

function SessionComposer({ agent, draftKey, capabilities = fallbackCapabilities, mode = "chat", liveQuestion, quickRepliesSlot, nativePane, onDelivered, context, onOpenChanges }: Props & { draftKey: DraftKey }) {
  const saved = useDraft(draftKey);
  const { draft } = saved;
  const hostId = useMoshpitStore((s) => s.connectedHostId) ?? "disconnected";
  const host = useMoshpitStore((s) => s.hosts.find((h) => h.id === s.connectedHostId));
  const ready = useMoshpitStore((s) => s.hostAccess.status === "ready");
  const prompt = useMoshpitStore((s) => s.prompt);
  const snippets = useMoshpitStore((s) => s.snippets);
  const saveSnippet = useMoshpitStore((s) => s.saveSnippet);
  const deleteSnippet = useMoshpitStore((s) => s.deleteSnippet);
  const sendKeys = useMoshpitStore((s) => s.sendKeys);
  const answerDialog = useMoshpitStore((s) => s.answerDialog);
  const blockedInsertion = useMoshpitStore((s) => Boolean(s.blockedInsertions[agent.id]));
  const recordBlockedInsertion = useMoshpitStore((s) => s.recordBlockedInsertion);
  const setDetailView = useMoshpitStore((s) => s.setDetailView);
  const voice = useMoshpitStore((s) => s.settings.voice);
  const terminal = mode === "terminal";
  const [inputMode, setInputMode] = useState<InputMode>("send");
  const [listening, setListening] = useState(false);
  const [preview, setPreview] = useState<string>();
  const [dragging, setDragging] = useState(false);
  // A non-image file waiting on the question, where the caret was when it was
  // picked, and the last file copied to the host (kept on screen: it outlives
  // the session). `caretAfter` is set while focus is on its way back to the
  // input once the dialog closes.
  const [offer, setOffer] = useState<File | null>(null);
  const [stored, setStored] = useState<StoredFile | null>(null);
  const fileSel = useRef<{ start: number; end: number } | null>(null);
  const caretAfter = useRef<number | null>(null);
  const [recovered, setRecovered] = useState<Awaited<ReturnType<typeof listDrafts>>>([]);
  // Captured when the picker opens: focusing the picker's inputs must not
  // move where the snippet lands.
  // A ref, not state: it never renders, and two quick taps on different
  // snippets must both see the insertion point the previous tap left.
  const snippetSel = useRef<{ start: number; end: number } | null>(null);
  const [snippetName, setSnippetName] = useState("");
  const [snippetText, setSnippetText] = useState("");
  const [snippetEditingId, setSnippetEditingId] = useState<string | null>(null);
  const [snippetFormError, setSnippetFormError] = useState<string | null>(null);
  // <details> has no outside-click dismissal, so the only way out of these
  // popovers was the summary icon you opened them with. Refs let an explicit
  // close button shut them. Insertion deliberately leaves the picker open:
  // snippetSel advances to the new caret so several can be inserted in a row.
  const tools = useRef<HTMLDetailsElement>(null);
  const picker = useRef<HTMLDetailsElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const attach = useRef<HTMLButtonElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const recognition = useRef<Recognition | null>(null);
  const pending = useRef(false);
  const online = useOnline();
  const busy = draft.submission?.state === "submitting";
  const [caret, setCaret] = useState(0);
  const [composing, setComposing] = useState(false);
  const [dismissedToken, setDismissedToken] = useState<string | null>(null);
  const [answerLock, setAnswerLock] = useState<{ token: string; key: string; attempt: number } | null>(null);
  const answerAttempt = useRef(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const catalogGen = useRef(0);
  const [refresh, setRefresh] = useState(0);
  const agentId = agent.id;
  const agentSessionId = agent.sessionId;
  const agentCwd = agent.cwd;
  const agentProjectRoot = agent.projectRoot;
  const scope = useMemo(
    () => commandScope({ id: agentId, sessionId: agentSessionId, cwd: agentCwd, projectRoot: agentProjectRoot }),
    [agentId, agentSessionId, agentCwd, agentProjectRoot],
  );
  const catalogUrl = online && host && !host.demo && agent.kind !== "shell" ? bridgeUrl(host) : "";
  const discoveryKey = JSON.stringify([
    hostId,
    catalogUrl,
    agent.id,
    agent.sessionId ?? null,
    agent.kind,
    scope?.project ?? null,
    refresh,
  ]);
  type DiscoveryState =
    | { key: string; status: "loading" }
    | { key: string; status: "unavailable" }
    | { key: string; status: "failed"; message: string }
    | { key: string; status: "ready"; value: RemoteCatalog };
  const [discovery, setDiscovery] = useState<DiscoveryState>(() => ({
    key: discoveryKey,
    status: scope && catalogUrl ? "loading" : "unavailable",
  }));
  useEffect(() => {
    const gen = ++catalogGen.current;
    const key = discoveryKey;
    if (!scope || !catalogUrl) {
      setDiscovery({ key, status: "unavailable" });
      return;
    }
    setDiscovery({ key, status: "loading" });
    const controller = new AbortController();
    fetchCommands(catalogUrl, scope, controller.signal)
      .then((value) => {
        if (catalogGen.current !== gen || controller.signal.aborted) return;
        setDiscovery({ key, status: "ready", value });
      })
      .catch((error) => {
        if (catalogGen.current !== gen || controller.signal.aborted) return;
        setDiscovery({
          key,
          status: "failed",
          message: error instanceof Error ? error.message : "Command discovery failed.",
        });
      });
    return () => controller.abort();
  }, [discoveryKey, scope, catalogUrl]);
  const liveDiscovery = discovery.key === discoveryKey ? discovery : null;
  const remote: DisplayCatalog | undefined =
    liveDiscovery?.status === "ready" ? liveDiscovery.value.catalog : undefined;
  const catalog = useMemo(
    () => mergeCatalog(builtinCommands(agent.kind), remote, collisionPolicy(agent.kind)),
    [agent.kind, remote],
  );
  // Terminal input only needs a paired device; native sends need the exact
  // session identity so they cannot land in a different session.
  const unavailable = (!online && !host?.demo) || !saved.loaded || (!host?.demo && !ready) || (!host?.demo && !terminal && !agent.sessionId);
  const modes = capabilities.inputModes;
  const selectedMode = modes.includes(inputMode) ? inputMode : "send";
  const canSend = terminal || host?.demo || modes.includes(selectedMode);
  const choose = !terminal && agent.status === "blocked" && agent.blockedDialog?.kind === "choose" ? agent.blockedDialog : undefined;
  const ownsKeyboard = Boolean(choose);
  const chooseLocked = Boolean(choose && answerLock?.token === choose.expected.token);
  const quickReplies = quickRepliesFor(agent.kind);
  const showBlockedReplyKeys = !terminal && agent.status === "blocked" && blockedInsertion;

  useEffect(() => () => { const rec = recognition.current; recognition.current = null; rec?.stop(); }, []);
  const answerToken = choose?.expected.token;
  useEffect(() => {
    if (!answerToken || answerLock?.token !== answerToken) setAnswerLock(null);
  }, [answerToken, answerLock?.token]);
  // The prefix the insert button types: / where the harness has slash
  // commands, since it reaches the most of them, else the skill prefix.
  const buttonPrefix = catalog ? (catalog.prefixes.includes("/") ? "/" : catalog.prefixes[0]) : "";
  const insertLabel = buttonPrefix === "/skill:" ? "Insert skill command" : buttonPrefix === "/" ? "Insert slash command" : "Insert dollar command";
  const activeToken = !composing && !busy && catalog ? detectCommandToken(draft.text, caret, catalog.prefixes) : null;
  const tokenString = activeToken ? draft.text.slice(activeToken.start, activeToken.end) : null;
  const matches = activeToken && catalog ? matchCommands(catalog.commands, activeToken.prefix, draft.text.slice(activeToken.start + activeToken.prefix.length, activeToken.end)) : [];
  const listVisible = Boolean(activeToken && catalog && matches.length > 0 && (dismissedToken === null || dismissedToken !== tokenString));
  // Every match, not the first eight: the list scrolls.
  const shown = matches;
  const selectedIndex = Math.min(activeIndex, Math.max(0, shown.length - 1));
  const selected = shown[selectedIndex];
  const listId = useId();
  const optionList = useRef<HTMLUListElement>(null);
  // The identity a pointer gesture began under, captured at pointerdown:
  // the discovery key, the draft revision and the token range. A click that
  // lands after any of them moved is stale and must not write the draft.
  const gesture = useRef<{ key: string; revision: number; start: number; end: number; token: string; invocation: string } | null>(null);
  const noMatch = Boolean(activeToken && catalog && matches.length === 0 && (dismissedToken === null || dismissedToken !== tokenString));
  const discoveryNote = (() => {
    if (!liveDiscovery) return null;
    switch (liveDiscovery.status) {
      case "loading":
        return "Loading commands…";
      case "unavailable":
        return "Command discovery is unavailable for this session.";
      case "failed":
        return "Could not load commands. Type them anyway.";
      case "ready": {
        if (liveDiscovery.value.catalog.coverage === "unsupported") return "Command discovery is unavailable for this agent.";
        if (liveDiscovery.value.truncated) return "Commands list is truncated.";
        if (liveDiscovery.value.catalog.coverage === "partial") return "Commands may be incomplete.";
        return null;
      }
    }
  })();
  useEffect(() => { setActiveIndex(0); }, [tokenString]);
  // The list scrolls at eight rows, so arrowing past the fold has to bring
  // the highlighted row back into view or the selection goes invisible.
  useEffect(() => {
    if (!listVisible) return;
    optionList.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [listVisible, selectedIndex]);
  useEffect(() => {
    if (!draft.attachment) { setPreview(undefined); return; }
    const url = URL.createObjectURL(draft.attachment);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [draft.attachment]);
  useEffect(() => {
    if (!textarea.current) return;
    textarea.current.style.height = "auto";
    textarea.current.style.height = `${Math.min(160, textarea.current.scrollHeight)}px`;
  }, [draft.text]);

  async function submit(action: InputMode | "terminal" | "stop" = terminal ? "terminal" : selectedMode, textOverride?: string) {
    if (pending.current || unavailable || busy || (!canSend && action !== "stop")) return;
    if (ownsKeyboard && action !== "stop" && action !== "terminal") {
      toast("This dialog owns the keyboard. Pick an option or answer in Terminal.");
      return;
    }
    const quickReply = textOverride !== undefined;
    // Trimming only decides whether there is anything to send. What goes out
    // is the text as written, less the line breaks around it: spacing inside
    // a command's arguments is the command's business, while a stray leading
    // or trailing line break would submit early or twice.
    const text = textOverride ?? (terminal ? draft.text : draft.text.replace(/^[\r\n]+|[\r\n]+$/g, ""));
    // Review comments ride with the draft's own send, never a quick reply or a stop.
    const comments = quickReply || action === "stop" ? [] : draft.comments;
    if (action !== "terminal" && action !== "stop" && !text.trim() && !draft.attachment && !comments.length) return;
    if (comments.length && commandLike(text)) {
      toast("A command can't carry review comments", { description: "Send the command on its own first, or clear the comments." });
      return;
    }
    // What the agent receives: the typed text, then the comments as one block.
    const outgoing = withReviewComments(text, comments);
    if (outgoing.length > SNIPPET_LIMITS.text) {
      toast("Too long to send", { description: "The review comments would push the message past the send limit. Shorten the message or remove some comments." });
      return;
    }
    pending.current = true;
    const rec = recognition.current; recognition.current = null; rec?.stop(); setListening(false);
    const id = newId();
    const revision = draft.revision;
    const attachment = quickReply ? undefined : draft.attachment ?? undefined;
    if (!quickReply) await saved.markSubmitting(id, comments);
    let receipt: Receipt;
    try {
      if (host?.demo) {
        const success = action === "stop" ? (sendKeys(agent.id, "esc"), true) : await prompt(agent.id, outgoing, attachment);
        if (success && action === "terminal") sendKeys(agent.id, "enter");
        receipt = { id, state: success ? "delivered" : "failed", message: success ? "Sent" : "Not sent. Your draft is saved." };
      } else if (host && ready) {
        receipt = await submitSession(bridgeUrl(host), {
          id, target: agent.id, sessionId: draftKey[1], mode: action, text: action === "stop" ? "" : outgoing,
          attachment: action !== "stop" && attachment ? await encodeImage(attachment) : undefined,
        });
      } else receipt = { id, state: "failed", message: "Reconnect to send. Your draft is saved." };
    } catch (error) {
      receipt = { id, state: "failed", message: error instanceof Error ? error.message : "Could not prepare the message." };
    } finally { pending.current = false; }
    if (receipt.state === "delivered" && agent.status === "blocked" && action !== "terminal" && action !== "stop") {
      recordBlockedInsertion(agent);
    }
    if (receipt.state === "delivered" && action !== "stop") onDelivered?.(id);
    // Stopping the agent must not discard the message being composed.
    if (!quickReply) saved.settle({ requestId: id, state: receipt.state, message: receipt.message }, action === "stop" ? -1 : revision);
    // A quick reply keeps the saved draft, so it never goes through settle --
    // which is the only thing that renders a receipt. Without this a reply
    // the bridge refused would leave nothing on screen at all.
    else if (receipt.state !== "delivered") toast(receipt.message);
  }

  function pickImage(image?: File) {
    if (!image || draftStore(draftKey).getSnapshot().draft.submission?.state === "submitting") return;
    const error = validateImage(image);
    if (error) { toast(error); return; }
    saved.update({ attachment: image });
  }
  // An image stays an attachment, sent with the prompt. Anything else is
  // copied to the host after a question, and only its path joins the draft.
  function pickFile(picked?: File) {
    if (!picked) return;
    if (isImageFile(picked)) { pickImage(picked); return; }
    if (draftStore(draftKey).getSnapshot().draft.submission?.state === "submitting") return;
    const error = validateFile(picked);
    if (error) { toast(error); return; }
    if (!host?.demo && (!online || !ready)) {
      toast("Reconnect to send a file", { description: "A file is copied to the host when you pick it, so this needs a connection." });
      return;
    }
    const input = textarea.current;
    const length = draftStore(draftKey).getSnapshot().draft.text.length;
    fileSel.current = { start: input?.selectionStart ?? length, end: input?.selectionEnd ?? length };
    setOffer(picked);
  }
  function copyFile(picked: File, signal: AbortSignal): Promise<StoredFile> {
    if (host?.demo) {
      // No request in demo mode: a fixture path after a short wait.
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ path: `${DEMO_FILE_DIRECTORY}/${picked.name}`, name: picked.name, size: picked.size }), 400);
        signal.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("Cancelled", "AbortError")); }, { once: true });
      });
    }
    if (!host || !ready) return Promise.reject(new Error("Reconnect to send a file."));
    return uploadFile(bridgeUrl(host), agent.id, picked, signal);
  }
  // The path goes in at the caret, quoted, and the message is not sent. A
  // draft too long to take it keeps its text; the path is on screen below.
  function filePlaced(result: StoredFile) {
    setOffer(null);
    setStored(result);
    const live = draftStore(draftKey).getSnapshot().draft.text;
    const at = fileSel.current ?? { start: live.length, end: live.length };
    fileSel.current = null;
    const next = insertQuotedPath(live, at.start, at.end, result.path);
    if (next.text.length > SNIPPET_LIMITS.text) {
      toast("The path doesn't fit", { description: "The draft would pass the send limit. The path is shown below the message." });
      return;
    }
    flushSync(() => saved.update({ text: next.text }));
    caretAfter.current = next.caret;
  }
  // Where focus goes when the file dialog closes: the input with the caret
  // after the path, or the button that opened it.
  function afterFileDialog() {
    const caretAt = caretAfter.current;
    caretAfter.current = null;
    const input = textarea.current;
    if (caretAt === null || !input) return attach.current;
    input.setSelectionRange(caretAt, caretAt);
    setCaret(caretAt);
    return input;
  }
  // Insertion never sends: it edits the draft through the same revision path
  // as typing, then restores focus and the caret to the inserted token.
  // flushSync lands the controlled update before this returns, so the
  // selection write below is the final state — no deferred frame that could
  // steal a later user caret or focus.
  function commitDraft(text: string, caret: number) {
    flushSync(() => saved.update({ text }));
    const el = textarea.current;
    if (el) {
      el.focus();
      el.setSelectionRange(caret, caret);
    }
    setCaret(caret);
  }
  function chooseCommand(command: CommandSuggestion, fromPointer: boolean) {
    if (!catalog || busy) return;
    const input = textarea.current;
    if (!input) return;
    const live = draftStore(draftKey).getSnapshot().draft;
    let range: TokenRange;
    if (fromPointer) {
      const captured = gesture.current;
      gesture.current = null;
      if (!captured) return;
      if (captured.key !== discoveryKey) return;
      if (captured.revision !== live.revision) return;
      if (captured.invocation !== command.invocation) return;
      // Revalidate the LIVE token against the captured identity: a
      // caret-only move to a second identical token drifts the gesture.
      const liveToken = detectCommandToken(live.text, input.selectionStart ?? 0, catalog.prefixes);
      if (!liveToken || liveToken.start !== captured.start || liveToken.end !== captured.end) return;
      if (live.text.slice(captured.start, captured.end) !== captured.token) return;
      range = { start: captured.start, end: captured.end };
    } else {
      const token = activeToken;
      if (!token) return;
      if (draft.revision !== live.revision) return;
      range = token;
    }
    const next = insertSuggestion(live.text, range, command.invocation);
    setDismissedToken(null);
    commitDraft(next.text, next.caret);
  }
  function insertCommandPrefix() {
    if (!buttonPrefix || busy) return;
    const input = textarea.current;
    if (!input) return;
    const live = draftStore(draftKey).getSnapshot().draft;
    const next = insertPrefix(live.text, input.selectionStart ?? 0, input.selectionEnd ?? 0, buttonPrefix);
    setDismissedToken(null);
    commitDraft(next.text, next.caret);
  }
  function captureSelection() {
    const input = textarea.current;
    if (!input) return;
    snippetSel.current = { start: input.selectionStart, end: input.selectionEnd };
    // Prefill the save form with what is already in the draft.
    setSnippetText((text) => text || input.value);
  }
  function resetSnippetForm() {
    setSnippetName("");
    setSnippetText("");
    setSnippetEditingId(null);
    setSnippetFormError(null);
  }
  function saveSnippetForm() {
    const error = validateSnippet(snippetName, snippetText);
    if (error) { setSnippetFormError(error); return; }
    const ok = saveSnippet({ id: snippetEditingId ?? undefined, name: snippetName, text: snippetText });
    if (!ok) { setSnippetFormError(`Snippet limit reached (${SNIPPET_LIMITS.count}). Delete one first.`); return; }
    toast("Snippet saved", { description: snippetName.trim() });
    setSnippetName("");
    setSnippetText("");
    setSnippetEditingId(null);
    setSnippetFormError(null);
  }
  function editSnippet(snippet: Snippet) {
    setSnippetEditingId(snippet.id);
    setSnippetName(snippet.name);
    setSnippetText(snippet.text);
    setSnippetFormError(null);
  }
  // Inserts at the captured selection; a stale capture (dictation while the
  // picker was open) is clamped into the current text. Rejected when the
  // combined draft would exceed the 32,768 character send limit — the draft
  // is never truncated. Never submits.
  function insertSnippet(snippet: Snippet) {
    const input = textarea.current;
    if (!input || busy) return;
    // Read the live draft, not this render's copy: a second tap in the same
    // frame would otherwise splice into the pre-insert text and drop the first.
    const currentText = draftStore(draftKey).getSnapshot().draft.text;
    const at = snippetSel.current ?? { start: input.selectionStart, end: input.selectionEnd };
    const start = Math.min(at.start, currentText.length);
    const end = Math.min(at.end, currentText.length);
    const text = currentText.slice(0, start) + snippet.text + currentText.slice(end);
    if (text.length > SNIPPET_LIMITS.text) {
      toast("Snippet doesn't fit", { description: "The combined draft would exceed the send limit. Shorten the draft or the snippet first." });
      return;
    }
    saved.update({ text });
    const caret = start + snippet.text.length;
    snippetSel.current = { start: caret, end: caret };
    requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(caret, caret);
    });
  }
  function dictate() {
    if (listening) { recognition.current?.stop(); setListening(false); return; }
    const Ctor = speechConstructor();
    if (!voice || !Ctor) { toast(!voice ? "Voice is off in settings" : "Voice is not available in this browser"); return; }
    const rec = new Ctor();
    rec.lang = "en-US"; rec.interimResults = false; rec.continuous = false;
    rec.onresult = (event) => {
      if (recognition.current !== rec || pending.current) return;
      const said = event.results[0]?.[0]?.transcript;
      const current = draftStore(draftKey).getSnapshot().draft;
      if (said) saved.update({ text: current.text ? `${current.text} ${said}` : said });
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => { setListening(false); toast("Could not transcribe speech"); };
    recognition.current = rec;
    try { rec.start(); setListening(true); } catch { toast("Could not start the microphone"); }
  }

  return <div className={`composer-wrap bg-bg ${terminal ? "terminal-composer" : ""}`} onPaste={(event) => {
    if (event.clipboardData.files[0]) { event.preventDefault(); pickFile(event.clipboardData.files[0]); }
  }} onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); setDragging(true); } }} onDragLeave={() => setDragging(false)} onDrop={(event) => {
    event.preventDefault();
    setDragging(false);
    // Only the drop event can say that what was dropped is a folder.
    if (event.dataTransfer.items?.[0]?.webkitGetAsEntry?.()?.isDirectory) { toast("Folders can't be sent", { description: "Choose a file." }); return; }
    pickFile(event.dataTransfer.files[0]);
  }}>
    <div className="composer-blocks min-h-0 grow overflow-y-auto">
      {/* An unresolved question card in Chat already shows the prompt and its
          way out, so the banner would only repeat it. */}
      {agent.status === "blocked" && !terminal && !liveQuestion && <div className="mb-2 rounded-lg bg-blocked/5 px-3 py-2 text-sm">
      <p className="break-words">{choose?.question || agent.blockedPrompt || "Agent is waiting for input."}</p>
      {choose ? <div className="mt-2 space-y-2">{choose.options.map((option) => {
        const answerBusy = chooseLocked && answerLock?.key === option.key;
        return <button
          key={option.key}
          type="button"
          disabled={chooseLocked}
          className={`flex min-h-11 w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm tap-scale ${answerBusy ? "border-accent bg-accent/10" : "border-border"} ${chooseLocked && !answerBusy ? "opacity-50" : ""}`}
          onClick={() => {
            const token = choose.expected.token;
            const attempt = ++answerAttempt.current;
            setAnswerLock({ token, key: option.key, attempt });
            answerDialog(agent.id, token, option.key, (outcome) => {
              if (outcome.state !== "failed") return;
              setAnswerLock((lock) => (lock?.attempt === attempt ? null : lock));
            });
          }}
        >
          <span className="shrink-0 rounded-md border border-border px-1.5 font-mono text-xs text-subtle">{option.key}</span>
          <span className="min-w-0 flex-1 break-words">{option.label}</span>
          {answerBusy && <LoaderCircle className="size-4 shrink-0 animate-spin text-accent" aria-hidden="true" />}
        </button>;
      })}</div> : null}
      {choose ? <p className="mt-1 text-xs text-subtle">This dialog owns the keyboard. Pick an option or answer in Terminal.</p> : null}
      <button type="button" className={`mt-1 py-1 ${choose ? "text-xs text-muted" : "font-medium text-accent"}`} onClick={() => setDetailView("terminal")}>Answer in Terminal</button>
    </div>}
      {showBlockedReplyKeys && <div role="group" aria-label="Blocked reply controls" className="mb-2 flex items-center gap-2 rounded-lg border border-accent/30 bg-accent/5 px-3 py-2 text-sm">
      <span className="min-w-0 flex-1 text-subtle">Typed without submitting.</span>
      <button type="button" className="rounded-md border border-border bg-bg px-3 py-1.5 font-medium tap-scale" onClick={() => void sendKeys(agent.id, "enter")}>Enter</button>
      <button type="button" className="rounded-md border border-border bg-bg px-3 py-1.5 font-medium tap-scale" onClick={() => void sendKeys(agent.id, "esc")}>Esc</button>
    </div>}
      {terminal && quickRepliesSlot && createPortal(
        <>
          {/* Types the prefix into the input, which opens the command list
              above it: the same list typing / opens, so tap or search. */}
          {buttonPrefix && <button
            type="button"
            aria-label={insertLabel}
            title="Agent commands"
            disabled={busy}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => insertCommandPrefix()}
            className="flex size-9 shrink-0 items-center justify-center rounded-sm font-mono text-sm text-muted shadow-border disabled:opacity-50"
          >{buttonPrefix === "/skill:" ? "/s" : buttonPrefix}</button>}
          {quickReplies.length > 0 && <QuickRepliesMenu
            replies={quickReplies}
            disabled={unavailable || busy || !canSend}
            onPick={(reply) => void submit("terminal", reply.text)}
          />}
        </>,
        quickRepliesSlot,
      )}
      {quickReplies.length > 0 && !(terminal && quickRepliesSlot) && <details className="quick-replies group mb-2 overflow-hidden rounded-xl border border-border bg-surface/40">
      <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-xs font-medium text-muted">
        <span className="flex items-center gap-2"><Slash className="size-3.5" aria-hidden="true" />Quick replies</span>
        <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" aria-hidden="true" />
      </summary>
      <section aria-label="Quick replies" className="border-t border-border p-2">
      <div className="quick-replies-list flex flex-wrap gap-2">
        {quickReplies.map((reply) => <button
          key={reply.id}
          type="button"
          disabled={unavailable || busy || !canSend}
          className="min-h-10 rounded-lg border border-border bg-bg px-3 py-2 text-left text-sm tap-scale disabled:opacity-50"
          onClick={() => void submit(terminal ? "terminal" : selectedMode, reply.text)}
        >{reply.label}</button>)}
      </div>
      </section>
    </details>}
      {listVisible && <div className="mb-1 overflow-hidden rounded-t-2xl border border-border-strong bg-bg">
      <div className="flex items-center justify-between px-3 pt-2">
        <p className="text-xs text-muted">{catalog?.coverage === "partial" ? "Commands · may be incomplete" : catalog?.coverage === "unsupported" ? "Commands · discovery unavailable" : "Commands"}</p>
        <button type="button" aria-label="Dismiss suggestions" className="p-2 text-muted" onClick={() => setDismissedToken(tokenString ?? "")}><X className="size-4" /></button>
      </div>
      <ul ref={optionList} id={listId} role="listbox" aria-label="Command suggestions" className="max-h-36 overflow-y-auto p-1">
        {shown.map((command, index) => <li key={command.invocation} role="presentation">
          <button type="button" id={`${listId}-${index}`} role="option" aria-selected={index === selectedIndex} aria-label={`${command.invocation}${command.description ? `: ${command.description}` : ""}`}
            onPointerDown={() => {
              if (!activeToken) return;
              gesture.current = { key: discoveryKey, revision: draft.revision, start: activeToken.start, end: activeToken.end, token: tokenString ?? "", invocation: command.invocation };
            }}
            // A pointer click carries detail >= 1; Enter or Space on the
            // focused button fires click with detail 0, which takes the live
            // token/revision path instead of the pointerdown capture.
            onClick={(e) => chooseCommand(command, e.detail !== 0)} className={`block w-full min-h-11 rounded-lg px-3 py-2 text-left ${index === selectedIndex ? "bg-surface" : ""}`}>
            <span className="font-medium">{command.invocation}</span>
            {command.origin === "built-in" && <span className="ml-2 text-2xs uppercase tracking-[0.12em] text-subtle">built-in</span>}
            {command.description && <span className="block truncate text-xs text-muted">{command.description}</span>}
          </button>
        </li>)}
      </ul>
    </div>}
      {noMatch && <p role="status" className="mb-1 px-3 text-xs text-muted">No matching commands.</p>}
      {discoveryNote && liveDiscovery && (
        <p role="status" className="mb-1 flex items-center gap-2 px-3 text-xs text-muted">
          <span className="min-w-0 flex-1">{discoveryNote}</span>
          {liveDiscovery.status === "failed" && (
            <button type="button" className="shrink-0 rounded-md border border-border bg-bg px-2 py-1 text-xs font-medium tap-scale" onClick={() => setRefresh((n) => n + 1)}>Retry</button>
          )}
        </p>
      )}
    </div>
    <div className={`composer-panel shrink-0 rounded-2xl border bg-bg p-2 focus-within:border-accent/70 ${dragging ? "border-accent ring-2 ring-accent/20" : "border-border-strong"}`}>
      {dragging && <p className="p-2 text-sm text-accent">Drop a file here</p>}
      {draft.attachment && <div className="composer-attachment mb-1 flex items-center gap-2 rounded-lg bg-surface p-2">
        {preview && <img src={preview} alt={`Attachment preview: ${draft.attachment.name}`} className="size-10 rounded object-cover" />}
        <span className="min-w-0 flex-1 truncate text-xs">{draft.attachment.name}</span>
        <button type="button" aria-label="Remove image" className="p-2" onClick={() => saved.update({ attachment: null })}><X className="size-4" /></button>
      </div>}
      {draft.comments.length > 0 && <ReviewCommentsChip
        comments={draft.comments}
        locked={busy}
        onRemove={(id) => saved.editComments((now) => now.filter((comment) => comment.id !== id))}
        onClear={() => saved.editComments(() => [])}
        onOpenChanges={onOpenChanges}
      />}
      <textarea ref={textarea} rows={1} aria-label={terminal ? "Terminal input" : "Message agent"}
        aria-autocomplete={listVisible ? "list" : undefined} aria-controls={listVisible ? listId : undefined}
        aria-activedescendant={listVisible && selected ? `${listId}-${selectedIndex}` : undefined}
        value={draft.text} onChange={(e) => { saved.update({ text: e.target.value }); setCaret(e.currentTarget.selectionStart ?? e.currentTarget.value.length); }} onSelect={(e) => {
          setCaret(e.currentTarget.selectionStart ?? 0);
        }} onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)} autoCapitalize={terminal ? "off" : "sentences"} autoCorrect={terminal ? "off" : "on"} spellCheck={!terminal}
        onKeyDown={(event) => {
          const composing = event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
          if (listVisible && !composing) {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActiveIndex((i) => Math.min(i + 1, shown.length - 1));
              return;
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setActiveIndex((i) => Math.max(i - 1, 0));
              return;
            }
            if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
              event.preventDefault();
              if (selected) chooseCommand(selected, false);
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setDismissedToken(tokenString ?? "");
              return;
            }
          }
          if (event.key === "Enter" && !event.shiftKey && !composing) {
            event.preventDefault();
            void submit();
          }
        }}
        placeholder={terminal ? "Type or dictate terminal input" : "Message this agent…"}
        className="block max-h-40 min-h-10 w-full resize-none bg-transparent px-2 py-2 text-base leading-6 outline-none placeholder:text-subtle" />
      <div className="flex items-center gap-1">
        <input ref={file} type="file" hidden onChange={(e) => { pickFile(e.target.files?.[0]); e.target.value = ""; }} />
        <button ref={attach} type="button" aria-label="Attach file" disabled={busy} onClick={() => file.current?.click()} className="flex size-10 items-center justify-center rounded-lg text-muted disabled:opacity-50"><Paperclip className="size-4" /></button>
        {!terminal && buttonPrefix && <button type="button" aria-label={insertLabel} onClick={() => insertCommandPrefix()} disabled={busy} className="flex size-10 items-center justify-center rounded-lg text-muted"><Slash className="size-4" /></button>}
        <button type="button" aria-label={listening ? "Stop listening" : "Dictate"} aria-pressed={listening} onClick={dictate} disabled={busy} className={`flex size-10 items-center justify-center rounded-lg ${listening ? "text-blocked" : "text-muted"}`}><Mic className="size-4" /></button>
        <details ref={tools} className="relative">
          <summary aria-label="Input tools" onMouseDown={(event) => event.preventDefault()} className="flex size-10 cursor-pointer list-none items-center justify-center text-muted"><Keyboard className="size-4" /></summary>
          <div className="absolute bottom-12 left-0 z-20 w-64 rounded-xl border border-border bg-bg p-3 shadow-lg">
            <div className="mb-1 flex items-center justify-between">
              <p className="text-xs text-muted">Input tools</p>
              <button type="button" aria-label="Close input tools" className="p-2 text-muted" onClick={() => { if (tools.current) tools.current.open = false; }}><X className="size-4" /></button>
            </div>
            <div className="flex flex-wrap gap-1">{["esc", "tab", "shift+tab", "enter", "ctrl+c", "up", "down"].map((key) => <button type="button" key={key} disabled={unavailable} onClick={() => sendKeys(agent.id, key)} className="rounded bg-surface px-3 py-2 font-mono text-xs">{key}</button>)}</div>
            <button type="button" onClick={() => { saved.discard(); }} className="mt-2 block py-2 text-sm text-muted">Discard draft</button>
            <button type="button" onClick={() => void listDrafts().then(setRecovered)} className="block py-2 text-sm text-muted">Recover saved drafts</button>
            {recovered.filter((item) => JSON.stringify(item.key) !== JSON.stringify(draftKey)).map((item) => <button key={JSON.stringify(item.key)} type="button" disabled={Boolean(draft.text || draft.attachment || draft.comments.length)} title="Empty or discard the current draft before restoring another" onClick={() => { saved.update({ text: item.draft.text, attachment: item.draft.attachment, comments: item.draft.comments }); setRecovered([]); }} className="block w-full truncate rounded py-2 text-left text-xs disabled:opacity-50">{item.key[0]} · {item.draft.text.slice(0, 70) || item.draft.attachment?.name || reviewCommentLabel(item.draft.comments.length)}</button>)}
          </div>
        </details>
        <details ref={picker} className="relative" onToggle={(event) => { if (!(event.currentTarget as HTMLDetailsElement).open) snippetSel.current = null; }}>
          <summary aria-label="Snippets" onMouseDown={(event) => event.preventDefault()} onClick={captureSelection} className="flex size-10 cursor-pointer list-none items-center justify-center text-muted"><BookMarked className="size-4" /></summary>
          <div className="absolute bottom-12 left-1/2 -translate-x-1/2 z-20 w-64 rounded-xl border border-border bg-bg p-3 shadow-lg">
            <div className="mb-1 flex items-center justify-between">
              <p className="text-xs text-muted">Snippets</p>
              <button type="button" aria-label="Close snippets" className="p-2 text-muted" onClick={() => { if (picker.current) picker.current.open = false; }}><X className="size-4" /></button>
            </div>
            <form onSubmit={(event) => { event.preventDefault(); saveSnippetForm(); }}>
              <div className="flex gap-1">
                <input aria-label="Snippet name" value={snippetName} onChange={(event) => { setSnippetName(event.target.value); setSnippetFormError(null); }} placeholder="Name" className="min-w-0 flex-1 rounded bg-surface px-2 py-2 text-xs outline-none" />
                <button type="submit" aria-label={snippetEditingId ? "Update snippet" : "Save snippet"} disabled={busy} className="rounded bg-accent px-3 py-2 text-xs text-bg disabled:opacity-40">{snippetEditingId ? "Update" : "Save"}</button>
                {snippetEditingId && <button type="button" aria-label="Cancel edit" onClick={resetSnippetForm} className="rounded bg-surface px-2 py-2 text-xs text-muted">Cancel</button>}
              </div>
              <textarea aria-label="Snippet text" value={snippetText} onChange={(event) => { setSnippetText(event.target.value); setSnippetFormError(null); }} placeholder="Prompt text" className="mt-1 h-16 w-full resize-none rounded bg-surface p-2 text-xs outline-none" />
              {snippetFormError && <p role="alert" className="mt-1 text-xs text-blocked">{snippetFormError}</p>}
              <p className="mt-1 text-[10px] text-subtle">Inserts into your draft without sending.</p>
            </form>
            <div className="mt-2 max-h-48 overflow-y-auto">
              {snippets.length === 0 && <p className="py-2 text-xs text-subtle">No snippets yet. Save the current text above.</p>}
              {snippets.map((snippet) => <div key={snippet.id} className="flex items-center gap-1">
                <button type="button" aria-label={`Insert snippet ${snippet.name}`} disabled={busy} onClick={() => insertSnippet(snippet)} className="min-w-0 flex-1 truncate rounded py-2 pr-1 text-left text-xs">{snippet.name}</button>
                <button type="button" aria-label={`Edit snippet ${snippet.name}`} onClick={() => editSnippet(snippet)} className="p-2 text-muted"><Pencil className="size-3.5" /></button>
                <button type="button" aria-label={`Delete snippet ${snippet.name}`} onClick={() => { deleteSnippet(snippet.id); if (snippetEditingId === snippet.id) resetSnippetForm(); }} className="p-2 text-muted"><Trash2 className="size-3.5" /></button>
              </div>)}
            </div>
          </div>
        </details>
        {capabilities.stop && agent.status === "working" && <button type="button" aria-label="Stop agent" onClick={() => void submit("stop")} disabled={busy || unavailable} className="flex size-10 items-center justify-center rounded-lg text-muted"><Square className="size-4" /></button>}
        <div className="ml-auto flex items-center gap-1">
          {!terminal && modes.length > 1 && <label className="flex items-center text-xs text-muted"><select aria-label="Send mode" value={selectedMode} onChange={(e) => { const value = e.target.value; if (value === "send" || value === "steer" || value === "queue") setInputMode(value); }} className="max-w-32 appearance-none bg-transparent py-2 pl-2 text-xs">{modes.map((value) => <option key={value} value={value}>{value === "send" ? "Native Enter" : value === "steer" ? "Steer" : "Queue"}</option>)}</select><ChevronDown className="size-3" /></label>}
          <button type="button" aria-label="Send" disabled={unavailable || busy || !canSend || ownsKeyboard} onMouseDown={(event) => event.preventDefault()} onClick={() => void submit()} className="flex size-10 items-center justify-center rounded-full bg-accent text-bg disabled:opacity-40">{busy ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowUp className="size-5" />}</button>
        </div>
      </div>
    </div>
    <ContextMeter context={context} reserve={!terminal && hasContextMeter(agent.kind)} />
    {(draft.submission || unavailable) && <div className="mt-1 flex shrink-0 items-center gap-2 px-2 text-xs text-muted">
      <p role="status" className="min-w-0 flex-1">{(busy ? "Sending…" : draft.submission?.message) || (unavailable ? "Reconnect to send. Your draft stays on this device." : "")}</p>
      {/* Delivered is not done: a command may have opened a menu in the pane,
          and this is where the thumb already is. */}
      {!terminal && nativePane && !nativePane.open && draft.submission?.state === "delivered" && <button type="button" onClick={nativePane.onToggle} className="-my-2 shrink-0 py-2 font-medium text-accent">Show pane</button>}
    </div>}
    {saved.error && <p role="status" className="mt-1 shrink-0 px-2 text-xs text-muted">{saved.error}</p>}
    {stored && <div className="composer-file-note mt-1 flex shrink-0 items-start gap-1 px-2 text-xs text-muted">
      <p role="status" className="min-w-0 flex-1 py-2">
        Copied {stored.name} ({formatBytes(stored.size)}) to the host. It stays there after this session: <span className="break-all font-mono">{stored.path}</span>
      </p>
      <button type="button" aria-label="Dismiss file note" className="-mr-1 shrink-0 p-2" onClick={() => setStored(null)}><X className="size-4" /></button>
    </div>}
    <FileSendDialog
      file={offer}
      upload={copyFile}
      onUploaded={filePlaced}
      onClose={() => { setOffer(null); fileSel.current = null; }}
      restoreFocus={afterFileDialog}
    />
  </div>;
}
