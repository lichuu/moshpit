import { z } from "zod";
import { accessError } from "./access";
import { headers } from "./bridge";
import { commentPlace, type ReviewComment } from "./review-comments";

// C3: what has this agent changed so far? The bridge answers from the pane's
// own checkout; the client only ever names the pane.

const Range = z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]);
const Count = z.number().int().nonnegative().nullable();

const ChangedFileSchema = z.object({
  path: z.string().min(1).max(4096),
  previousPath: z.string().min(1).max(4096).optional(),
  status: z.string().max(32),
  added: Count,
  deleted: Count,
  binary: z.boolean(),
  untracked: z.boolean(),
  /** Why this file's diff is missing: the patch filled up, the file is too large, or it is not a plain file. */
  omitted: z.string().max(32).optional(),
  /** Where this file's text sits in `patch`. */
  patch: Range.optional(),
});

const ChangesSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("not-a-checkout") }),
  z.object({
    kind: z.literal("checkout"),
    repo: z.string().max(1024),
    branch: z.string().max(1024).nullable(),
    detached: z.boolean(),
    head: z.string().max(64).nullable(),
    files: z.array(ChangedFileSchema).max(1000),
    /** Every changed file, including those past the list's cap. */
    fileCount: z.number().int().nonnegative(),
    patch: z.string().max(4 * 1024 * 1024),
    truncated: z.boolean(),
  }),
]);

export type ChangedFile = z.infer<typeof ChangedFileSchema>;
export type Changes = z.infer<typeof ChangesSchema>;
export type Checkout = Extract<Changes, { kind: "checkout" }>;

export async function fetchChanges(url: string, target: string, signal?: AbortSignal): Promise<Changes> {
  const res = await fetch(`${url}/api/changes?target=${encodeURIComponent(target)}`, {
    headers: headers(url),
    redirect: "error",
    cache: "no-store",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw await accessError(res, url, "changes", signal);
  const result = ChangesSchema.safeParse(await res.json().catch(() => null));
  if (!result.success) throw new Error("The bridge returned an unusable changes response.");
  return result.data;
}

// C11: counts of work a closed pane could strand, for the Close dialog.

const SummaryCount = z.number().int().nonnegative().max(1000);

const ChangesSummarySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("not-a-checkout") }),
  z.object({
    kind: z.literal("checkout"),
    branch: z.string().max(1024).nullable(),
    detached: z.boolean(),
    counts: z.object({
      staged: SummaryCount,
      unstaged: SummaryCount,
      /** Files with a staged or an unstaged change, each once. */
      uncommitted: SummaryCount,
      untracked: SummaryCount,
      unpushed: SummaryCount,
    }),
    /** What "unpushed" was measured against. */
    unpushedBasis: z.enum(["upstream", "remotes", "detached", "local-only", "no-commits"]),
    /** A count that reached the bridge's cap is a floor. */
    truncated: z.boolean(),
  }),
]);

export type ChangesSummary = z.infer<typeof ChangesSummarySchema>;

