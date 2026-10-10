import { execFile } from "node:child_process";
import { copyFile, lstat, mkdtemp, open, realpath, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// C3: what has this agent changed so far? Read-only, bounded, and fed by a
// directory the bridge took from the herdr snapshot -- nothing here accepts a
// path, ref or git argument from a client.

/** The patch text sent to the client, in bytes. Whole files only: a file that does not fit is left out. */
export const PATCH_CAP = 3 * 1024 * 1024;
/** What status, name-status and numstat may print before the list is cut. */
export const LIST_CAP = 4 * 1024 * 1024;
/** Files named in one answer. Changes past this are counted, not listed. */
export const FILE_CAP = 500;
/** An untracked file larger than this is listed without its content. */
export const UNTRACKED_FILE_CAP = 1024 * 1024;
/** Every git process. */
export const GIT_TIMEOUT_MS = 10_000;
/** The whole read, however many git processes it takes. */
export const READ_DEADLINE_MS = 30_000;
/** Reads running at once on this bridge. */
export const MAX_READS = 4;
/** C11: no count in a summary goes past this; a count that reaches it is a floor. */
export const COUNT_CAP = 1000;
/** What a summary's status call may print before it is cut. */
export const SUMMARY_LIST_CAP = 512 * 1024;

const UNTRACKED_BATCH = 4;
const SNIFF_BYTES = 8000;

export class ChangesError extends Error {
  constructor(status, code, message, retryAfter) {
    super(message);
    this.status = status;
    this.code = code;
    if (retryAfter) this.retryAfter = retryAfter;
  }
}

const invalidRequest = () => new ChangesError(400, "changes_request_invalid", "Name the pane only.");

/** The pane named by `?target=`, and nothing else: any other parameter is refused. */
export function parseChangesQuery(params) {
  for (const name of new Set(params.keys())) {
    if (name !== "target") throw invalidRequest();
  }
  const targets = params.getAll("target");
  if (targets.length !== 1) throw invalidRequest();
  const [target] = targets;
  if (!target || target.length > 512 || target.startsWith("-")) throw invalidRequest();
  return target;
}

/** The directory the herdr snapshot reports for the pane. The only source of the path git runs in. */
export function changesDirectory(snapshot, target) {
  const agent = snapshot?.agents?.find((candidate) => candidate.id === target || candidate.paneId === target);
  if (!agent) throw new ChangesError(404, "changes_target_unknown", "That pane is not running.");
  const cwd = typeof agent.cwd === "string" ? agent.cwd.replace(/\/+$/, "") : "";
  if (!cwd || !path.isAbsolute(cwd) || cwd.includes("\0")) {
    throw new ChangesError(409, "changes_no_directory", "This pane has no known directory.");
  }
  return cwd;
}

// Nothing from the user's own environment may steer git: GIT_DIR, an external
// diff program, a pager and the like all come in through GIT_* variables.
export function gitEnvironment(extra) {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !name.startsWith("GIT_")) env[name] = value;
  }
  return {
    ...env,
    LC_ALL: "C",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    GIT_NO_LAZY_FETCH: "1",
    ...extra,
  };
}

// Config that could run a program or change the shape of the output because
// of a read. Each is set on the command line, which outranks every file.
const SAFE_CONFIG = [
  "core.fsmonitor=false",
  // git writes the refreshed (private) index, which would run post-index-change.
  "core.hooksPath=/dev/null",
  "core.pager=cat",
  "core.quotepath=false",
  "diff.external=",
  "diff.noprefix=false",
  "diff.mnemonicPrefix=false",
  "diff.relative=false",
  "diff.suppressBlankEmpty=false",
  "color.ui=false",
  "submodule.recurse=false",
].flatMap((setting) => ["-c", setting]);

// Flags for every diff: no external program, no text conversion, fixed
// prefixes and context so a user's diff settings cannot change what we parse.
const DIFF_FLAGS = ["--no-ext-diff", "--no-textconv", "--no-color", "--ignore-submodules=all", "--src-prefix=a/", "--dst-prefix=b/", "-U3"];

