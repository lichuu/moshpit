import { MessageSquareText, Pencil, Trash2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { CommentSite } from "@/lib/moshpit/changes";
import { commentLocation, commentProblem, REVIEW_COMMENT_LIMITS, type ReviewComment } from "@/lib/moshpit/review-comments";
import { cn } from "@/lib/utils";

/** What the editor and card sit in: the width of the diff's window, not of its longest line. */
const inline = "sticky left-0 w-[100cqw] whitespace-normal font-sans text-sm";

const smallButton = "flex h-11 items-center gap-1.5 rounded-md px-3 text-xs font-medium disabled:opacity-40";

/** The small form under a line: a text field, Save and Cancel. Escape cancels it and nothing else. */
export function CommentEditor({
  site,
  initial,
  full,
  onSave,
  onCancel,
}: {
  site: CommentSite;
  initial: string;
  /** The staging limit is reached and this line has no comment yet. */
  full: boolean;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const root = useRef<HTMLFormElement>(null);
  const field = useId();
  const problem = commentProblem(text);
  const atEnd = text.length >= REVIEW_COMMENT_LIMITS.text;

  // The soft keyboard covers the lower part of the screen: keep the form in the
  // part that is left, now and each time the visible area changes.
  useEffect(() => {
    const reveal = () => root.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
    reveal();
    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", reveal);
    return () => viewport?.removeEventListener("resize", reveal);
  }, []);

  const label = `Comment on ${commentLocation(site)}`;
  return (
    <form
      ref={root}
      data-comment-editor=""
      className={cn(inline, "scroll-mb-4 space-y-2 border-y border-border-strong bg-surface px-3 py-2")}
      onSubmit={(event) => {
        event.preventDefault();
        if (!problem && !full) onSave(text);
      }}
    >
      <label htmlFor={field} className="block break-all text-xs font-medium text-muted">
        {label}
      </label>
      {full ? (
        <p role="status" className="text-xs text-blocked">
          {REVIEW_COMMENT_LIMITS.count} review comments are staged, which is the limit. Remove one to add another.
        </p>
      ) : (
        <>
          <textarea
            id={field}
            autoFocus
            rows={3}
            maxLength={REVIEW_COMMENT_LIMITS.text}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onCancel();
              } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                if (!problem) onSave(text);
              }
            }}
            className="block w-full resize-none rounded-md border border-border-strong bg-bg px-2 py-2 text-base leading-6 outline-none focus:border-accent/70"
          />
          <p className={cn("text-xs", atEnd ? "text-blocked" : "text-subtle")} role={atEnd ? "status" : undefined}>
            {text.length} of {REVIEW_COMMENT_LIMITS.text} characters{atEnd ? ". That is the limit." : ""}
          </p>
        </>
      )}
      <div className="-mb-1 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className={cn(smallButton, "text-muted shadow-border")}>
          {full ? "Close" : "Cancel"}
        </button>
        {full ? null : (
          <button type="submit" disabled={problem !== null} className={cn(smallButton, "bg-accent text-accent-fg")}>
            Save
          </button>
        )}
      </div>
    </form>
  );
}

/** A saved comment under its line. */
export function CommentCard({ comment, writable, onEdit, onRemove }: { comment: ReviewComment; writable: boolean; onEdit: () => void; onRemove: () => void }) {
  return (
    <div role="group" aria-label={`Comment on ${commentLocation(comment)}`} className={cn(inline, "border-y border-accent/30 bg-accent/5 px-3 py-2")}>
      <p className="flex items-start gap-2">
        <MessageSquareText aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-accent" />
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{comment.text}</span>
      </p>
      <div className="-mb-1 mt-1 flex gap-1 pl-6">
        <button type="button" disabled={!writable} onClick={onEdit} aria-label={`Edit comment on ${commentLocation(comment)}`} className={cn(smallButton, "text-muted")}>
          <Pencil aria-hidden="true" className="size-3.5" />
          Edit
        </button>
        <button type="button" disabled={!writable} onClick={onRemove} aria-label={`Remove comment on ${commentLocation(comment)}`} className={cn(smallButton, "text-muted")}>
          <Trash2 aria-hidden="true" className="size-3.5" />
          Remove
        </button>
      </div>
    </div>
  );
}

/**
 * Staged comments whose line is not in the diff as it stands now: the agent
 * changed the file, or the diff was refreshed. They are kept as written and
 * still go with the next message, so they are listed here rather than hidden.
 */
export function StaleComments({ comments, writable, onRemove }: { comments: readonly ReviewComment[]; writable: boolean; onRemove: (id: string) => void }) {
  if (!comments.length) return null;
  return (
    <section aria-label="Not in the current diff" className="rounded-lg border border-blocked/40 bg-blocked/10 px-3 py-2.5 text-xs leading-5">
      <h3 className="font-medium">Not in the current diff ({comments.length})</h3>
      <p className="mt-0.5 text-muted">The diff as it stands no longer has these lines: the file changed, or the diff was cut. The comments are kept as written and are still sent with your next message.</p>
      <ul className="mt-1">
        {comments.map((comment) => (
          <li key={comment.id} className="flex items-start gap-1 border-t border-blocked/20 py-1 first:border-t-0">
            <div className="min-w-0 flex-1 py-1.5">
              <p className="break-all font-mono text-2xs text-subtle">{commentLocation(comment)}</p>
              <p className="mt-0.5 whitespace-pre-wrap break-words">{comment.text}</p>
            </div>
            <button
              type="button"
              disabled={!writable}
              aria-label={`Remove comment on ${commentLocation(comment)}`}
              onClick={() => onRemove(comment.id)}
              className="flex size-11 shrink-0 items-center justify-center rounded-md text-muted disabled:opacity-40"
            >
              <Trash2 aria-hidden="true" className="size-4" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
