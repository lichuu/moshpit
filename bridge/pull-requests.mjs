import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { GIT_TIMEOUT_MS, gitEnvironment, runGit } from "./changes.mjs";

// C9: which pull request belongs to this agent's branch? The bridge asks the
// host's own `gh` login, for the repository the branch's upstream remote names
// and nothing else, and sends the browser a number, a readiness and a link.
// Nothing here takes a path, branch or repository from a client.

/** Each (repository, branch) is asked about at most this often. */
export const REFRESH_MS = 90_000;
/** After a failure of any kind. */
export const BACKOFF_MS = 5 * 60_000;
/** After an authentication or rate-limit failure, for every branch at once. */
export const LONG_BACKOFF_MS = 60 * 60_000;
/** After `gh` was not found on this host: nothing is spawned until then. */
export const GH_MISSING_RECHECK_MS = 60 * 60_000;
/** Work only runs while a snapshot was served this recently. */
export const INTEREST_MS = 120_000;
/** How long a pane's directory, and a checkout's upstream, are trusted. */
export const CHECKOUT_TTL_MS = 30_000;
/** A forced re-read of a checkout (its branch changed) waits at least this long since the last. */
export const MIN_RESOLVE_MS = 5_000;
/** A result older than this, because every refresh since has failed, is no longer shown. */
export const STALE_MS = 6 * 60 * 60_000;
/** One `gh` process. */
export const GH_TIMEOUT_MS = 20_000;
/** What `gh` may print before it is killed. */
export const GH_OUTPUT_CAP = 2 * 1024 * 1024;
/** Most `gh` processes, and most resolution passes, running at once. */
export const MAX_GH = 2;
export const MAX_RESOLVES = 2;
/** Cache sizes. A bigger working set evicts the least recently shown. */
export const MAX_ENTRIES = 64;
export const MAX_CHECKOUTS = 128;
/** PRs asked for per branch. A branch name reused more often than this may miss its open one. */
export const PR_LIMIT = 20;

/** The only host whose repositories are asked about. */
export const GITHUB_HOST = "github.com";

export const PR_FIELDS = "number,state,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,headRefName,headRepositoryOwner,url,updatedAt";

const OWNER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$/;
const REPO = /^[A-Za-z0-9_.][A-Za-z0-9._-]{0,99}$/;
const BRANCH = /^[A-Za-z0-9._/+@-]{1,200}$/;
const REMOTE = /^[A-Za-z0-9._-]{1,100}$/;

function repositoryOf(owner, name) {
  if (typeof owner !== "string" || typeof name !== "string" || !OWNER.test(owner) || !REPO.test(name) || name === "." || name === "..") return null;
  return { owner, name };
}

function splitRepositoryPath(text) {
  const parts = text.replace(/\/+$/, "").split("/");
  if (parts.length !== 2) return null;
  return repositoryOf(parts[0], parts[1].replace(/\.git$/, ""));
}

/**
 * `{owner, name}` for a remote URL that names a GitHub repository, else null.
 * Accepted: https://github.com/o/n(.git), https://<user>@github.com/o/n, the
 * scp form git@github.com:o/n(.git), ssh://git@github.com/o/n(.git) and
 * ssh://git@ssh.github.com:443/o/n(.git). Refused: any other host (GitHub
 * Enterprise and look-alikes included), http and git://, a path or file
 * remote, extra path segments, a query or fragment, odd ports.
 */