export async function fetchChangesSummary(url: string, target: string, signal?: AbortSignal, timeoutMs = 20_000): Promise<ChangesSummary> {
  const res = await fetch(`${url}/api/changes/summary?target=${encodeURIComponent(target)}`, {
    headers: headers(url),
    redirect: "error",
    cache: "no-store",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw await accessError(res, url, "changes summary", signal);
  const result = ChangesSummarySchema.safeParse(await res.json().catch(() => null));
  if (!result.success) throw new Error("The bridge returned an unusable changes summary.");
  return result.data;
}

const plural = (count: number, one: string, many: string) => `${count >= 1000 ? "1000+" : count} ${count === 1 ? one : many}`;

/**
 * What a summary found, in plain words, one phrase per kind. Empty means
 * nothing a closed pane could strand: a clean checkout whose commits are all
 * pushed, a directory that is not a checkout, or a repository with no remote
 * at all (its commits are not "unpushed" anywhere).
 */
export function unsavedWork(summary: ChangesSummary): string[] {
  if (summary.kind !== "checkout") return [];
  const { uncommitted, untracked, unpushed } = summary.counts;
  const found: string[] = [];
  if (uncommitted) found.push(plural(uncommitted, "uncommitted file", "uncommitted files"));
  if (untracked) found.push(plural(untracked, "untracked file", "untracked files"));
  if (unpushed) {
    found.push(summary.unpushedBasis === "detached" ? plural(unpushed, "commit not on any branch", "commits not on any branch") : plural(unpushed, "commit not pushed", "commits not pushed"));
  }
  return found;
}

export type DiffLine =
  | { kind: "add" | "del" | "ctx"; text: string; number: number }
  | { kind: "note"; text: string };
export type DiffHunk = { header: string; lines: DiffLine[] };
/** The path, line number and side a comment cites. */
export type CommentSite = Pick<ReviewComment, "path" | "line" | "side">;
export type FileDiff ={ meta: string[]; hunks: DiffHunk[]; lineCount: number };

// Git's own header lines say nothing the file row does not: the paths, the
// blob IDs, the old and new file names.
const PLUMBING = /^(diff --git |index |--- |\+\+\+ |rename from |rename to |similarity index |dissimilarity index )/;
const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * One file's piece of the patch, as hunks of numbered lines. An added or
 * context line carries its new line number, a removed line its old one: one
 * gutter, which is what fits beside the code on a phone.
 */
export function parseFileDiff(text: string): FileDiff {
  const meta: string[] = [];
  const hunks: DiffHunk[] = [];
  let hunk: DiffHunk | undefined;
  let oldAt = 0;
  let newAt = 0;
  let lineCount = 0;
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    const start = HUNK.exec(line);
    if (start) {
      oldAt = Number(start[1]);
      newAt = Number(start[2]);
      hunk = { header: line, lines: [] };
      hunks.push(hunk);
      continue;
    }
    if (!hunk) {
      if (!PLUMBING.test(line)) meta.push(line);
      continue;
    }
    lineCount += 1;
    const sign = line[0];
    const body = line.slice(1);
    if (sign === "+") hunk.lines.push({ kind: "add", text: body, number: newAt++ });
    else if (sign === "-") hunk.lines.push({ kind: "del", text: body, number: oldAt++ });
    else if (sign === "\\") hunk.lines.push({ kind: "note", text: line.slice(2) });
    else {
      hunk.lines.push({ kind: "ctx", text: body, number: newAt });
      oldAt += 1;
      newAt += 1;
    }
  }
  return { meta, hunks, lineCount };
}

export function summarize(changes: Checkout) {
  let added = 0;
  let deleted = 0;
  for (const file of changes.files) {
    added += file.added ?? 0;
    deleted += file.deleted ?? 0;
  }
  return { files: Math.max(changes.fileCount, changes.files.length), added, deleted };
}

export const STATUS_LABEL: Record<string, string> = {
  added: "Added",
  modified: "Modified",
  deleted: "Deleted",
  renamed: "Renamed",
  typechange: "Type changed",
  unmerged: "Conflict",
};

export const STATUS_LETTER: Record<string, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  typechange: "T",
  unmerged: "U",
};

/** Why a file has no diff text, in the words the sheet shows. */
export function omissionText(file: ChangedFile): string | undefined {
  switch (file.omitted) {
    case undefined:
      return undefined;
    case "too-large":
      return "Too large to show";
    case "not-a-file":
      return "Not a plain file, so there is no text to show";
    default:
      return "Left out: the diff reached its size limit";
  }
}

/** Files whose diff text was cut or never produced, for the truncation note. */
export function missingFiles(changes: Checkout): ChangedFile[] {
  return changes.files.filter((file) => file.omitted);
}

/** A file's slice of the patch, or an empty string when it has none. */
export function patchOf(changes: Checkout, file: ChangedFile): string {
  return file.patch ? changes.patch.slice(file.patch[0], file.patch[1]) : "";
}

/** The branch as the sheet names it. */
export function branchLabel(changes: Checkout): string {
  if (changes.branch) return changes.branch;
  if (changes.detached) return changes.head ? `detached at ${changes.head}` : "detached HEAD";
  return "no branch";
}

/** Small diffs open by themselves; a long list opens none, so the list itself stays scannable. */
export const OPEN_BY_DEFAULT_FILES = 4;
export const OPEN_BY_DEFAULT_LINES = 300;

export function openByDefault(changes: Checkout): Set<string> {
  if (changes.files.length > OPEN_BY_DEFAULT_FILES) return new Set();
  const open = new Set<string>();
  for (const file of changes.files) {
    if (file.patch && !file.binary && (file.added ?? 0) + (file.deleted ?? 0) <= OPEN_BY_DEFAULT_LINES) open.add(file.path);
  }
  return open;
}

/**
 * Where a comment on this line is cited (C4). A removed line is counted in the
 * old file, so on a renamed file it cites the path from before the rename; any
 * other line is counted in the new file.
 */
export function lineSite(file: ChangedFile, line: Extract<DiffLine, { number: number }>): CommentSite {
  return line.kind === "del"
    ? { path: file.previousPath ?? file.path, line: line.number, side: "old" }
    : { path: file.path, line: line.number, side: "new" };
}

/** Every commentable line of the checkout's diff, as its place mapped to the file that shows it. */
export function diffPlaces(changes: Checkout): Map<string, string> {
  const places = new Map<string, string>();
  for (const file of changes.files) {
    if (!file.patch || file.binary || file.omitted) continue;
    for (const hunk of parseFileDiff(patchOf(changes, file)).hunks) {
      for (const line of hunk.lines) if (line.kind !== "note") places.set(commentPlace(lineSite(file, line)), file.path);
    }
  }
  return places;
}