export function runGit(bin, args, { cwd, env, signal, maxBuffer, timeout, okCodes = [0] }) {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      [...SAFE_CONFIG, ...args],
      { cwd, env, signal, maxBuffer, timeout, killSignal: "SIGKILL", encoding: "buffer", windowsHide: true },
      (error, stdout, stderr) => {
        if (!error) return resolve({ code: 0, stdout, stderr: stderr.toString("utf8"), capped: false });
        if (error.code === "ENOENT") return reject(new ChangesError(503, "changes_git_missing", "Git is not installed on this host."));
        if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          return resolve({ code: 0, stdout: stdout.subarray(0, maxBuffer), stderr: "", capped: true });
        }
        if (error.name === "AbortError" || error.code === "ABORT_ERR") return reject(error);
        if (error.killed) return reject(new ChangesError(504, "changes_timeout", "Git took too long to answer."));
        if (typeof error.code === "number" && okCodes.includes(error.code)) {
          return resolve({ code: error.code, stdout, stderr: stderr.toString("utf8"), capped: false });
        }
        if (typeof error.code === "number") return resolve({ code: error.code, stdout, stderr: stderr.toString("utf8"), capped: false, failed: true });
        reject(error);
      },
    );
  });
}

/** NUL-separated tokens. A capped read drops its last token, which may be cut short. */
function tokens(buffer, capped) {
  const parts = buffer.toString("utf8").split("\0");
  parts.pop();
  if (capped) parts.pop();
  return parts;
}

function parseStatus({ stdout, capped }) {
  const parts = tokens(stdout, capped);
  let head = null;
  let oid = null;
  let ahead = null;
  const untracked = [];
  let staged = 0;
  let unstaged = 0;
  let uncommitted = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (part.startsWith("# branch.head ")) head = part.slice("# branch.head ".length);
    else if (part.startsWith("# branch.oid ")) oid = part.slice("# branch.oid ".length);
    // Printed only while the upstream ref exists in this repository.
    else if (part.startsWith("# branch.ab ")) ahead = Number(/^# branch\.ab \+(\d+) /.exec(part)?.[1] ?? Number.NaN);
    else if (part.startsWith("? ")) untracked.push(part.slice(2));
    else if (/^[12u] /.test(part)) {
      // XY: the index column, then the worktree column; "." means unchanged.
      // An unmerged entry is a conflict still to resolve, so it counts as unstaged.
      const conflict = part[0] === "u";
      if (part[2] !== "." && !conflict) staged += 1;
      if (part[3] !== "." || conflict) unstaged += 1;
      uncommitted += 1;
      // A rename entry carries its original path as a token of its own.
      if (part[0] === "2") i += 1;
    }
  }
  const hasCommits = oid !== null && oid !== "(initial)";
  const detached = head === "(detached)";
  return {
    branch: detached || !head ? null : head,
    detached,
    head: hasCommits ? oid.slice(0, 7) : null,
    hasCommits,
    untracked,
    ahead: Number.isFinite(ahead) ? ahead : null,
    staged,
    unstaged,
    uncommitted,
  };
}

const STATUS_NAMES = { A: "added", M: "modified", D: "deleted", R: "renamed", T: "typechange", U: "unmerged" };

function parseNameStatus({ stdout, capped }) {
  const parts = tokens(stdout, capped);
  const files = [];
  for (let i = 0; i < parts.length; i += 1) {
    const letter = parts[i][0];
    if (letter === "R" || letter === "C") {
      if (parts[i + 2] === undefined) break;
      files.push({ path: parts[i + 2], previousPath: parts[i + 1], status: STATUS_NAMES.R });
      i += 2;
    } else {
      if (parts[i + 1] === undefined) break;
      files.push({ path: parts[i + 1], status: STATUS_NAMES[letter] ?? "modified" });
      i += 1;
    }
  }
  return files;
}