export function parseGithubRemote(url) {
  if (typeof url !== "string") return null;
  const text = url.trim();
  if (!text || text.length > 500 || /[\s\0\\?#%]/.test(text)) return null;
  const scp = /^git@(github\.com):([^/][^:]*)$/i.exec(text);
  if (scp) return splitRepositoryPath(scp[2]);
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  if (parsed.search || parsed.hash) return null;
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol === "https:") {
    if (host !== GITHUB_HOST || (parsed.port && parsed.port !== "443")) return null;
  } else if (parsed.protocol === "ssh:") {
    const hostOk = host === GITHUB_HOST ? ["", "22"].includes(parsed.port) : host === `ssh.${GITHUB_HOST}` && ["", "22", "443"].includes(parsed.port);
    if (!hostOk || parsed.username !== "git" || parsed.password) return null;
  } else {
    return null;
  }
  return splitRepositoryPath(parsed.pathname.slice(1));
}

// --- readiness -------------------------------------------------------------

/**
 * One word for a PR, from the first rule that applies:
 *  1. merged    state MERGED
 *  2. closed    state CLOSED (not merged)
 *  3. draft     open and a draft
 *  4. blocked   open and any of: mergeable CONFLICTING or merge state DIRTY, a
 *               failing check, review decision CHANGES_REQUESTED
 *  5. pending   open and any of: a check not finished (or needing action),
 *               review decision REVIEW_REQUIRED, mergeable UNKNOWN, or a merge
 *               state that is not CLEAN/HAS_HOOKS (BEHIND, BLOCKED, UNSTABLE,
 *               UNKNOWN)
 *  6. ready     everything else: mergeable, clean, every check passed (an empty
 *               rollup counts), not waiting on a review
 * Red outranks yellow, so a conflict with checks still running is blocked.
 * A failing check is a CheckRun that finished FAILURE, TIMED_OUT,
 * STARTUP_FAILURE or CANCELLED, or a status that is FAILURE or ERROR. A check
 * that finished NEUTRAL or SKIPPED passed.
 */
export function readinessOf(pr) {
  const state = String(pr.state ?? "").toUpperCase();
  if (state === "MERGED") return "merged";
  if (state === "CLOSED") return "closed";
  if (pr.isDraft === true) return "draft";
  const mergeable = String(pr.mergeable ?? "").toUpperCase();
  const merge = String(pr.mergeStateStatus ?? "").toUpperCase();
  const review = String(pr.reviewDecision ?? "").toUpperCase();
  const checks = (Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : []).map(checkOutcome);
  if (mergeable === "CONFLICTING" || merge === "DIRTY" || review === "CHANGES_REQUESTED" || checks.includes("failing")) return "blocked";
  if (checks.includes("pending") || review === "REVIEW_REQUIRED" || mergeable !== "MERGEABLE") return "pending";
  // Older or enterprise servers omit the merge state; mergeable is then all there is.
  if (merge && merge !== "CLEAN" && merge !== "HAS_HOOKS") return "pending";
  return "ready";
}

function checkOutcome(check) {
  if (!check || typeof check !== "object") return "pending";
  const type = check.__typename;
  if (type === "StatusContext" || (type !== "CheckRun" && typeof check.state === "string" && check.status === undefined)) {
    switch (String(check.state).toUpperCase()) {
      case "SUCCESS":
        return "passing";
      case "FAILURE":
      case "ERROR":
        return "failing";
      default:
        return "pending";
    }
  }
  if (String(check.status ?? "").toUpperCase() !== "COMPLETED") return "pending";
  switch (String(check.conclusion ?? "").toUpperCase()) {
    case "SUCCESS":
    case "NEUTRAL":
    case "SKIPPED":
      return "passing";
    case "FAILURE":
    case "TIMED_OUT":
    case "STARTUP_FAILURE":
    case "CANCELLED":
      return "failing";
    default:
      return "pending";
  }
}

const STATE_RANK = { OPEN: 0, MERGED: 1, CLOSED: 2 };

/** The `https://github.com/<owner>/<name>/pull/<number>` link gh reported, or null when it is anything else. */
function pullUrl(value, repository, number) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== GITHUB_HOST || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  const expected = `/${repository.owner}/${repository.name}/pull/${number}`;
  if (parsed.pathname.toLowerCase() !== expected.toLowerCase()) return null;
  // Rebuilt from parts already validated, so what is sent is never gh's own text.
  return `https://${GITHUB_HOST}${expected}`;
}

/**
 * The PR for `branch` in `repository`, from the list gh printed. A PR counts
 * only when its head branch is this branch and its head repository's owner is
 * the remote's owner (a fork's branch of the same name is someone else's), and
 * its link names this repository. Open beats merged beats closed, then the
 * most recently updated wins. Null when none qualifies.
 */
