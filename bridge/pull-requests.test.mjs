import assert from "node:assert/strict";
import test from "node:test";
import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  BACKOFF_MS,
  GH_MISSING_RECHECK_MS,
  INTEREST_MS,
  LONG_BACKOFF_MS,
  MAX_GH,
  PR_FIELDS,
  REFRESH_MS,
  STALE_MS,
  choosePullRequest,
  classifyFailure,
  createPullRequests,
  parseGithubRemote,
  pullListArgs,
  readinessOf,
} from "./pull-requests.mjs";
import { cleanup, git, repo, scratch } from "./git-fixtures.mjs";

test.after(cleanup);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const REPO = { owner: "example", name: "web-app" };

// --- remote URLs -----------------------------------------------------------

test("parses every GitHub remote form it accepts", () => {
  const accepted = [
    "https://github.com/example/web-app.git",
    "https://github.com/example/web-app",
    "https://github.com/example/web-app/",
    "HTTPS://GitHub.com/example/web-app.git",
    "https://deploy-user@github.com/example/web-app.git",
    "https://github.com:443/example/web-app.git",
    "git@github.com:example/web-app.git",
    "git@github.com:example/web-app",
    "ssh://git@github.com/example/web-app.git",
    "ssh://git@github.com:22/example/web-app.git",
    "ssh://git@ssh.github.com:443/example/web-app.git",
  ];
  for (const url of accepted) assert.deepEqual(parseGithubRemote(url), REPO, url);
  assert.deepEqual(parseGithubRemote("git@github.com:example-org/my.repo_v2.git"), { owner: "example-org", name: "my.repo_v2" });
});

test("refuses every remote that is not plainly a GitHub repository", () => {
  const refused = [
    "",
    "origin",
    "/srv/git/web-app.git",
    "../web-app",
    "file:///srv/git/web-app.git",
    "http://github.com/example/web-app.git",
    "git://github.com/example/web-app.git",
    "https://gitlab.com/example/web-app.git",
    "https://github.example.com/example/web-app.git",
    "https://github.com.evil.example/example/web-app.git",
    "https://evilgithub.com/example/web-app.git",
    "https://github.com@evil.example/example/web-app.git",
    "https://github.com:8443/example/web-app.git",
    "git@gitlab.com:example/web-app.git",
    "git@github.example.com:example/web-app.git",
    "git@github.com:/example/web-app.git",
    "other@github.com:example/web-app.git",
    "ssh://git@github.com:2222/example/web-app.git",
    "ssh://git@ssh.github.com:2222/example/web-app.git",
    "ssh://root@github.com/example/web-app.git",
    "https://github.com/example",
    "https://github.com/example/web-app/extra",
    "https://github.com/example/web-app/pull/3",
    "https://github.com/example/web-app.git?x=1",
    "https://github.com/example/web-app.git#frag",
    "https://github.com/example/../web-app",
    "https://github.com/-example/web-app",
    "https://github.com/example/web app",
    "https://github.com/example/web%2Fapp",
    "https://github.com/exa mple/web-app",
    "git@github.com:example/web-app.git extra",
    "ext::sh -c id",
    null,
    undefined,
    42,
  ];
  for (const url of refused) assert.equal(parseGithubRemote(url), null, String(url));
});

// --- readiness -------------------------------------------------------------

const run = (name, conclusion, status = "COMPLETED") => ({ __typename: "CheckRun", name, workflowName: "CI", status, conclusion, startedAt: "2026-10-09T10:00:00Z", completedAt: "2026-10-09T10:05:00Z", detailsUrl: "https://example.test/run" });
const status = (context, state) => ({ __typename: "StatusContext", context, state, targetUrl: "https://example.test/status", startedAt: "2026-10-09T10:00:00Z" });
const pull = (overrides = {}) => ({
  number: 12,
  state: "OPEN",
  isDraft: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: "",
  statusCheckRollup: [],
  headRefName: "main",
  headRepositoryOwner: { id: "MDQ6VXNlcjE=", login: "example", name: "Example Org" },
  url: "https://github.com/example/web-app/pull/12",
  updatedAt: "2026-10-09T10:00:00Z",
  ...overrides,
});