function parseNumstat({ stdout, capped }) {
  const parts = tokens(stdout, capped);
  const counts = new Map();
  for (let i = 0; i < parts.length; i += 1) {
    const match = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(parts[i]);
    if (!match) continue;
    let name = match[3];
    // A rename prints an empty name, then the old and new paths as tokens.
    if (name === "") {
      name = parts[i + 2];
      i += 2;
      if (name === undefined) break;
    }
    const binary = match[1] === "-";
    counts.set(name, { added: binary ? null : Number(match[1]), deleted: binary ? null : Number(match[2]), binary });
  }
  return counts;
}

// git prints a name in double quotes with C escapes when it holds a quote, a
// backslash or a control character. Non-ASCII stays as it is (quotepath off).
const ESCAPES = { 7: "a", 8: "b", 9: "t", 10: "n", 11: "v", 12: "f", 13: "r", 34: '"', 92: "\\" };
function quoteName(name) {
  if (![...name].some((char) => char === '"' || char === "\\" || char < " " || char === "\x7f")) return name;
  let out = '"';
  for (const byte of Buffer.from(name, "utf8")) {
    if (ESCAPES[byte]) out += `\\${ESCAPES[byte]}`;
    else if (byte < 0x20 || byte === 0x7f) out += `\\${byte.toString(8).padStart(3, "0")}`;
    else out += String.fromCharCode(byte);
  }
  return `${out}"`;
}
const patchHeader = (file) => `diff --git ${quoteName(`a/${file.previousPath ?? file.path}`)} ${quoteName(`b/${file.path}`)}`;

/** The patch cut into one piece per file. A hunk line never starts with "diff", so a header can only be a header. */
function splitPatch(text) {
  const starts = [];
  if (text.startsWith("diff --git ")) starts.push(0);
  for (let at = text.indexOf("\ndiff --git "); at !== -1; at = text.indexOf("\ndiff --git ", at + 1)) starts.push(at + 1);
  return starts.map((start, n) => text.slice(start, starts[n + 1] ?? text.length));
}

/**
 * A path git reported for the checkout, resolved through symbolic links and
 * kept only if its directory is still inside the root. The last component is
 * left alone: a symlink is shown as a symlink and never followed.
 */
export async function resolveInside(root, relative) {
  if (!relative || path.isAbsolute(relative) || relative.includes("\0")) return null;
  const parts = relative.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return null;
  try {
    const base = await realpath(root);
    const parent = await realpath(path.join(base, ...parts.slice(0, -1)));
    if (parent !== base && !parent.startsWith(`${base}${path.sep}`)) return null;
    return path.join(parent, parts.at(-1));
  } catch {
    return null;
  }
}