export function choosePullRequest(list, { repository, branch }) {
  if (!Array.isArray(list)) return null;
  const owner = repository.owner.toLowerCase();
  const found = [];
  for (const pr of list) {
    if (!pr || typeof pr !== "object") continue;
    const number = pr.number;
    if (!Number.isSafeInteger(number) || number < 1) continue;
    const rank = STATE_RANK[String(pr.state ?? "").toUpperCase()];
    if (rank === undefined || pr.headRefName !== branch) continue;
    const headOwner = pr.headRepositoryOwner?.login;
    if (typeof headOwner !== "string" || headOwner.toLowerCase() !== owner) continue;
    const url = typeof pr.url === "string" ? pullUrl(pr.url, repository, number) : null;
    if (!url) continue;
    const updated = Date.parse(pr.updatedAt);
    found.push({ rank, updated: Number.isFinite(updated) ? updated : 0, number, value: { number, readiness: readinessOf(pr), url } });
  }
  found.sort((a, b) => a.rank - b.rank || b.updated - a.updated || b.number - a.number);
  return found[0]?.value ?? null;
}

// --- gh --------------------------------------------------------------------

// The environment `gh` runs in: the bridge's own, so the host's login (its
// config directory, or a token the operator gave the bridge) is what answers.
// The bridge adds no token. Variables that could aim `gh` at another
// repository or host, or change what it prints, are removed.
function ghEnvironment() {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !["GH_REPO", "GH_HOST", "GH_DEBUG", "GH_FORCE_TTY", "DEBUG"].includes(name)) env[name] = value;
  }
  return { ...env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1", GH_PAGER: "cat", LC_ALL: "C" };
}

/** `gh pr list` argv for one repository and head branch. Literal, validated, never led by a dash. */
export function pullListArgs(repository, branch) {
  if (!repositoryOf(repository?.owner, repository?.name) || !BRANCH.test(branch) || branch.startsWith("-")) return null;
  return ["pr", "list", "--repo", `${GITHUB_HOST}/${repository.owner}/${repository.name}`, "--head", branch, "--state", "all", "--limit", String(PR_LIMIT), "--json", PR_FIELDS];
}

/**
 * Runs `gh` with literal argv and no shell. Resolves `{code, stdout, stderr}`,
 * or `{missing}`, `{timedOut}`, `{capped}` or `{aborted}` for the process that
 * could not answer.
 */
function runGhProcess(bin, args, { signal, timeout }) {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { cwd: tmpdir(), env: ghEnvironment(), signal, timeout, maxBuffer: GH_OUTPUT_CAP, killSignal: "SIGKILL", encoding: "utf8", windowsHide: true },
      (error, stdout, stderr) => {
        if (!error) return resolve({ code: 0, stdout, stderr });
        if (error.code === "ENOENT") return resolve({ missing: true });
        if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return resolve({ capped: true });
        if (error.name === "AbortError" || error.code === "ABORT_ERR") return resolve({ aborted: true });
        if (error.killed) return resolve({ timedOut: true });
        if (typeof error.code === "number") return resolve({ code: error.code, stdout, stderr });
        resolve({ code: 1, stdout: "", stderr: String(error.message ?? "") });
      },
    );
  });
}

/** What a failed `gh` run says about the next attempt: "missing", "limited" (an hour) or "failed" (five minutes). */
export function classifyFailure(result) {
  if (result.missing) return "missing";
  const text = String(result.stderr ?? "").slice(0, 4000);
  // Exit 4 is gh's "requires authentication"; the rest is read from its words.
  if (result.code === 4 || /gh auth login|bad credentials|HTTP 401|authentication|SAML|rate limit|HTTP 429|too many requests|abuse detection/i.test(text)) return "limited";
  return "failed";
}

// --- the worker ------------------------------------------------------------

function directoryOf(agent) {
  const cwd = typeof agent?.cwd === "string" ? agent.cwd.replace(/\/+$/, "") : "";
  return cwd && path.isAbsolute(cwd) && !cwd.includes("\0") ? cwd : "";
}

