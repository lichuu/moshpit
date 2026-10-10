import { Check, Clock, GitMerge, GitPullRequestClosed, GitPullRequestDraft, X } from "lucide-react";
import type { ComponentType } from "react";
import { pullRequestLabel } from "@/lib/moshpit/pull-request";
import type { PullRequest, PullRequestReadiness } from "@/lib/moshpit/types";
import { cn } from "@/lib/utils";

// Colour is never the only signal: the icon differs per state, and the link's
// name and tooltip say the same thing in words.
const ICON: Record<PullRequestReadiness, ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" }>> = {
  ready: Check,
  pending: Clock,
  blocked: X,
  draft: GitPullRequestDraft,
  merged: GitMerge,
  closed: GitPullRequestClosed,
};

/** The pill itself: `#123` and a state icon, tinted by readiness (see `.pr-pill` in styles.css). */
function Face({ pr, className }: { pr: PullRequest; className?: string }) {
  const Icon = ICON[pr.readiness];
  return (
    <span data-readiness={pr.readiness} className={cn("pr-pill inline-flex h-3.5 shrink-0 items-center gap-1 rounded-md px-1.5 text-2xs font-medium leading-none tabular-nums", className)}>
      <Icon aria-hidden="true" className="size-3 shrink-0" />#{pr.number}
    </span>
  );
}

/**
 * Same size as the real pill and invisible. A card is one button, and a link
 * cannot sit inside a button, so the card reserves this room in its last line
 * (the branch truncates around it) and the real link floats over the spot.
 */
export function PullRequestSlot({ pr, className }: { pr: PullRequest; className?: string }) {
  return (
    <span aria-hidden="true" className={cn("invisible flex", className)}>
      <Face pr={pr} />
    </span>
  );
}

/** The link over a card's last line, at the card's bottom right. A tap lands within 44 px of it. */
export function CardPullRequest({ pr }: { pr: PullRequest }) {
  const label = pullRequestLabel(pr);
  return (
    <a
      href={pr.url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      title={label}
      data-testid="pull-request"
      className="absolute bottom-4 right-4 flex h-4 items-center before:absolute before:-inset-x-2 before:-inset-y-3.5"
    >
      <Face pr={pr} />
    </a>
  );
}

/**
 * The link in a project header's row, a full 44 px tall. The row is a
 * container: under 22rem (the wide layout's list column) the name and path
 * would be squeezed to a few letters, so the pill waits for room. The cards
 * below carry the same pill there.
 */
export function HeaderPullRequest({ pr }: { pr: PullRequest }) {
  const label = pullRequestLabel(pr);
  return (
    <a
      href={pr.url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      title={label}
      data-testid="pull-request"
      className="hidden h-11 shrink-0 items-center rounded-lg px-1 hover:bg-surface @min-[22rem]:flex"
    >
      <Face pr={pr} />
    </a>
  );
}