async function looksBinary(file) {
  const handle = await open(file, "r");
  try {
    const { bytesRead, buffer } = await handle.read(Buffer.alloc(SNIFF_BYTES), 0, SNIFF_BYTES, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

function countLines(chunk) {
  const body = chunk.indexOf("\n@@");
  if (body === -1) return { added: 0, deleted: 0 };
  let added = 0;
  let deleted = 0;
  for (const line of chunk.slice(body + 1).split("\n")) {
    if (line[0] === "+") added += 1;
    else if (line[0] === "-") deleted += 1;
  }
  return { added, deleted };
}

/** Answers `changes` reads. The git program and the two clocks are what a test swaps. */
export function createChanges({ gitBin = "git", timeoutMs = GIT_TIMEOUT_MS, deadlineMs = READ_DEADLINE_MS } = {}) {
  let active = 0;

  async function readOnce(directory, signal, inspect) {
    const env = gitEnvironment();
    const git = (args, options = {}) => runGit(gitBin, args, { env, signal, maxBuffer: LIST_CAP, timeout: timeoutMs, ...options });

    try {
      const info = await stat(directory);
      if (!info.isDirectory()) throw new Error("not a directory");
    } catch {
      throw new ChangesError(409, "changes_directory_missing", "This pane's directory no longer exists.");
    }

    const top = await git(["rev-parse", "--show-toplevel"], { cwd: directory, maxBuffer: 64 * 1024 });
    if (top.failed) {
      // Git refuses a checkout owned by someone else; that is not "no checkout".
      if (/dubious ownership|safe\.directory/.test(top.stderr)) {
        throw new ChangesError(409, "changes_git_refused", "Git will not read this checkout because another user owns it.");
      }
      return { kind: "not-a-checkout" };
    }
    const root = top.stdout.toString("utf8").replace(/\n+$/, "");
    if (!root) return { kind: "not-a-checkout" };
    const scratch = await mkdtemp(path.join(tmpdir(), "moshpit-changes-index-"));
    try {
      return await inspect(root, scratch, git, signal);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  // Git for everything past finding the checkout, shared by every kind of read:
  // a private copy of the index, and every configured filter driver blanked.
  async function privateGit(root, scratch, git, signal) {
    const inRoot = { cwd: root };

    // `git diff` refreshes the index it reads, and writes it back even with
    // optional locks off. So git works on a private copy, with the original's
    // timestamps so racy-clean checks behave the same, and the real index is
    // only ever read.
    const privateIndex = path.join(scratch, "index");
    const where = await git(["rev-parse", "--git-path", "index"], { ...inRoot, maxBuffer: 64 * 1024 });
    if (!where.failed) {
      const source = path.resolve(root, where.stdout.toString("utf8").replace(/\n+$/, ""));
      try {
        await copyFile(source, privateIndex);
        const { atime, mtime } = await stat(source);
        await utimes(privateIndex, atime, mtime);
      } catch {
        // No index yet: git starts from an empty one, in the private path.
      }
    }

    // A filter driver (git-lfs, or any "clean" command) runs when a tracked
    // file's content is compared. Blank every one the config names.
    const configured = await git(["config", "-z", "--name-only", "--get-regexp", "^filter\\."], { ...inRoot, maxBuffer: 256 * 1024 });
    const filters = new Set();
    for (const key of configured.code === 0 ? tokens(configured.stdout, false) : []) {
      const match = /^filter\.([\s\S]+)\.[^.]+$/.exec(key);
      if (match) filters.add(match[1]);
    }
    const blanked = {};
    let count = 0;
    for (const name of filters) {
      for (const [variable, value] of [["clean", ""], ["smudge", ""], ["process", ""], ["required", "false"]]) {
        blanked[`GIT_CONFIG_KEY_${count}`] = `filter.${name}.${variable}`;
        blanked[`GIT_CONFIG_VALUE_${count}`] = value;
        count += 1;
      }
    }
    return (args, options = {}) =>
      runGit(gitBin, args, { env: gitEnvironment({ GIT_INDEX_FILE: privateIndex, ...(count ? { GIT_CONFIG_COUNT: String(count), ...blanked } : {}) }), signal, maxBuffer: LIST_CAP, timeout: timeoutMs, ...inRoot, ...options });
  }

  async function readCheckout(root, scratch, git, signal) {
    const readGit = await privateGit(root, scratch, git, signal);

    const status = await readGit(["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all", "--ignore-submodules=all"]);
    if (status.failed) throw new Error("git status failed");
    const state = parseStatus(status);
    let cut = status.capped;

    const tracked = [];
    let patchText = "";
    let patchCapped = false;
    if (state.hasCommits) {
      const [names, numbers, patch] = await Promise.all([
        readGit(["diff", "HEAD", "--name-status", "-z", "-M", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "--"]),
        readGit(["diff", "HEAD", "--numstat", "-z", "-M", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "--"]),
        readGit(["diff", "HEAD", "-p", "-M", ...DIFF_FLAGS, "--"], { maxBuffer: PATCH_CAP }),
      ]);
      if (names.failed || numbers.failed || patch.failed) throw new Error("git diff failed");
      cut ||= names.capped || numbers.capped;
      const counts = parseNumstat(numbers);
      for (const file of parseNameStatus(names)) {
        const known = counts.get(file.path);
        tracked.push({
          ...file,
          added: known?.added ?? null,
          deleted: known?.deleted ?? null,
          binary: known?.binary ?? false,
          untracked: false,
        });
      }
      patchText = patch.stdout.toString("utf8");
      patchCapped = patch.capped;
    }

    // Untracked files have no index entry to diff, and `add` is off limits, so
    // each one is compared with nothing instead. Before the first commit
    // everything staged is new too.
    // A file removed from the index but still on disk is both "deleted" since
    // HEAD and untracked; it is listed once, as the deletion.
    const known = new Set(tracked.map((file) => file.path));
    let newPaths = state.untracked.filter((name) => !known.has(name)).map((name) => ({ name, untracked: true }));
    if (!state.hasCommits) {
      const staged = await readGit(["ls-files", "-z", "--cached"]);
      if (!staged.failed) {
        cut ||= staged.capped;
        newPaths = [...tokens(staged.stdout, staged.capped).map((name) => ({ name, untracked: false })), ...newPaths];
      }
    }

    const all = [...tracked, ...newPaths];
    const fileCount = all.length;
    const listedNew = newPaths.slice(0, Math.max(0, FILE_CAP - tracked.length));
    const listedTracked = tracked.slice(0, FILE_CAP);
    if (fileCount > listedTracked.length + listedNew.length) cut = true;

    let patch = "";
    let bytes = 0;
    const take = (chunk) => {
      const range = [patch.length, patch.length + chunk.length];
      patch += chunk;
      bytes += Buffer.byteLength(chunk);
      return range;
    };

    // Tracked changes: the pieces of one patch, matched to files by header.
    const chunks = splitPatch(patchText);
    if (patchCapped) chunks.pop();
    const byHeader = new Map(listedTracked.map((file) => [patchHeader(file), file]));
    for (const chunk of chunks) {
      const file = byHeader.get(chunk.slice(0, chunk.indexOf("\n")));
      if (!file) continue;
      const range = take(chunk);
      // A change of type (file to symlink) prints two pieces under one header.
      file.patch = file.patch && file.patch[1] === range[0] ? [file.patch[0], range[1]] : range;
    }
    if (patchCapped) {
      for (const file of listedTracked) if (!file.patch) file.omitted = "patch-cap";
      cut = true;
    }

    const files = [...listedTracked];
    for (let at = 0; at < listedNew.length; at += UNTRACKED_BATCH) {
      const batch = listedNew.slice(at, at + UNTRACKED_BATCH);
      const results = await Promise.all(batch.map((entry) => (bytes >= PATCH_CAP ? skipped(entry.name, entry.untracked) : newFile(entry, root, readGit))));
      for (const result of results) {
        if (!result) continue;
        const { file, chunk } = result;
        if (chunk !== undefined) {
          if (bytes + Buffer.byteLength(chunk) > PATCH_CAP) file.omitted = "patch-cap";
          else file.patch = take(chunk);
        }
        if (file.omitted) cut = true;
        files.push(file);
      }
    }

    return {
      kind: "checkout",
      repo: path.basename(root) || "checkout",
      branch: state.branch,
      detached: state.detached,
      head: state.head,
      files,
      fileCount: Math.max(fileCount, files.length),
      patch,
      truncated: cut,
    };
  }

  // C11: is there work here that closing the pane could strand? Counts only:
  // no patch text and no per-file diff, and nothing is fetched. "Unpushed" is
  // judged from refs as they are in this repository.
  async function summarizeCheckout(root, scratch, git, signal) {
    const readGit = await privateGit(root, scratch, git, signal);
    const status = await readGit(["status", "--porcelain=v2", "--branch", "--ahead-behind", "-z", "--untracked-files=all", "--ignore-submodules=all"], {
      maxBuffer: SUMMARY_LIST_CAP,
    });
    if (status.failed) throw new Error("git status failed");
    const state = parseStatus(status);

    // How many commits of HEAD are on nothing else. The walk stops at the cap.
    const commitsNotOn = async (...refs) => {
      const walk = await readGit(["rev-list", "--count", `--max-count=${COUNT_CAP}`, "HEAD", "--not", ...refs, "--"], { maxBuffer: 64 * 1024 });
      if (walk.failed) throw new Error("git rev-list failed");
      return Number(walk.stdout.toString("utf8").trim()) || 0;
    };
    let unpushed = 0;
    let basis;
    if (!state.hasCommits) {
      basis = "no-commits";
    } else if (state.ahead !== null) {
      // The branch's upstream ref as it is here, however stale.
      unpushed = state.ahead;
      basis = "upstream";
    } else if (state.detached) {
      // On no branch: a commit that no branch and no remote-tracking ref reaches.
      unpushed = await commitsNotOn("--branches", "--remotes");
      basis = "detached";
    } else {
      // No upstream (or its ref is gone). Without any remote nothing is "unpushed".
      const remotes = await readGit(["remote"], { maxBuffer: 64 * 1024 });
      if (remotes.failed) throw new Error("git remote failed");
      if (remotes.stdout.toString("utf8").trim() === "") {
        basis = "local-only";
      } else {
        unpushed = await commitsNotOn("--remotes");
        basis = "remotes";
      }
    }

    const counts = {
      staged: state.staged,
      unstaged: state.unstaged,
      uncommitted: state.uncommitted,
      untracked: state.untracked.length,
      unpushed,
    };
    // A count at the cap is a floor, and so is every count after a cut listing.
    const truncated = status.capped || Object.values(counts).some((value) => value >= COUNT_CAP);
    for (const name of Object.keys(counts)) counts[name] = Math.min(counts[name], COUNT_CAP);
    return { kind: "checkout", branch: state.branch, detached: state.detached, counts, unpushedBasis: basis, truncated };
  }

  // The patch for one file that git does not track yet. Null when the file
  // vanished between the listing and now.
  async function newFile(entry, root, readGit) {
    const file = { path: entry.name, status: "added", added: null, deleted: null, binary: false, untracked: entry.untracked };
    if (entry.name.endsWith("/")) return { file: { ...file, omitted: "not-a-file" } };
    const resolved = await resolveInside(root, entry.name);
    if (!resolved) return null;
    let info;
    try {
      info = await lstat(resolved);
    } catch {
      return null;
    }
    if (!info.isFile() && !info.isSymbolicLink()) return { file: { ...file, omitted: "not-a-file" } };
    if (info.isFile() && info.size > UNTRACKED_FILE_CAP) {
      // Too big to show, but still worth saying whether it is text.
      const binary = await looksBinary(resolved).catch(() => false);
      return { file: binary ? { ...file, binary: true } : { ...file, omitted: "too-large" } };
    }
    const result = await readGit(["diff", "--no-index", ...DIFF_FLAGS, "--", "/dev/null", entry.name], {
      okCodes: [0, 1],
      maxBuffer: PATCH_CAP,
    });
    if (result.failed) return null;
    if (result.capped) return { file: { ...file, omitted: "patch-cap" } };
    const chunk = result.stdout.toString("utf8");
    if (!chunk) return { file };
    if (/^Binary files .* differ$/m.test(chunk)) return { file: { ...file, binary: true }, chunk };
    return { file: { ...file, ...countLines(chunk) }, chunk };
  }

  function skipped(name, untracked) {
    return { file: { path: name, status: "added", added: null, deleted: null, binary: false, untracked, omitted: "patch-cap" } };
  }

  // One read of either kind: the same limit, deadline and error classes.
  async function guarded(directory, signal, inspect) {
    if (active >= MAX_READS) throw new ChangesError(429, "changes_busy", "Other change reads are still running. Try again in a moment.", 2);
    active += 1;
    const deadline = AbortSignal.timeout(deadlineMs);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      return await readOnce(directory, combined, inspect);
    } catch (error) {
      if (error instanceof ChangesError) throw error;
      if (deadline.aborted) throw new ChangesError(504, "changes_timeout", "Git took too long to answer.");
      throw error;
    } finally {
      active -= 1;
    }
  }

  return {
    /** Reads the changes in `directory`: a path the caller took from the herdr snapshot. */
    read: (directory, { signal } = {}) => guarded(directory, signal, readCheckout),
    /** C11: counts of work a closed pane could leave behind, for the same kind of directory. */
    summary: (directory, { signal } = {}) => guarded(directory, signal, summarizeCheckout),
  };
}