test("readiness follows its documented precedence", () => {
  const cases = [
    // [label, overrides, expected]
    ["merged", { state: "MERGED", mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN", statusCheckRollup: [run("build", "FAILURE")] }, "merged"],
    ["merged beats draft", { state: "MERGED", isDraft: true }, "merged"],
    ["closed", { state: "CLOSED", mergeable: "CONFLICTING" }, "closed"],
    ["draft beats every open signal", { isDraft: true, mergeable: "CONFLICTING", mergeStateStatus: "DRAFT", reviewDecision: "CHANGES_REQUESTED", statusCheckRollup: [run("build", "FAILURE")] }, "draft"],
    ["conflicts", { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }, "blocked"],
    ["dirty merge state alone", { mergeStateStatus: "DIRTY" }, "blocked"],
    ["conflicts beat running checks", { mergeable: "CONFLICTING", statusCheckRollup: [run("build", "", "IN_PROGRESS")] }, "blocked"],
    ["one failing check among passing ones", { mergeStateStatus: "UNSTABLE", statusCheckRollup: [run("lint", "SUCCESS"), run("docs", "NEUTRAL"), run("e2e", "SKIPPED"), run("unit", "FAILURE")] }, "blocked"],
    ["failing beats a running check", { statusCheckRollup: [run("unit", "TIMED_OUT"), run("e2e", "", "IN_PROGRESS")] }, "blocked"],
    ["cancelled and startup failure fail", { statusCheckRollup: [run("a", "CANCELLED")] }, "blocked"],
    ["a status that errored", { statusCheckRollup: [status("ci/legacy", "ERROR")] }, "blocked"],
    ["a status that failed", { statusCheckRollup: [status("ci/legacy", "FAILURE")] }, "blocked"],
    ["changes requested with every check green", { reviewDecision: "CHANGES_REQUESTED", statusCheckRollup: [run("unit", "SUCCESS")] }, "blocked"],
    ["a check still running", { mergeStateStatus: "UNSTABLE", statusCheckRollup: [run("unit", "SUCCESS"), run("e2e", "", "IN_PROGRESS")] }, "pending"],
    ["a check queued", { statusCheckRollup: [run("e2e", "", "QUEUED")] }, "pending"],
    ["a status pending", { statusCheckRollup: [status("ci/legacy", "PENDING")] }, "pending"],
    ["a status expected", { statusCheckRollup: [status("ci/legacy", "EXPECTED")] }, "pending"],
    ["a check asking for action", { statusCheckRollup: [run("deploy", "ACTION_REQUIRED")] }, "pending"],
    ["review required with every check green", { reviewDecision: "REVIEW_REQUIRED", mergeStateStatus: "BLOCKED", statusCheckRollup: [run("unit", "SUCCESS")] }, "pending"],
    ["mergeable not computed yet", { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }, "pending"],
    ["behind its base", { mergeStateStatus: "BEHIND" }, "pending"],
    ["blocked by a rule", { mergeStateStatus: "BLOCKED" }, "pending"],
    ["empty rollup, clean", {}, "ready"],
    ["mixed passing conclusions, approved", { reviewDecision: "APPROVED", mergeStateStatus: "HAS_HOOKS", statusCheckRollup: [run("unit", "SUCCESS"), run("docs", "NEUTRAL"), run("e2e", "SKIPPED"), status("ci/legacy", "SUCCESS")] }, "ready"],
    ["no merge state reported", { mergeStateStatus: undefined }, "ready"],
    ["no rollup field at all", { statusCheckRollup: undefined }, "ready"],
  ];
  for (const [label, overrides, expected] of cases) assert.equal(readinessOf(pull(overrides)), expected, label);
});

test("an unreadable check never makes a PR look ready", () => {
  assert.equal(readinessOf(pull({ statusCheckRollup: [null, {}] })), "pending");
  assert.equal(readinessOf(pull({ statusCheckRollup: [run("x", "SOMETHING_NEW")] })), "pending");
});

// --- choosing the PR -------------------------------------------------------

const choose = (list, branch = "main") => choosePullRequest(list, { repository: REPO, branch });

test("a fork's branch of the same name is not this branch's PR", () => {
  const fork = pull({ headRepositoryOwner: { login: "stranger" } });
  assert.equal(choose([fork]), null);
  assert.equal(choose([pull({ headRepositoryOwner: null })]), null);
  assert.equal(choose([pull({ headRepositoryOwner: {} })]), null);
  // The owner's own PR beside the stranger's: the owner's.
  assert.equal(choose([fork, pull({ number: 7, url: "https://github.com/example/web-app/pull/7" })]).number, 7);
  // GitHub logins are case-insensitive.
  assert.equal(choose([pull({ headRepositoryOwner: { login: "Example" } })]).number, 12);
});

test("only the asked-for head branch and repository count", () => {
  assert.equal(choose([pull({ headRefName: "feature/other" })]), null);
  assert.equal(choose([pull({ headRefName: "Main" })]), null);
  assert.equal(choose([pull({ url: "https://github.com/example/other-repo/pull/12" })]), null);
  assert.equal(choose([pull({ url: "https://github.com/example/web-app/pull/13" })]), null);
  assert.equal(choose([pull({ url: "http://github.com/example/web-app/pull/12" })]), null);
  assert.equal(choose([pull({ url: "https://evil.example/example/web-app/pull/12" })]), null);
  assert.equal(choose([pull({ url: "https://github.com.evil.example/example/web-app/pull/12" })]), null);
  assert.equal(choose([pull({ url: "javascript:alert(1)" })]), null);
  assert.equal(choose([pull({ url: "https://github.com/example/web-app/pull/12?x=1" })]), null);
  assert.equal(choose([pull({ number: 0, url: "https://github.com/example/web-app/pull/0" })]), null);
  assert.equal(choose([pull({ number: "12" })]), null);
  assert.equal(choose([pull({ state: "WEIRD" })]), null);
  assert.equal(choose("not a list"), null);
  assert.equal(choose([null, 3, "x"]), null);
});

test("what is sent is rebuilt from validated parts, not gh's own text", () => {
  const chosen = choose([pull({ url: "https://github.com/Example/Web-App/pull/12" })]);
  assert.deepEqual(chosen, { number: 12, readiness: "ready", url: "https://github.com/example/web-app/pull/12" });
});

test("several PRs on one head: open, then merged, then closed, then the newest", () => {
  const closed = pull({ number: 1, state: "CLOSED", url: "https://github.com/example/web-app/pull/1", updatedAt: "2026-10-09T12:00:00Z" });
  const merged = pull({ number: 2, state: "MERGED", url: "https://github.com/example/web-app/pull/2", updatedAt: "2026-10-09T11:00:00Z" });
  const oldMerged = pull({ number: 3, state: "MERGED", url: "https://github.com/example/web-app/pull/3", updatedAt: "2026-10-01T11:00:00Z" });
  const open = pull({ number: 4, url: "https://github.com/example/web-app/pull/4", updatedAt: "2026-09-01T00:00:00Z" });
  const newerOpen = pull({ number: 5, url: "https://github.com/example/web-app/pull/5", updatedAt: "2026-09-02T00:00:00Z" });
  assert.equal(choose([closed, merged, oldMerged, open]).number, 4);
  assert.equal(choose([open, newerOpen, merged]).number, 5);
  assert.equal(choose([closed, oldMerged, merged]).number, 2);
  assert.equal(choose([oldMerged, closed]).number, 3);
  assert.equal(choose([closed]).readiness, "closed");
});

// --- argv ------------------------------------------------------------------

test("the gh argv is literal and refuses anything that could be an option or a shell word", () => {
  assert.deepEqual(pullListArgs(REPO, "feature/login"), [
    "pr", "list", "--repo", "github.com/example/web-app", "--head", "feature/login", "--state", "all", "--limit", "20", "--json", PR_FIELDS,
  ]);
  assert.equal(PR_FIELDS, "number,state,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,headRefName,headRepositoryOwner,url,updatedAt");
  for (const branch of ["-x", "--web", "a b", "a;b", "a$(id)", "a`id`", "a|b", "a\nb", "", "x".repeat(201)]) assert.equal(pullListArgs(REPO, branch), null, branch);
  for (const bad of [{ owner: "-x", name: "web-app" }, { owner: "example", name: "-web" }, { owner: "a/b", name: "web-app" }, { owner: "example", name: ".." }, null]) {
    assert.equal(pullListArgs(bad, "main"), null, JSON.stringify(bad));
  }
});

test("failures are classified from gh's exit status and words", () => {
  assert.equal(classifyFailure({ missing: true }), "missing");
  assert.equal(classifyFailure({ code: 4, stderr: "" }), "limited");
  assert.equal(classifyFailure({ code: 1, stderr: "To get started with GitHub CLI, please run:  gh auth login" }), "limited");
  assert.equal(classifyFailure({ code: 1, stderr: "HTTP 401: Bad credentials (https://api.github.com/graphql)" }), "limited");
  assert.equal(classifyFailure({ code: 1, stderr: "HTTP 403: API rate limit exceeded for user ID 1." }), "limited");
  assert.equal(classifyFailure({ code: 1, stderr: "GraphQL: API rate limit already exceeded for user ID 1." }), "limited");
  assert.equal(classifyFailure({ code: 1, stderr: "HTTP 429: Too Many Requests" }), "limited");
  assert.equal(classifyFailure({ code: 1, stderr: "error connecting to api.github.com" }), "failed");
  assert.equal(classifyFailure({ code: 1, stderr: "Could not resolve to a Repository with the name 'example/gone'." }), "failed");
  assert.equal(classifyFailure({ timedOut: true }), "failed");
  assert.equal(classifyFailure({ capped: true }), "failed");
});

// --- the worker ------------------------------------------------------------

/** A checkout on `main` whose upstream is `url` (config only: nothing is fetched). */
async function checkout({ url = "https://github.com/example/web-app.git", remoteBranch = "main", name = "work" } = {}) {
  const dir = await repo({ "a.txt": "one\n" }, { name });
  if (url) {
    git(dir, "remote", "add", "origin", url);
    git(dir, "config", "branch.main.remote", "origin");
    git(dir, "config", "branch.main.merge", `refs/heads/${remoteBranch}`);
  }
  return dir;
}

const agentAt = (cwd, id = "w1:p1", branch = "main") => ({ id, cwd, branch, name: "codex" });

function harness({ answers, ...options } = {}) {
  const clock = { t: 1_000_000_000 };
  const calls = [];
  let live = 0;
  let peak = 0;
  const hold = [];
  const runGh = async (args, context) => {
    calls.push({ args, context });
    live += 1;
    peak = Math.max(peak, live);
    try {
      if (options.hang) await new Promise((resolve) => hold.push(resolve));
      const next = typeof answers === "function" ? answers(args, calls.length) : answers;
      if (next instanceof Error) throw next;
      return next ?? { code: 0, stdout: "[]", stderr: "" };
    } finally {
      live -= 1;
    }
  };
  const worker = createPullRequests({ now: () => clock.t, runGh, ...options });
  return { worker, clock, calls, hold, peak: () => peak };
}

const ok = (...pulls) => ({ code: 0, stdout: JSON.stringify(pulls), stderr: "" });
const idle = async (worker) => {
  for (let i = 0; i < 500; i += 1) {
    if (worker.stats().working === 0) return;
    await sleep(10);
  }
  throw new Error("worker never went idle");
};
/** One snapshot, the background work it starts, and a second snapshot to read the result. */
async function look(worker, agents) {
  worker.annotate(agents);
  await idle(worker);
  const shown = worker.annotate(agents);
  await idle(worker);
  return shown;
}
const pullOf = (agents) => agents.map((agent) => agent.pullRequest);

test("shows the PR for a checkout whose upstream is a GitHub repository", async () => {
  const dir = await checkout();
  const { worker, calls } = harness({ answers: ok(pull()) });
  const agents = [agentAt(dir)];
  const first = worker.annotate(agents);
  // The first snapshot is never held up or changed.
  assert.deepEqual(first, agents);
  assert.ok(!(first instanceof Promise));
  await idle(worker);
  const shown = await look(worker, agents);
  assert.deepEqual(pullOf(shown), [{ number: 12, readiness: "ready", url: "https://github.com/example/web-app/pull/12" }]);
  assert.deepEqual(Object.keys(shown[0].pullRequest), ["number", "readiness", "url"]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, pullListArgs(REPO, "main"));
  assert.equal(calls[0].args.includes("--token"), false);
  worker.close();
});

test("asks for the branch's name on the remote, not its local name", async () => {
  const dir = await checkout({ remoteBranch: "feature/login" });
  const { worker, calls } = harness({ answers: ok(pull({ headRefName: "feature/login" })) });
  const shown = await look(worker, [agentAt(dir)]);
  assert.equal(calls[0].args[calls[0].args.indexOf("--head") + 1], "feature/login");
  assert.equal(shown[0].pullRequest.number, 12);
  worker.close();
});

test("fails closed: no upstream, a gone remote, a non-GitHub remote or a detached HEAD ask nothing", async () => {
  const noUpstream = await checkout({ url: null });
  const noRemoteUrl = await checkout();
  git(noRemoteUrl, "config", "branch.main.remote", "elsewhere");
  const urlRemote = await checkout();
  git(urlRemote, "config", "branch.main.remote", "https://github.com/example/web-app.git");
  const dashRemote = await checkout();
  git(dashRemote, "remote", "rename", "origin", "up");
  git(dashRemote, "config", "branch.main.remote", "--upload-pack=x");
  const noMerge = await checkout();
  git(noMerge, "config", "--unset", "branch.main.merge");
  const tagMerge = await checkout({ remoteBranch: "main" });
  git(tagMerge, "config", "branch.main.merge", "refs/tags/v1");
  const gitlab = await checkout({ url: "https://gitlab.com/example/web-app.git" });
  const enterprise = await checkout({ url: "git@github.example.com:example/web-app.git" });
  const local = await checkout({ url: "/srv/git/web-app.git" });
  const http = await checkout({ url: "http://github.com/example/web-app.git" });
  const detached = await checkout();
  git(detached, "checkout", "-q", "--detach");
  const notGit = await scratch();

  const { worker, calls } = harness({ answers: ok(pull()) });
  const dirs = [noUpstream, noRemoteUrl, urlRemote, dashRemote, noMerge, tagMerge, gitlab, enterprise, local, http, detached, notGit, "/does/not/exist", "relative/path", ""];
  const agents = dirs.map((dir, index) => agentAt(dir, `w1:p${index}`, ""));
  const shown = await look(worker, agents);
  assert.equal(calls.length, 0);
  assert.deepEqual(pullOf(shown).filter(Boolean), []);
  assert.equal(worker.stats().entries, 0);
  worker.close();
});

test("a fork's PR of the same branch name is never shown", async () => {
  const dir = await checkout();
  const fork = pull({ headRepositoryOwner: { login: "stranger" }, number: 99, url: "https://github.com/example/web-app/pull/99" });
  const { worker, calls } = harness({ answers: ok(fork) });
  const shown = await look(worker, [agentAt(dir)]);
  assert.equal(calls.length, 1);
  assert.equal(shown[0].pullRequest, undefined);
  worker.close();
});

test("several panes in one checkout, or on one branch, share one query", async () => {
  const dir = await checkout();
  const { worker, calls } = harness({ answers: ok(pull()) });
  const agents = [agentAt(dir, "w1:p1"), agentAt(path.join(dir, "sub"), "w1:p2"), agentAt(dir, "w1:p3")];
  const shown = await look(worker, agents);
  assert.equal(calls.length, 1);
  assert.equal(worker.stats().entries, 1);
  assert.equal(shown.filter((agent) => agent.pullRequest).length, 2);
  worker.close();
});

test("a linked worktree is asked about under its own branch", async () => {
  const main = await checkout();
  const linked = path.join(await scratch(), "linked");
  git(main, "worktree", "add", "-q", "-b", "topic", linked);
  git(main, "config", "branch.topic.remote", "origin");
  git(main, "config", "branch.topic.merge", "refs/heads/topic");
  const { worker, calls } = harness({ answers: (args) => ok(pull({ headRefName: args[args.indexOf("--head") + 1], number: 31, url: "https://github.com/example/web-app/pull/31" })) });
  const shown = await look(worker, [agentAt(linked, "w1:p1", "topic")]);
  assert.equal(calls[0].args[calls[0].args.indexOf("--head") + 1], "topic");
  assert.equal(shown[0].pullRequest.number, 31);
  worker.close();
});

test("an agent whose own branch label disagrees with the cached checkout shows nothing", async () => {
  const dir = await checkout();
  const { worker } = harness({ answers: ok(pull()) });
  assert.equal((await look(worker, [agentAt(dir)]))[0].pullRequest.number, 12);
  assert.equal(worker.annotate([agentAt(dir, "w1:p1", "other-branch")])[0].pullRequest, undefined);
  worker.close();
});

test("refreshes about every 90 seconds and not before", async () => {
  const dir = await checkout();
  const { worker, clock, calls } = harness({ answers: ok(pull()) });
  const agents = [agentAt(dir)];
  await look(worker, agents);
  assert.equal(calls.length, 1);
  const start = clock.t;
  for (const seconds of [10, 45, 89]) {
    clock.t = start + seconds * 1000;
    await look(worker, agents);
  }
  assert.equal(calls.length, 1);
  clock.t = start + REFRESH_MS + 1;
  await look(worker, agents);
  assert.equal(calls.length, 2);
  clock.t += REFRESH_MS - 1000;
  await look(worker, agents);
  assert.equal(calls.length, 2);
  clock.t += 2000;
  await look(worker, agents);
  assert.equal(calls.length, 3);
  worker.close();
});

test("a failure backs off five minutes and keeps the last good result", async () => {
  const dir = await checkout();
  let answer = ok(pull({ statusCheckRollup: [run("e2e", "", "IN_PROGRESS")] }));
  const { worker, clock, calls } = harness({ answers: () => answer });
  const agents = [agentAt(dir)];
  assert.equal((await look(worker, agents))[0].pullRequest.readiness, "pending");
  const start = clock.t;

  answer = { code: 1, stdout: "", stderr: "error connecting to api.github.com" };
  clock.t = start + REFRESH_MS + 1;
  // Failed, but the pill stays.
  assert.equal((await look(worker, agents))[0].pullRequest.readiness, "pending");
  assert.equal(calls.length, 2);

  answer = ok(pull());
  clock.t = start + REFRESH_MS + BACKOFF_MS - 1000;
  assert.equal((await look(worker, agents))[0].pullRequest.readiness, "pending");
  assert.equal(calls.length, 2, "still backing off");
  clock.t = start + REFRESH_MS + BACKOFF_MS + 1000;
  assert.equal((await look(worker, agents))[0].pullRequest.readiness, "ready");
  assert.equal(calls.length, 3);
  worker.close();
});

test("a result is dropped once every refresh for hours has failed", async () => {
  const dir = await checkout();
  let answer = ok(pull());
  const { worker, clock } = harness({ answers: () => answer });
  const agents = [agentAt(dir)];
  await look(worker, agents);
  const start = clock.t;
  answer = { code: 1, stdout: "", stderr: "boom" };
  clock.t = start + STALE_MS - 1000;
  assert.equal((await look(worker, agents))[0].pullRequest.number, 12);
  clock.t = start + STALE_MS + 1000;
  assert.equal((await look(worker, agents))[0].pullRequest, undefined);
  worker.close();
});

test("an authentication or rate-limit failure holds every branch for an hour", async () => {
  const dirs = [];
  for (let i = 0; i < 3; i += 1) dirs.push(await checkout({ url: `https://github.com/example/app-${i}.git`, name: `app${i}` }));
  let answer = ok(pull());
  const { worker, clock, calls } = harness({ answers: () => answer });
  const agents = dirs.map((dir, index) => agentAt(dir, `w1:p${index}`));
  await look(worker, agents);
  await look(worker, agents);
  assert.equal(calls.length, 3);
  const start = clock.t;

  answer = { code: 4, stdout: "", stderr: "To get started with GitHub CLI, please run:  gh auth login" };
  clock.t = start + REFRESH_MS + 1;
  await look(worker, agents);
  // All three are due, two run side by side and are refused; the third is
  // held back, because the refusal was the host's and not one branch's.
  assert.equal(calls.length, 5);
  clock.t = start + REFRESH_MS + LONG_BACKOFF_MS - 60_000;
  await look(worker, agents);
  assert.equal(calls.length, 5);
  answer = ok(pull());
  clock.t = start + REFRESH_MS + LONG_BACKOFF_MS + 1000;
  await look(worker, agents);
  assert.equal(calls.length, 8);
  worker.close();
});

test("a rate limit printed on a plain exit 1 is also an hour", async () => {
  const dir = await checkout();
  const { worker, clock, calls } = harness({ answers: { code: 1, stdout: "", stderr: "HTTP 403: API rate limit exceeded for user ID 1." } });
  const agents = [agentAt(dir)];
  await look(worker, agents);
  const start = clock.t;
  clock.t = start + BACKOFF_MS + 1000;
  await look(worker, agents);
  assert.equal(calls.length, 1);
  clock.t = start + LONG_BACKOFF_MS + 1000;
  await look(worker, agents);
  assert.equal(calls.length, 2);
  worker.close();
});

test("unreadable output is a failure, not a result", async () => {
  const dir = await checkout();
  for (const stdout of ["not json", "{}", "null", ""]) {
    const { worker, calls, clock } = harness({ answers: { code: 0, stdout, stderr: "" } });
    const shown = await look(worker, [agentAt(dir)]);
    assert.equal(shown[0].pullRequest, undefined);
    clock.t += BACKOFF_MS - 1000;
    await look(worker, [agentAt(dir)]);
    assert.equal(calls.length, 1, stdout);
    worker.close();
  }
});

test("a host without gh shows nothing and is not asked again for an hour", async () => {
  const dir = await checkout();
  const { worker, clock, calls } = harness({ answers: { missing: true } });
  const agents = [agentAt(dir)];
  assert.equal((await look(worker, agents))[0].pullRequest, undefined);
  assert.equal(calls.length, 1);
  const start = clock.t;
  for (const step of [1000, REFRESH_MS + 1, BACKOFF_MS + 1, GH_MISSING_RECHECK_MS - 1000]) {
    clock.t = start + step;
    await look(worker, agents);
  }
  assert.equal(calls.length, 1);
  clock.t = start + GH_MISSING_RECHECK_MS + 1000;
  await look(worker, agents);
  assert.equal(calls.length, 2);
  worker.close();
});

test("a runner that throws is a failure and never reaches the caller", async () => {
  const dir = await checkout();
  const { worker, calls } = harness({ answers: new Error("spawn exploded") });
  const shown = await look(worker, [agentAt(dir)]);
  assert.equal(shown[0].pullRequest, undefined);
  assert.equal(calls.length, 1);
  worker.close();
  assert.deepEqual(worker.annotate([agentAt(dir)]), [agentAt(dir)]);
});

test("annotate never throws on strange input", () => {
  const { worker } = harness();
  for (const input of [undefined, null, "x", [null], [{}], [{ cwd: 5 }], [{ cwd: "/a\0b" }]]) {
    assert.doesNotThrow(() => worker.annotate(input));
  }
  worker.close();
});

test("nothing runs until a snapshot is served, and not after interest lapses", async () => {
  const one = await checkout({ name: "one" });
  const two = await checkout({ url: "https://github.com/example/two.git", name: "two" });
  const three = await checkout({ url: "https://github.com/example/three.git", name: "three" });
  const { worker, clock, calls, hold } = harness({ answers: ok(), hang: true });
  // No client: no work, however long the clock runs.
  clock.t += 10 * LONG_BACKOFF_MS;
  await sleep(50);
  assert.equal(calls.length, 0);
  assert.equal(worker.stats().places, 0);

  const agents = [agentAt(one, "w1:p1"), agentAt(two, "w1:p2"), agentAt(three, "w1:p3")];
  worker.annotate(agents);
  for (let i = 0; i < 500 && calls.length < MAX_GH; i += 1) await sleep(10);
  await sleep(100);
  assert.equal(calls.length, MAX_GH, "bounded");
  // The client goes away while the two are in flight: the third must not start.
  clock.t += INTEREST_MS + 1000;
  while (hold.length) hold.shift()();
  await idle(worker);
  await sleep(50);
  assert.equal(calls.length, MAX_GH);
  // It comes back, and the waiting one is started.
  worker.annotate(agents);
  for (let i = 0; i < 500 && calls.length < 3; i += 1) await sleep(10);
  assert.equal(calls.length, 3);
  while (hold.length) hold.shift()();
  worker.close();
});

test("never more than two gh processes at once, and the cache is bounded to live panes", async () => {
  const dirs = [];
  for (let i = 0; i < 5; i += 1) dirs.push(await checkout({ url: `https://github.com/example/app-${i}.git`, name: `app${i}` }));
  const { worker, peak, calls } = harness({
    answers: async () => {
      await sleep(30);
      return ok();
    },
  });
  const agents = dirs.map((dir, index) => agentAt(dir, `w1:p${index}`));
  await look(worker, agents);
  await look(worker, agents);
  assert.equal(calls.length, 5);
  assert.ok(peak() <= MAX_GH, `peak ${peak()}`);
  assert.equal(worker.stats().entries, 5);

  // Panes close: their entries and checkouts go with them.
  worker.annotate(agents.slice(0, 2));
  assert.equal(worker.stats().entries, 2);
  assert.equal(worker.stats().places, 2);
  worker.annotate([]);
  assert.deepEqual([worker.stats().entries, worker.stats().checkouts, worker.stats().places], [0, 0, 0]);
  worker.close();
});

test("a branch switch is followed: the old PR goes and the new branch is asked about", async () => {
  const dir = await checkout();
  git(dir, "checkout", "-q", "-b", "next");
  git(dir, "config", "branch.next.remote", "origin");
  git(dir, "config", "branch.next.merge", "refs/heads/next");
  git(dir, "checkout", "-q", "main");
  const { worker, clock, calls } = harness({
    answers: (args) => ok(pull({ headRefName: args[args.indexOf("--head") + 1], number: args.includes("next") ? 21 : 12, url: `https://github.com/example/web-app/pull/${args.includes("next") ? 21 : 12}` })),
  });
  assert.equal((await look(worker, [agentAt(dir)]))[0].pullRequest.number, 12);
  git(dir, "checkout", "-q", "next");
  clock.t += 10_000;
  const shown = await look(worker, [agentAt(dir, "w1:p1", "next")]);
  assert.equal(shown[0].pullRequest?.number, 21);
  assert.equal(calls.length, 2);
  worker.close();
});

// --- the real gh runner ----------------------------------------------------

async function fakeGh(body) {
  const dir = await scratch();
  const file = path.join(dir, "gh");
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, 0o755);
  return { file, dir };
}

async function withEnv(values, task) {
  const saved = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  Object.assign(process.env, values);
  try {
    return await task();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("the real runner passes the literal argv and a clean environment, and no shell sees it", async () => {
  const hostile = await checkout({ remoteBranch: "feature/$(touch pwned);x" });
  const fine = await checkout({ remoteBranch: "feature/login" });
  const { file, dir: out } = await fakeGh(`printf '%s\\n' "$@" > "$(dirname "$0")/argv"; env > "$(dirname "$0")/env"; echo '[]'`);
  const stray = { GH_HOST: "enterprise.example.com", GH_REPO: "someone/else", GH_DEBUG: "api", DEBUG: "*", GH_FORCE_TTY: "100%", NO_COLOR: "" };
  await withEnv(stray, async () => {
    const worker = createPullRequests({ ghBin: file });
    // The branch has shell metacharacters, so it never reaches gh at all.
    await look(worker, [agentAt(hostile)]);
    await assert.rejects(readFile(path.join(out, "argv")));
    await look(worker, [agentAt(fine)]);
    worker.close();
  });
  assert.deepEqual((await readFile(path.join(out, "argv"), "utf8")).trimEnd().split("\n"), pullListArgs(REPO, "feature/login"));
  const env = Object.fromEntries((await readFile(path.join(out, "env"), "utf8")).trimEnd().split("\n").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
  assert.equal(env.GH_PROMPT_DISABLED, "1");
  assert.equal(env.GH_NO_UPDATE_NOTIFIER, "1");
  assert.equal(env.NO_COLOR, "1");
  for (const name of ["GH_HOST", "GH_REPO", "GH_DEBUG", "DEBUG", "GH_FORCE_TTY"]) assert.equal(env[name], undefined, name);
  // The bridge adds no credential of its own.
  assert.equal(env.GH_TOKEN, process.env.GH_TOKEN);
  assert.equal(env.GITHUB_TOKEN, process.env.GITHUB_TOKEN);
});

test("a gh that hangs is killed and the branch backs off", async () => {
  const dir = await checkout();
  const { file, dir: out } = await fakeGh(`echo $$ > "$(dirname "$0")/pid"\nexec sleep 30`);
  const worker = createPullRequests({ ghBin: file, ghTimeoutMs: 300 });
  const started = Date.now();
  await look(worker, [agentAt(dir)]);
  assert.ok(Date.now() - started < 5000, "did not wait for the sleep");
  const pid = Number((await readFile(path.join(out, "pid"), "utf8")).trim());
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.equal(worker.stats().running, 0);
  worker.close();
});

test("a gh that prints too much is cut off and counts as a failure", async () => {
  const dir = await checkout();
  const { file } = await fakeGh(`head -c 3000000 /dev/zero | tr '\\0' 'x'`);
  const worker = createPullRequests({ ghBin: file });
  const shown = await look(worker, [agentAt(dir)]);
  assert.equal(shown[0].pullRequest, undefined);
  worker.close();
});

test("a missing gh binary is silently off", async () => {
  const dir = await checkout();
  const worker = createPullRequests({ ghBin: "/nonexistent/gh-for-moshpit-tests" });
  const agents = [agentAt(dir)];
  assert.equal((await look(worker, agents))[0].pullRequest, undefined);
  assert.deepEqual(worker.annotate(agents), agents);
  worker.close();
});

test("the real runner reads a real gh answer end to end", async () => {
  const dir = await checkout();
  const { file } = await fakeGh(`echo '${JSON.stringify([pull({ reviewDecision: "APPROVED", statusCheckRollup: [run("unit", "SUCCESS")] })])}'`);
  const worker = createPullRequests({ ghBin: file });
  const shown = await look(worker, [agentAt(dir)]);
  assert.deepEqual(shown[0].pullRequest, { number: 12, readiness: "ready", url: "https://github.com/example/web-app/pull/12" });
  worker.close();
});