function gate(max) {
  let active = 0;
  const waiting = [];
  const release = () => {
    active -= 1;
    waiting.shift()?.();
  };
  return async (task) => {
    if (active >= max) await new Promise((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      release();
    }
  };
}

/**
 * Pull-request status for the agents of a snapshot. `annotate(agents)` returns
 * them with `pullRequest` added where a good answer is cached, never waits and
 * never throws; it is also the only thing that starts work, so a bridge nobody
 * is looking at asks GitHub nothing. The clock, the git program and the `gh`
 * runner are what a test swaps.
 */
export function createPullRequests({ gitBin = "git", ghBin = "gh", now = Date.now, runGh, ghTimeoutMs = GH_TIMEOUT_MS } = {}) {
  const places = new Map(); // directory -> { root, at, busy }
  const checkouts = new Map(); // checkout root -> { info, at, busy }
  const entries = new Map(); // "owner/name#branch" -> entry
  const controller = new AbortController();
  const resolving = gate(MAX_RESOLVES);
  const asking = { active: 0 };
  let closed = false;
  let lastInterest = 0;
  let pausedUntil = 0;
  let missingUntil = 0;

  const execute = runGh ?? ((args, options) => runGhProcess(ghBin, args, options));

  const git = (args, cwd) => resolving(() => runGit(gitBin, args, { cwd, env: gitEnvironment(), signal: controller.signal, maxBuffer: 64 * 1024, timeout: GIT_TIMEOUT_MS }));
  const lineOf = (result) => (result.failed ? "" : result.stdout.toString("utf8").replace(/\n+$/, ""));

  async function readPlace(directory) {
    const top = lineOf(await git(["rev-parse", "--show-toplevel"], directory));
    return top && path.isAbsolute(top) ? top : null;
  }

  // The upstream of the checkout's current branch, from git's own config and
  // nothing else: no fetch, no network, no `ls-remote`. Null unless it names
  // a GitHub repository.
  async function readCheckout(root) {
    const head = lineOf(await git(["symbolic-ref", "--quiet", "HEAD"], root));
    if (!head.startsWith("refs/heads/")) return null;
    const localBranch = head.slice("refs/heads/".length);
    if (!BRANCH.test(localBranch) || localBranch.startsWith("-")) return null;
    const remote = lineOf(await git(["config", "--get", `branch.${localBranch}.remote`], root));
    const merge = lineOf(await git(["config", "--get", `branch.${localBranch}.merge`], root));
    if (!REMOTE.test(remote) || remote.startsWith("-") || !merge.startsWith("refs/heads/")) return null;
    const branch = merge.slice("refs/heads/".length);
    if (!BRANCH.test(branch) || branch.startsWith("-")) return null;
    const repository = parseGithubRemote(lineOf(await git(["remote", "get-url", remote], root)));
    return repository ? { localBranch, branch, repository } : null;
  }

  // GitHub names are case-insensitive; a branch name is not.
  const keyOf = (info) => `${info.repository.owner}/${info.repository.name}`.toLowerCase() + `#${info.branch}`;

  function entryFor(info) {
    const key = keyOf(info);
    let entry = entries.get(key);
    if (!entry) {
      entry = { key, repository: info.repository, branch: info.branch, pr: null, goodAt: 0, nextAt: 0, busy: false, seen: 0 };
      entries.set(key, entry);
    }
    return entry;
  }

  function resolve(directory, { force = false } = {}) {
    const place = places.get(directory) ?? { root: null, at: 0, busy: false };
    places.set(directory, place);
    if (place.busy || closed) return;
    place.busy = true;
    (async () => {
      try {
        const root = await readPlace(directory);
        place.root = root;
        place.at = now();
        if (!root) return;
        const known = checkouts.get(root) ?? { info: null, at: 0, busy: false };
        checkouts.set(root, known);
        const age = now() - known.at;
        if (known.busy || age < (force ? MIN_RESOLVE_MS : CHECKOUT_TTL_MS)) return;
        known.busy = true;
        try {
          known.info = await readCheckout(root);
        } finally {
          known.at = now();
          known.busy = false;
        }
        if (known.info) entryFor(known.info);
      } catch {
        // Not a checkout, git missing or slow: nothing is shown for it.
      } finally {
        place.busy = false;
        pump();
      }
    })();
  }

  async function ask(entry) {
    const args = pullListArgs(entry.repository, entry.branch);
    if (!args) return { kind: "failed" };
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(ghTimeoutMs + 5_000)]);
    let result;
    try {
      result = await execute(args, { signal, timeout: ghTimeoutMs });
    } catch (error) {
      result = error?.code === "ENOENT" ? { missing: true } : { code: 1, stderr: "" };
    }
    if (result.aborted) return { kind: "aborted" };
    if (result.missing) return { kind: "missing" };
    if (result.timedOut || result.capped || result.code !== 0) return { kind: classifyFailure(result) };
    let list;
    try {
      list = JSON.parse(result.stdout);
    } catch {
      return { kind: "failed" };
    }
    if (!Array.isArray(list)) return { kind: "failed" };
    return { kind: "ok", pr: choosePullRequest(list, { repository: entry.repository, branch: entry.branch }) };
  }

  function refresh(entry) {
    entry.busy = true;
    asking.active += 1;
    ask(entry)
      .then((outcome) => {
        const at = now();
        if (outcome.kind === "ok") {
          entry.pr = outcome.pr;
          entry.goodAt = at;
          entry.nextAt = at + REFRESH_MS;
        } else if (outcome.kind === "missing") {
          missingUntil = at + GH_MISSING_RECHECK_MS;
          entry.nextAt = missingUntil;
        } else if (outcome.kind === "limited") {
          // Authentication and rate limits are the host's, not this branch's.
          pausedUntil = at + LONG_BACKOFF_MS;
          entry.nextAt = pausedUntil;
        } else if (outcome.kind === "failed") {
          entry.nextAt = at + BACKOFF_MS;
        }
      })
      .catch(() => {
        entry.nextAt = now() + BACKOFF_MS;
      })
      .finally(() => {
        entry.busy = false;
        asking.active -= 1;
        pump();
      });
  }

  // Starts what is due, as many as there are free slots. Called after every
  // snapshot and every finished job; it has no timer of its own.
  function pump() {
    if (closed) return;
    const at = now();
    if (at - lastInterest > INTEREST_MS || at < pausedUntil || at < missingUntil) return;
    for (const entry of entries.values()) {
      if (asking.active >= MAX_GH) return;
      if (!entry.busy && entry.nextAt <= at) refresh(entry);
    }
  }

  function evict(directories) {
    for (const directory of places.keys()) if (!directories.has(directory)) places.delete(directory);
    const roots = new Set([...places.values()].map((place) => place.root));
    for (const root of checkouts.keys()) if (!roots.has(root)) checkouts.delete(root);
    const wanted = new Set();
    for (const known of checkouts.values()) if (known.info) wanted.add(keyOf(known.info));
    for (const key of entries.keys()) if (!wanted.has(key)) entries.delete(key);
    // Bounds, for a host with a great many panes: the oldest go first.
    for (const map of [places, checkouts, entries]) {
      const limit = map === entries ? MAX_ENTRIES : MAX_CHECKOUTS;
      while (map.size > limit) map.delete(map.keys().next().value);
    }
  }

  function lookup(agent, directory, at) {
    const place = places.get(directory);
    if (!place || at - place.at >= CHECKOUT_TTL_MS) resolve(directory);
    const known = place?.root ? checkouts.get(place.root) : undefined;
    const info = known?.info;
    if (!info) return null;
    // The agent's own branch label is fresher than the cache: when they
    // disagree the checkout has moved, so read it again and show nothing.
    if (typeof agent.branch === "string" && agent.branch && agent.branch !== info.localBranch) {
      resolve(directory, { force: true });
      return null;
    }
    // Also re-creates an entry the size bound pushed out, so it is asked again.
    const entry = entryFor(info);
    if (!entry.goodAt || at - entry.goodAt > STALE_MS) return null;
    entry.seen = at;
    return entry.pr;
  }

  return {
    annotate(agents) {
      try {
        if (closed || !Array.isArray(agents)) return agents;
        const at = now();
        // No `gh` on this host: nothing is read, spawned or shown until the recheck.
        if (at < missingUntil) return agents;
        lastInterest = at;
        const directories = new Set();
        const annotated = agents.map((agent) => {
          const directory = directoryOf(agent);
          if (!directory) return agent;
          directories.add(directory);
          const pr = lookup(agent, directory, at);
          return pr ? { ...agent, pullRequest: { number: pr.number, readiness: pr.readiness, url: pr.url } } : agent;
        });
        evict(directories);
        pump();
        return annotated;
      } catch {
        return agents;
      }
    },
    /** Stops everything: running `gh` and git processes are killed and nothing starts again. */
    close() {
      closed = true;
      controller.abort();
      places.clear();
      checkouts.clear();
      entries.clear();
    },
    /** For tests: how many branches are cached and how many `gh` processes are running. */
    stats: () => ({
      entries: entries.size,
      checkouts: checkouts.size,
      places: places.size,
      running: asking.active,
      working: asking.active + [...places.values()].filter((place) => place.busy).length,
    }),
  };
}
