import { ChevronDown, FileDiff, MessageSquareText, X } from "lucide-react";
import { useId, useState } from "react";
import { commentLocation, reviewCommentLabel, type ReviewComment } from "@/lib/moshpit/review-comments";
import { cn } from "@/lib/utils";

/**
 * The comments staged with the draft, as one chip above the input. It opens a
 * list where each can be removed and all cleared, and from which the Changes
 * sheet can be reached. They go out with the next message.
 */
export function ReviewCommentsChip({
  comments,
  locked,
  onRemove,
  onClear,
  onOpenChanges,
}: {
  comments: readonly ReviewComment[];
  /** A send is in flight with these comments: they cannot change until it settles. */
  locked: boolean;
  onRemove: (id: string) => void;
  onClear: () => void;
  onOpenChanges?: (returnTo: HTMLElement | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const list = useId();
  return (
    <div className="composer-attachment mb-1 rounded-lg bg-surface">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? list : undefined}
        onClick={() => { setOpen((now) => !now); setConfirming(false); }}
        className="flex min-h-10 w-full items-center gap-2 px-3 text-left text-xs font-medium"
      >
        <MessageSquareText aria-hidden="true" className="size-4 shrink-0 text-accent" />
        <span className="min-w-0 flex-1 truncate">{reviewCommentLabel(comments.length)}</span>
        <ChevronDown aria-hidden="true" className={cn("size-3.5 shrink-0 text-muted", open && "rotate-180")} />
      </button>
      {open ? (
        <div id={list} role="region" aria-label="Review comments" className="border-t border-border">
          <p className="px-3 pt-2 text-2xs text-muted">Sent at the end of your next message.</p>
          <ul className="max-h-40 overflow-y-auto overscroll-contain px-1 py-1">
            {comments.map((comment) => (
              <li key={comment.id} className="flex items-start gap-1 rounded-md px-2 py-1">
                <div className="min-w-0 flex-1 py-1.5">
                  <p className="break-all font-mono text-2xs text-subtle">{commentLocation(comment)}</p>
                  <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap break-words text-xs">{comment.text}</p>
                </div>
                <button
                  type="button"
                  disabled={locked}
                  aria-label={`Remove comment on ${commentLocation(comment)}`}
                  onClick={() => onRemove(comment.id)}
                  className="flex size-10 shrink-0 items-center justify-center rounded-md text-muted disabled:opacity-40"
                >
                  <X aria-hidden="true" className="size-4" />
                </button>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-1 border-t border-border px-1 py-1">
            {onOpenChanges ? (
              <button
                type="button"
                onClick={(event) => onOpenChanges(event.currentTarget)}
                className="flex h-10 items-center gap-1.5 rounded-md px-3 text-xs font-medium text-accent"
              >
                <FileDiff aria-hidden="true" className="size-4" />
                Open Changes
              </button>
            ) : null}
            <button
              type="button"
              disabled={locked}
              onClick={() => {
                if (!confirming) { setConfirming(true); return; }
                setConfirming(false);
                setOpen(false);
                onClear();
              }}
              onBlur={() => setConfirming(false)}
              className={cn("ml-auto flex h-10 items-center rounded-md px-3 text-xs font-medium disabled:opacity-40", confirming ? "bg-blocked/10 text-blocked" : "text-muted")}
            >
              {confirming ? `Clear ${comments.length}? Tap again` : "Clear all"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
