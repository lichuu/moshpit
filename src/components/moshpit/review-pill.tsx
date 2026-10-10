import { ChevronDown, MessageSquareText } from "lucide-react";
import { useId } from "react";
import { commentLocation, reviewCommentLabel, type SentComment } from "@/lib/moshpit/review-comments";
import { cn } from "@/lib/utils";

/**
 * The review comments a sent message ended with, as one pill that opens to the
 * list. The message's own text is shown above it as usual. Search opens the
 * list and takes the toggle away, as it does for a long message.
 */
export function ReviewPill({ comments, expanded, forced, onToggle }: { comments: readonly SentComment[]; expanded: boolean; forced: boolean; onToggle: (open: boolean) => void }) {
  const list = useId();
  const open = expanded || forced;
  const face = (
    <span className="flex items-center gap-1.5 rounded-full border border-border bg-bg px-3 py-1.5 text-xs font-medium text-muted">
      <MessageSquareText aria-hidden="true" className="size-3.5 text-accent" />
      {reviewCommentLabel(comments.length)}
      {forced ? null : <ChevronDown aria-hidden="true" className={cn("size-3.5", open && "rotate-180")} />}
    </span>
  );
  return (
    <div data-review-pill="" className="mt-2">
      {forced ? (
        <div>{face}</div>
      ) : (
        <button type="button" aria-expanded={open} aria-controls={list} onClick={() => onToggle(!open)} className="-ml-1 flex h-11 items-center px-1">
          {face}
        </button>
      )}
      {open ? (
        <ul id={list} aria-label="Review comments" className="mt-1 space-y-2 border-l-2 border-accent/40 pl-3">
          {comments.map((comment, index) => (
            <li key={index} className="min-w-0">
              <p className="break-all font-mono text-2xs text-subtle">{commentLocation(comment)}</p>
              <p className="whitespace-pre-wrap break-words text-sm">{comment.text}</p>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
