import * as Dialog from "@radix-ui/react-dialog";
import { ChevronRight, FileDiff, LoaderCircle, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { bridgeUrl } from "@/lib/moshpit/bridge";
import {
  branchLabel,
  fetchChanges,
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
} from "@/lib/moshpit/changes";
import { demoChanges } from "@/lib/moshpit/changes-demo";
import { projectOf } from "@/lib/moshpit/label";
import { useMoshpitStore } from "@/lib/moshpit/store";
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

function fileName(file: ChangedFile) {
  const status = STATUS_LABEL[file.status] ?? file.status;
  const parts = [file.path, status];
  if (file.previousPath) parts.push(`from ${file.previousPath}`);
  if (file.untracked) parts.push("untracked");
  if (file.binary) parts.push("binary");
  if (file.added !== null || file.deleted !== null) parts.push(`${file.added ?? 0} added, ${file.deleted ?? 0} removed`);
  const why = omissionText(file);
  if (why) parts.push(why.toLowerCase());
  return parts.join(", ");
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="border-t border-border px-3 py-3 text-xs text-muted">{children}</p>;
}

/** One file's diff in mono type. Only an open file builds its lines, so a long list stays light. */
function DiffView({ changes, file }: { changes: Checkout; file: ChangedFile }) {
  const [limit, setLimit] = useState(LINES_PER_STEP);
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

  return (
    <div className="border-t border-border">
      {/* The scroll region is focusable so a keyboard can pan a long line. */}
      <div
        role="group"
        aria-label={`Diff of ${file.path}`}
        tabIndex={0}
        className="overflow-x-auto bg-bg-term font-mono text-xs leading-5 outline-offset-[-2px]"
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
                  <div key={at} className={cn("flex", line.kind === "add" && "bg-working/10", line.kind === "del" && "bg-red-500/10")}>
                    <span aria-hidden="true" className="w-11 shrink-0 select-none pr-2 text-right tabular-nums text-subtle">
                      {line.number}
                    </span>
                    {/* The sign is text, so a change reads without its colour. */}
                    <span
                      className={cn("w-4 shrink-0 select-none text-center", line.kind === "add" && "text-working", line.kind === "del" && "text-red-500")}
                    >
                      {line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}
                    </span>
                    <span className="whitespace-pre pr-3">{line.text || " "}</span>
                  </div>
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

function FileRow({ changes, file, open, onToggle }: { changes: Checkout; file: ChangedFile; open: boolean; onToggle: () => void }) {
  const panel = useId();
  const letter = STATUS_LETTER[file.status] ?? "?";
  return (
    <li className="overflow-hidden rounded-lg border border-border bg-surface">
      <button
        type="button"
        aria-label={fileName(file)}
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
          {file.untracked || file.binary || file.omitted ? (
            <span className="mt-1 flex flex-wrap gap-1">
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
  const defaults = useMemo(() => openByDefault(changes), [changes]);
  const [chosen, setChosen] = useState<Map<string, boolean>>(() => new Map());
  const total = summarize(changes);
  if (changes.files.length === 0) {
    return (
      <Message title="No changes" tone="empty">
        This checkout matches its last commit.
      </Message>
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
      <ul className="space-y-2">
        {changes.files.map((file) => (
          <FileRow
            key={file.path}
            changes={changes}
            file={file}
            open={chosen.get(file.path) ?? defaults.has(file.path)}
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

  return (
    <>
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
          <Message tone="empty" title="Not a git checkout">
            This pane's directory is not inside a git repository, so there is nothing to compare.
          </Message>
        ) : (
          <CheckoutView changes={state.changes} />
        )}
      </div>
    </>
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
          className="fixed inset-0 z-50 flex flex-col bg-bg shadow-xl lg:left-auto lg:w-[min(56rem,calc(100vw-5rem))] lg:border-l lg:border-border"
        >
          <Body key={agent.id} agent={agent} onClose={onClose} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
