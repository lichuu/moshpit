import * as Dialog from "@radix-ui/react-dialog";
import { ChevronRight, FileDiff, LoaderCircle, MessageSquareText, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { CommentCard, CommentEditor, StaleComments } from "@/components/moshpit/diff-comments";
import { bridgeUrl } from "@/lib/moshpit/bridge";
import {
  branchLabel,
  diffPlaces,
  fetchChanges,
  lineSite,
  missingFiles,
  omissionText,
  openByDefault,
  parseFileDiff,
  patchOf,
  STATUS_LABEL,
  STATUS_LETTER,
  summarize,
  type ChangedFile,
  type Changes,
  type Checkout,
  type DiffLine,
} from "@/lib/moshpit/changes";
import { demoChanges } from "@/lib/moshpit/changes-demo";
import { draftSessionId, type DraftKey } from "@/lib/moshpit/drafts";
import { projectOf } from "@/lib/moshpit/label";
import { commentPlace, reviewCommentLabel, type ReviewComment } from "@/lib/moshpit/review-comments";
import { useMoshpitStore } from "@/lib/moshpit/store";
import { ReviewContext, useReview, useReviewState } from "@/lib/moshpit/use-review";
import type { Agent } from "@/lib/moshpit/types";
import { cn } from "@/lib/utils";

type Load =
  | { phase: "loading" }
  | { phase: "ready"; changes: Changes; refreshing: boolean }
  | { phase: "error"; message: string };

/** Lines of one file drawn at a time. A longer diff offers the rest on request. */
const LINES_PER_STEP = 2000;
/** Names listed in the "left out" note before it says "and N more". */
const NAMED_IN_NOTE = 5;

function describeFailure(error: unknown) {
  if (error instanceof TypeError) return "Could not reach the bridge. Check the connection and try again.";
  return error instanceof Error && error.message ? error.message : "The changes could not be read.";
}

/**
 * One read of the checkout: on open, and again on Refresh. No timer and no
 * watcher; a refresh keeps the last answer on screen until the next arrives.
 */
function useChanges(url: string, agent: Agent, demo: boolean) {
  const [state, setState] = useState<Load>({ phase: "loading" });
  const running = useRef<AbortController | null>(null);
  const { id, cwd, branch } = agent;

  const load = useCallback(() => {
    running.current?.abort();
    const controller = new AbortController();
    running.current = controller;
    setState((held) => (held.phase === "ready" ? { ...held, refreshing: true } : { phase: "loading" }));
    const answer = demo ? Promise.resolve<Changes>(demoChanges(projectOf(cwd) || "demo", branch)) : fetchChanges(url, id, controller.signal);
    answer.then(
      (changes) => {
        if (!controller.signal.aborted) setState({ phase: "ready", changes, refreshing: false });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setState({ phase: "error", message: describeFailure(error) });
      },
    );
  }, [url, id, cwd, branch, demo]);

  useEffect(() => {
    load();
    return () => running.current?.abort();
  }, [load]);

  return { state, load };
}

function Counts({ file }: { file: ChangedFile }) {
  if (file.added === null && file.deleted === null) return null;
  return (
    <span className="shrink-0 font-mono text-xs leading-5 tabular-nums" aria-hidden="true">
      <span className="text-working">+{file.added ?? 0}</span> <span className="text-red-500">&minus;{file.deleted ?? 0}</span>
    </span>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-2xs text-muted">{children}</span>;
}

function fileName(file: ChangedFile, comments: number) {
  const status = STATUS_LABEL[file.status] ?? file.status;
  const parts = [file.path, status];
  if (file.previousPath) parts.push(`from ${file.previousPath}`);
  if (file.untracked) parts.push("untracked");
  if (file.binary) parts.push("binary");
  if (file.added !== null || file.deleted !== null) parts.push(`${file.added ?? 0} added, ${file.deleted ?? 0} removed`);
  const why = omissionText(file);
  if (why) parts.push(why.toLowerCase());
  if (comments) parts.push(reviewCommentLabel(comments));
  return parts.join(", ");
}

const LINE_KIND = { add: "Added", del: "Removed", ctx: "Unchanged" } as const;

function Note({ children }: { children: React.ReactNode }) {
  return <p className="border-t border-border px-3 py-3 text-xs text-muted">{children}</p>;
}

/**
 * One numbered line of a diff. It is a button: tapping or pressing Enter opens
 * a comment editor under it, and a saved comment shows there. The row is the
 * target, so it does not need a precise tap; a horizontal drag still pans the
 * diff and never counts as a tap.
 */
function LineWithComment({
  file,
  line,
  tabStop,
  onArrow,
  onFocus,
  onFinish,
}: {
  file: ChangedFile;
  line: Extract<DiffLine, { number: number }>;
  tabStop: string | null;
  onArrow: (event: React.KeyboardEvent<HTMLElement>) => void;
  onFocus: (place: string) => void;
  onFinish: (place: string) => void;
}) {
  const review = useReview();
  const site = lineSite(file, line);
  const place = commentPlace(site);
  const comment = review.byPlace.get(place);
  return (
    <>
      <button
        type="button"
        data-line={place}
        tabIndex={place === tabStop ? 0 : -1}
        aria-label={`${LINE_KIND[line.kind]} line ${line.number}: ${line.text}${comment ? ", has a comment" : ""}`}
        onFocus={() => onFocus(place)}
        onKeyDown={onArrow}
        onClick={() => {
          if (review.writable) review.begin(place);
        }}
        className={cn(
          "flex w-full border-l-2 text-left outline-offset-[-2px] pointer-coarse:min-h-10 pointer-coarse:items-center",
          comment ? "border-accent" : "border-transparent",
          line.kind === "add" && "bg-working/10",
          line.kind === "del" && "bg-red-500/10",
        )}
      >
        <span aria-hidden="true" className="relative w-11 shrink-0 select-none pr-2 text-right tabular-nums text-subtle">
          {comment ? <MessageSquareText className="absolute left-1 top-1 size-3 text-accent" /> : null}
          {line.number}
        </span>
        {/* The sign is text, so a change reads without its colour. */}
        <span className={cn("w-4 shrink-0 select-none text-center", line.kind === "add" && "text-working", line.kind === "del" && "text-red-500")}>
          {line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}
        </span>
        <span className="whitespace-pre pr-3">{line.text || " "}</span>
      </button>
      {review.editing === place ? (
        <CommentEditor
          site={site}
          initial={comment?.text ?? ""}
          full={review.atLimit && !comment}
          onSave={(text) => {
            review.save(site, text);
            onFinish(place);
          }}
          onCancel={() => onFinish(place)}
        />
      ) : comment ? (
        <CommentCard
          comment={comment}
          writable={review.writable}
          onEdit={() => review.begin(place)}
          onRemove={() => {
            review.remove(comment.id);
            onFinish(place);
          }}
        />
      ) : null}
    </>
  );
}

/** One file's diff in mono type. Only an open file builds its lines, so a long list stays light. */
function DiffView({ changes, file }: { changes: Checkout; file: ChangedFile }) {
  const review = useReview();
  const [limit, setLimit] = useState(LINES_PER_STEP);
  // One line is a tab stop at a time; the arrow keys move between lines, so a
  // long diff is one stop in the sheet's tab order, not thousands.
  const [focused, setFocused] = useState<string | null>(null);
  const group = useRef<HTMLDivElement>(null);
  const text = patchOf(changes, file);
  const diff = useMemo(() => parseFileDiff(text), [text]);
  const why = omissionText(file);
  if (why) return <Note>{why}.</Note>;
  if (!file.patch) return <Note>There is no text to show for this file.</Note>;
  if (file.binary) return <Note>Binary file: its content is not shown.</Note>;

  let budget = limit;
  let hidden = 0;
  const hunks = diff.hunks.map((hunk) => {
    const shown = hunk.lines.slice(0, Math.max(0, budget));
    budget -= shown.length;
    hidden += hunk.lines.length - shown.length;
    return { hunk, shown };
  });
  const places = new Set<string>();
  for (const { shown } of hunks) for (const line of shown) if (line.kind !== "note") places.add(commentPlace(lineSite(file, line)));
  const tabStop = focused !== null && places.has(focused) ? focused : (places.values().next().value ?? null);
  const arrow = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const all = [...(group.current?.querySelectorAll<HTMLElement>("[data-line]") ?? [])];
    const next = all[all.indexOf(event.currentTarget) + (event.key === "ArrowDown" ? 1 : -1)];
    if (!next) return;
    event.preventDefault();
    next.focus();
  };
  const finish = (place: string) => {
    review.finish();
    group.current?.querySelector<HTMLElement>(`[data-line="${CSS.escape(place)}"]`)?.focus();
  };

  return (
    <div className="border-t border-border">
      {/* The scroll region is focusable so a keyboard can pan a long line. It is
          a container, so a comment under a line can be as wide as this window. */}
      <div
        ref={group}
        role="group"
        aria-label={`Diff of ${file.path}`}
        tabIndex={0}
        className="@container overflow-x-auto bg-bg-term font-mono text-xs leading-5 outline-offset-[-2px]"
      >
        <div className="w-max min-w-full">
          {diff.meta.map((line, index) => (
            <div key={index} className="whitespace-pre px-3 py-0.5 text-subtle">
              {line}
            </div>
          ))}
          {diff.hunks.length === 0 && diff.meta.length === 0 ? <div className="px-3 py-1 text-subtle">No line changes.</div> : null}
          {hunks.map(({ hunk, shown }, index) => (
            <div key={index}>
              <div className="whitespace-pre bg-surface-2 px-3 py-0.5 text-subtle">{hunk.header}</div>
              {shown.map((line, at) =>
                line.kind === "note" ? (
                  <div key={at} className="whitespace-pre py-0.5 pl-[3.75rem] pr-3 italic text-subtle">
                    {line.text}
                  </div>
                ) : (
                  <LineWithComment key={at} file={file} line={line} tabStop={tabStop} onArrow={arrow} onFocus={setFocused} onFinish={finish} />
                ),
              )}
            </div>
          ))}
        </div>
      </div>
      {hidden > 0 ? (
        <button
          type="button"
          onClick={() => setLimit((now) => now + LINES_PER_STEP)}
          className="flex h-11 w-full items-center justify-center border-t border-border text-xs font-medium text-accent"
        >
          Show {Math.min(hidden, LINES_PER_STEP).toLocaleString()} more lines ({hidden.toLocaleString()} not shown)
        </button>
      ) : null}
    </div>
  );
}

function FileRow({ changes, file, open, comments, onToggle }: { changes: Checkout; file: ChangedFile; open: boolean; comments: number; onToggle: () => void }) {
  const panel = useId();
  const letter = STATUS_LETTER[file.status] ?? "?";
  return (
    <li className="overflow-hidden rounded-lg border border-border bg-surface">
      <button
        type="button"
        aria-label={fileName(file, comments)}
        aria-expanded={open}
        aria-controls={open ? panel : undefined}
        onClick={onToggle}
        className="flex min-h-11 w-full items-start gap-2 px-3 py-2.5 text-left"
      >
        <ChevronRight aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0 text-muted", open && "rotate-90")} />
        <span
          aria-hidden="true"
          title={STATUS_LABEL[file.status] ?? file.status}
          className={cn(
            "mt-px flex size-5 shrink-0 items-center justify-center rounded-md border border-border-strong font-mono text-2xs font-medium",
            file.status === "added" && "text-working",
            file.status === "deleted" && "text-red-500",
            file.status !== "added" && file.status !== "deleted" && "text-muted",
          )}
        >
          {letter}
        </span>
        <span aria-hidden="true" className="min-w-0 flex-1">
          <span className="block break-all font-mono text-xs leading-5">{file.path}</span>
          {file.previousPath ? <span className="block break-all font-mono text-2xs text-subtle">from {file.previousPath}</span> : null}
          {comments || file.untracked || file.binary || file.omitted ? (
            <span className="mt-1 flex flex-wrap gap-1">
              {comments ? <Tag>{reviewCommentLabel(comments)}</Tag> : null}
              {file.untracked ? <Tag>untracked</Tag> : null}
              {file.binary ? <Tag>binary</Tag> : null}
              {file.omitted ? <Tag>not shown</Tag> : null}
            </span>
          ) : null}
        </span>
        <Counts file={file} />
      </button>
      {open ? (
        <div id={panel}>
          <DiffView changes={changes} file={file} />
        </div>
      ) : null}
    </li>
  );
}

function TruncationNote({ changes }: { changes: Checkout }) {
  const missing = missingFiles(changes);
  const unlisted = Math.max(0, changes.fileCount - changes.files.length);
  const named = missing.slice(0, NAMED_IN_NOTE).map((file) => file.path);
  const more = missing.length - named.length;
  return (
    <div role="note" className="rounded-lg border border-blocked/40 bg-blocked/10 px-3 py-2.5 text-xs leading-5">
      <p className="font-medium">This diff was cut.</p>
      {named.length ? (
        <p className="mt-0.5 break-words text-muted">
          Not shown: {named.join(", ")}
          {more > 0 ? ` and ${more} more` : ""}.
        </p>
      ) : null}
      {unlisted > 0 ? <p className="mt-0.5 text-muted">{unlisted.toLocaleString()} more changed files are not listed.</p> : null}
    </div>
  );
}

function CheckoutView({ changes }: { changes: Checkout }) {
  const review = useReview();
  const defaults = useMemo(() => openByDefault(changes), [changes]);
  const [chosen, setChosen] = useState<Map<string, boolean>>(() => new Map());
  const total = summarize(changes);
  // Comments are matched to the diff as it stands, never moved: one whose line
  // is gone is listed apart instead of being dropped or guessed at.
  const staged = review.comments.length > 0;
  const places = useMemo(() => (staged ? diffPlaces(changes) : new Map<string, string>()), [changes, staged]);
  const stale: ReviewComment[] = [];
  const perFile = new Map<string, number>();
  for (const comment of review.comments) {
    const place = commentPlace(comment);
    const owner = places.get(place);
    if (owner === undefined || review.byPlace.get(place) !== comment) stale.push(comment);
    else perFile.set(owner, (perFile.get(owner) ?? 0) + 1);
  }
  const notInDiff = <StaleComments comments={stale} writable={review.writable} onRemove={review.remove} />;
  if (changes.files.length === 0) {
    return (
      <>
        <Message title="No changes" tone="empty">
          This checkout matches its last commit.
        </Message>
        {stale.length ? <div className="px-4 pb-4">{notInDiff}</div> : null}
      </>
    );
  }
  return (
    <div className="space-y-3 px-4 py-3">
      <p className="text-sm">
        <span className="font-medium">
          {total.files.toLocaleString()} {total.files === 1 ? "file" : "files"} changed
        </span>{" "}
        <span className="font-mono text-xs tabular-nums">
          <span className="text-working">+{total.added.toLocaleString()}</span> <span className="text-red-500">&minus;{total.deleted.toLocaleString()}</span>
        </span>
      </p>
      {changes.truncated ? <TruncationNote changes={changes} /> : null}
      {notInDiff}
      <ul className="space-y-2">
        {changes.files.map((file) => (
          <FileRow
            key={file.path}
            changes={changes}
            file={file}
            open={chosen.get(file.path) ?? defaults.has(file.path)}
            comments={perFile.get(file.path) ?? 0}
            onToggle={() =>
              setChosen((held) => {
                const next = new Map(held);
                next.set(file.path, !(held.get(file.path) ?? defaults.has(file.path)));
                return next;
              })
            }
          />
        ))}
      </ul>
    </div>
  );
}

function Message({
  title,
  tone,
  children,
  action,
}: {
  title: string;
  tone: "empty" | "error";
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div role={tone === "error" ? "alert" : "status"} className="flex flex-col items-center px-8 py-16 text-center">
      <FileDiff aria-hidden="true" className="size-8 text-subtle" strokeWidth={1.5} />
      <p className="mt-3 text-base font-medium">{title}</p>
      <p className="mt-1 max-w-sm break-words text-sm text-muted">{children}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

const headerButton = "flex h-11 shrink-0 items-center justify-center rounded-md text-muted shadow-border tap-scale";

function Body({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const host = useMoshpitStore((s) => s.hosts.find((h) => h.id === s.connectedHostId));
  const herdrRunning = useMoshpitStore((s) => s.herdrRunning);
  const demo = Boolean(host?.demo);
  const url = host && !host.demo && herdrRunning ? bridgeUrl(host) : "";
  const { state, load } = useChanges(url, agent, demo);
  const refreshing = state.phase === "loading" || (state.phase === "ready" && state.refreshing);
  const checkout = state.phase === "ready" && state.changes.kind === "checkout" ? state.changes : undefined;
  // The agent's draft, where the composer keeps its text and its comments.
  const hostId = useMoshpitStore((s) => s.connectedHostId) ?? "disconnected";
  const draftKey: DraftKey = [hostId, draftSessionId(agent, demo), "conversation"];
  const review = useReviewState(draftKey);

  return (
    <ReviewContext.Provider value={review}>
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 pb-3 pt-[max(1rem,env(safe-area-inset-top))] lg:pt-4">
        <div className="min-w-0 flex-1">
          <Dialog.Title className="text-lg font-medium leading-tight tracking-tight">Changes</Dialog.Title>
          <Dialog.Description className="mt-0.5 truncate text-xs text-muted">
            {checkout ? `${checkout.repo} on ${branchLabel(checkout)}` : `Compared with the last commit in ${projectOf(agent.cwd) || "this checkout"}`}
          </Dialog.Description>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={refreshing}
          aria-label={refreshing ? "Refreshing changes" : "Refresh changes"}
          className={cn(headerButton, "gap-1.5 px-3 text-sm font-medium disabled:opacity-60")}
        >
          {refreshing ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : <RefreshCw aria-hidden="true" className="size-4" />}
          Refresh
        </button>
        <button type="button" aria-label="Close changes" onClick={onClose} className={cn(headerButton, "w-11")}>
          <X aria-hidden="true" className="size-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-safe">
        {state.phase === "loading" ? (
          <p role="status" className="flex items-center justify-center gap-2 px-8 py-16 text-sm text-muted">
            <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> Reading changes…
          </p>
        ) : state.phase === "error" ? (
          <Message
            tone="error"
            title="Could not read the changes"
            action={
              <button type="button" onClick={load} className="flex h-11 items-center justify-center rounded-md px-4 text-sm font-medium text-fg shadow-border tap-scale">
                Retry
              </button>
            }
          >
            {state.message}
          </Message>
        ) : state.changes.kind === "not-a-checkout" ? (
          <>
            <Message tone="empty" title="Not a git checkout">
              This pane's directory is not inside a git repository, so there is nothing to compare.
            </Message>
            <div className="px-4 pb-4">
              <StaleComments comments={review.comments} writable={review.writable} onRemove={review.remove} />
            </div>
          </>
        ) : (
          <CheckoutView changes={state.changes} />
        )}
      </div>
    </ReviewContext.Provider>
  );
}

/**
 * What this agent has changed in its checkout: a read-only view of the diff
 * since the last commit, read when the sheet opens and again on Refresh. Full
 * height on a phone, a panel from the right on a wide screen.
 */
export function ChangesSheet({
  open,
  agent,
  onClose,
  restoreFocus,
}: {
  open: boolean;
  agent: Agent;
  onClose: () => void;
  /** The control that opened the sheet, to refocus when it closes. */
  restoreFocus: () => HTMLElement | null;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm" />
        <Dialog.Content
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            restoreFocus()?.focus();
          }}
          // Escape in a comment editor cancels the editor, not the sheet.
          onEscapeKeyDown={(event) => {
            if (event.target instanceof Element && event.target.closest("[data-comment-editor]")) event.preventDefault();
          }}
          // Sized like the app itself: while the soft keyboard is up the sheet
          // ends where the keyboard begins, so a comment field is never under it.
          className="fixed inset-x-0 bottom-0 top-[var(--app-top,0px)] z-50 flex h-[var(--app-height,auto)] flex-col bg-bg shadow-xl lg:left-auto lg:w-[min(56rem,calc(100vw-5rem))] lg:border-l lg:border-border"
        >
          <Body key={agent.id} agent={agent} onClose={onClose} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
