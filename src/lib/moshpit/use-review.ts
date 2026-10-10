import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { CommentSite } from "./changes";
import { useDraft, type DraftKey } from "./drafts";
import { newId } from "./events";
import { cleanCommentText, commentPlace, commentProblem, REVIEW_COMMENT_LIMITS, type ReviewComment } from "./review-comments";

// C4: the comments written on this agent's diff lines. They are part of the
// agent's draft, so the Changes sheet reads and writes them through the draft
// store, and the composer shows the same list.

export type Review = {
  comments: readonly ReviewComment[];
  /** The comment on each place, one per line. */
  byPlace: Map<string, ReviewComment>;
  /** The place whose editor is open, if any. */
  editing: string | null;
  /** The draft has loaded and no send is holding the comments. */
  writable: boolean;
  atLimit: boolean;
  begin: (place: string) => void;
  finish: () => void;
  save: (site: CommentSite, text: string) => void;
  remove: (id: string) => void;
};

export const ReviewContext = createContext<Review | null>(null);

export function useReview() {
  const review = useContext(ReviewContext);
  if (!review) throw new Error("useReview needs a ReviewContext.");
  return review;
}

export function useReviewState(key: DraftKey): Review {
  const { draft, loaded, editComments } = useDraft(key);
  const [editing, setEditing] = useState<string | null>(null);
  const writable = loaded && draft.submission?.state !== "submitting";
  const comments = draft.comments;
  const byPlace = useMemo(() => new Map(comments.map((comment) => [commentPlace(comment), comment])), [comments]);
  const atLimit = comments.length >= REVIEW_COMMENT_LIMITS.count;
  const begin = useCallback((place: string) => setEditing(place), []);
  const finish = useCallback(() => setEditing(null), []);
  const save = useCallback(
    (site: CommentSite, text: string) => {
      const clean = cleanCommentText(text);
      if (commentProblem(clean)) return;
      const place = commentPlace(site);
      editComments((now) => {
        const held = now.find((comment) => commentPlace(comment) === place);
        if (held) return now.map((comment) => (comment === held ? { ...comment, text: clean } : comment));
        if (now.length >= REVIEW_COMMENT_LIMITS.count) return now;
        return [...now, { id: newId(), path: site.path, line: site.line, side: site.side, text: clean }];
      });
    },
    [editComments],
  );
  const remove = useCallback((id: string) => editComments((now) => now.filter((comment) => comment.id !== id)), [editComments]);
  return { comments, byPlace, editing, writable, atLimit, begin, finish, save, remove };
}
