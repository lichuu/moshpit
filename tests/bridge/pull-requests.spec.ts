import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect, openApp, seedHosts, loginBridge, pairBridge, isPhone } from "../fixtures";

// C9: the pull-request pill. The checkouts are real temporary repositories
// whose upstream is a made-up GitHub address (config only, nothing is fetched),
// and a fake `gh` on PATH prints fixture JSON and logs what it was asked.

const made: string[] = [];
test.afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e", ...args], { cwd, stdio: "pipe" });

function scratch() {
  const dir = mkdtempSync(path.join(tmpdir(), "moshpit-pr-e2e-"));
  made.push(dir);
  return dir;
}

const LONG = "feature/session-refresh-with-an-unreasonably-long-branch-name-for-tokens";

/** A checkout on `branch`; with `upstream` it tracks that address under the same name. */
function checkout(branch: string, upstream: string | null) {
  const root = path.join(scratch(), "checkout");
  mkdirSync(root);
  run(root, "init", "-q", "-b", branch);
  writeFileSync(path.join(root, "a.txt"), "one\n");
  run(root, "add", "-A");
  run(root, "commit", "-q", "-m", "base");
  if (upstream) {
    run(root, "remote", "add", "origin", upstream);
    run(root, "config", `branch.${branch}.remote`, "origin");
    run(root, "config", `branch.${branch}.merge`, `refs/heads/${branch}`);
  }
  return root;
}

const pull = (number: number, head: string, over: Record<string, unknown> = {}) => ({
  number,
  state: "OPEN",
  isDraft: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: "APPROVED",
  statusCheckRollup: [{ __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS" }],
  headRefName: head,
  headRepositoryOwner: { id: "x", login: "example" },
  url: `https://github.com/example/web-app/pull/${number}`,
  updatedAt: "2026-10-09T10:00:00Z",
  ...over,
});

const panes = ["ready", "pending", "blocked", "bare"] as const;

/** A fake `gh`: logs its argv, then answers from fixtures keyed by the --head value. */
function fakeGh(answers: Record<string, unknown[]>) {
  const dir = scratch();
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  const log = path.join(dir, "gh.log");
  const file = path.join(bin, "gh");
  const cases = Object.entries(answers)
    .map(([head, list]) => `  ${JSON.stringify(head)}) printf '%s\\n' ${JSON.stringify(JSON.stringify(list))} ;;`)
    .join("\n");
  writeFileSync(
    file,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
head=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--head" ]; then head="$2"; fi
  shift
done
case "$head" in
${cases}
  *) echo '[]' ;;
esac
`,
  );
  chmodSync(file, 0o755);
  return { bin, calls: () => { try { return readFileSync(log, "utf8").split("\n").filter(Boolean); } catch { return []; } } };
}

type Fixture = { cwd: string; branch: string };

function herdrFor(fixtures: Record<(typeof panes)[number], Fixture>) {
  const agents = panes.map((name, index) => ({
    pane_id: `w1:p${index + 1}`, agent: "codex", agent_status: "idle", cwd: fixtures[name].cwd, workspace_id: "w1", terminal_title: "codex", revision: 1,
  }));
  const snapshot = JSON.stringify({ result: { snapshot: { agents } } });
  const list = JSON.stringify({
    result: { panes: agents.map((a, index) => ({ pane_id: a.pane_id, label: panes[index], terminal_id: `term_${index}`, cwd: a.cwd, workspace_id: "w1" })) },
  });
  const worktrees = panes
    .map((name) => {
      const answer = JSON.stringify({ result: { worktrees: [{ path: fixtures[name].cwd, branch: fixtures[name].branch }] } });
      return `  "worktree list --cwd ${fixtures[name].cwd}") echo '${answer}' ;;`;
    })
    .join("\n");
  return `
case "$*" in
  "api snapshot"*) echo '${snapshot}' ;;
  "pane list"*) echo '${list}' ;;
${worktrees}
  *) echo '{}' ;;
esac`;
}

function world() {
  const upstream = "https://github.com/example/web-app.git";
  const fixtures = {
    ready: { cwd: checkout("feature/ready", upstream), branch: "feature/ready" },
    pending: { cwd: checkout(LONG, upstream), branch: LONG },
    blocked: { cwd: checkout("feature/conflicts", upstream), branch: "feature/conflicts" },
    bare: { cwd: checkout("feature/local-only", null), branch: "feature/local-only" },
  };
  const gh = fakeGh({
    "feature/ready": [pull(101, "feature/ready")],
    [LONG]: [pull(102, LONG, { reviewDecision: "REVIEW_REQUIRED", statusCheckRollup: [{ __typename: "CheckRun", name: "build", status: "IN_PROGRESS", conclusion: "" }] })],
    "feature/conflicts": [pull(103, "feature/conflicts", { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" })],
    // The fork's PR of the same name must never be shown.
    "feature/local-only": [pull(999, "feature/local-only", { headRepositoryOwner: { login: "stranger" } })],
  });
  return { fixtures, gh, herdr: herdrFor(fixtures) };
}

type Host = { url: string; port: number };

async function openList(page: Page, bridge: Host) {
  await openApp(page, { demo: false });
  const token = await loginBridge(page, bridge.url);
  await pairBridge(page, bridge.url, token);
  await seedHosts(page, [{
    id: "e2e", label: "E2E", transport: "tailscale", user: "",
    hostname: "127.0.0.1", port: bridge.port, demo: false, tailnetUrl: bridge.url,
  }], "e2e");
  await expect(page.getByRole("button", { name: /^ready/ }).first()).toBeVisible({ timeout: 20_000 });
}

const card = (page: Page, name: string) => page.locator(".agent-card", { hasText: name }).first();
/** A card and its pill share a wrapper; each project here holds one agent, so its header carries the same pill first. */
const cardPill = (page: Page, name: string | RegExp) => page.getByRole("link", { name }).last();
const headerPill = (page: Page, number: number) => page.getByTestId("pull-request").filter({ hasText: `#${number}` }).first();

test.describe("Pull request status", () => {
  test("shows the PR beside the branch, by readiness, and nothing without an upstream", async ({ page, bridge }, testInfo) => {
    const { gh, herdr } = world();
    const host = await bridge({ herdr, env: { PATH: `${gh.bin}:${process.env.PATH}` } });
    await openList(page, host);

    const ready = cardPill(page, "Pull request 101, ready to merge");
    const pending = cardPill(page, /^Pull request 102, .*pending/);
    const blocked = cardPill(page, /^Pull request 103, blocked/);
    for (const link of [ready, pending, blocked]) await expect(link).toBeVisible({ timeout: 30_000 });
    // Each of these projects holds one agent, so its header speaks for the same
    // PR, when the list column has the room (a phone's does, the wide layout's
    // does not, and the cards carry the pill there).
    await expect(page.getByTestId("pull-request").filter({ hasText: "#101" })).toHaveCount(2);
    await expect(headerPill(page, 101)).toHaveAttribute("aria-label", "Pull request 101, ready to merge");
    await expect(headerPill(page, 103).locator("[data-readiness]")).toHaveAttribute("data-readiness", "blocked");
    if (isPhone(testInfo)) await expect(headerPill(page, 101)).toBeVisible();
    else await expect(headerPill(page, 101)).toBeHidden();
    await expect(ready).toHaveText("#101");
    await expect(pending).toHaveText("#102");
    await expect(blocked).toHaveText("#103");
    await expect(ready).toHaveAttribute("title", "Pull request 101, ready to merge");
    await expect(ready.locator("[data-readiness]")).toHaveAttribute("data-readiness", "ready");
    await expect(pending.locator("[data-readiness]")).toHaveAttribute("data-readiness", "pending");
    await expect(blocked.locator("[data-readiness]")).toHaveAttribute("data-readiness", "blocked");

    // The three colours are three different ones, from the theme.
    const colours = await Promise.all([ready, pending, blocked].map((link) => link.locator("[data-readiness]").evaluate((element) => getComputedStyle(element).color)));
    expect(new Set(colours).size).toBe(3);

    // The branch is still there, and the checkout with no upstream has no pill
    // (not even the fork's PR that gh would have returned).
    await expect(card(page, "bare")).toContainText("feature/local-only");
    await expect(card(page, "bare").locator("..").getByTestId("pull-request")).toHaveCount(0);
    await expect(page.getByTestId("pull-request")).toHaveCount(6);
    expect(gh.calls().some((call) => call.includes("feature/local-only"))).toBe(false);
    // No query ever says anything but what git configured.
    for (const call of gh.calls()) expect(call).toMatch(/^pr list --repo github\.com\/example\/web-app --head \S+ --state all --limit 20 --json number,state,/);
  });

  test("the pill is a new-tab link that leaves the card alone", async ({ page, bridge, context }, testInfo) => {
    const { gh, herdr } = world();
    await context.route("https://github.com/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<title>fixture</title>" }));
    const host = await bridge({ herdr, env: { PATH: `${gh.bin}:${process.env.PATH}` } });
    await openList(page, host);
    const link = cardPill(page, /^Pull request 103, /);
    await expect(link).toBeVisible({ timeout: 30_000 });
    await expect(link).toHaveAttribute("href", "https://github.com/example/web-app/pull/103");
    await expect(link).toHaveAttribute("target", "_blank");
    const rel = (await link.getAttribute("rel")) ?? "";
    expect(rel.split(/\s+/).sort()).toEqual(["noopener", "noreferrer"]);

    const opened = context.waitForEvent("page");
    await link.click();
    const popup = await opened;
    expect(popup.url()).toBe("https://github.com/example/web-app/pull/103");
    // The click did not select the agent: a phone is still on the list, and a
    // wide layout has not moved its selection to this card.
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
    await expect(card(page, "blocked")).not.toHaveAttribute("aria-pressed", "true");
    if (isPhone(testInfo)) await expect(page.getByRole("button", { name: "More actions" })).toHaveCount(0);
    await popup.close();
  });

  test("a tight card truncates the branch, not the pill, and the card is no taller", async ({ page, bridge }, testInfo) => {
    const { gh, herdr } = world();
    const host = await bridge({ herdr, env: { PATH: `${gh.bin}:${process.env.PATH}` } });
    await openList(page, host);
    const pending = cardPill(page, /^Pull request 102, /);
    await expect(pending).toBeVisible({ timeout: 30_000 });
    // Measure once the list has stopped changing.
    await expect(page.getByTestId("pull-request")).toHaveCount(6, { timeout: 30_000 });
    await pending.scrollIntoViewIfNeeded();

    const long = card(page, "pending");
    const branch = long.getByText(LONG);
    const truncated = await branch.evaluate((element) => element.scrollWidth > element.clientWidth);
    if (isPhone(testInfo)) expect(truncated).toBe(true);
    // The pill is whole and inside the card whatever happens to the branch.
    const pillBox = (await pending.boundingBox())!;
    const cardBox = (await long.boundingBox())!;
    expect(pillBox.x).toBeGreaterThanOrEqual(cardBox.x);
    expect(pillBox.x + pillBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width);
    const branchBox = (await branch.boundingBox())!;
    expect(branchBox.x + branchBox.width).toBeLessThanOrEqual(pillBox.x + 1);
    // Same row: vertically within the branch's line.
    expect(Math.abs(pillBox.y + pillBox.height / 2 - (branchBox.y + branchBox.height / 2))).toBeLessThan(4);

    // Taller by nothing than a card without one.
    const readyCard = card(page, "ready");
    const bareCard = card(page, "bare");
    expect((await readyCard.boundingBox())!.height).toBeCloseTo((await bareCard.boundingBox())!.height, 0);

    // The tap area reaches 20 px above and below the pill's centre.
    const centre = { x: pillBox.x + pillBox.width / 2, y: pillBox.y + pillBox.height / 2 };
    for (const dy of [-20, 0, 20]) {
      const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("a")?.getAttribute("aria-label") ?? null, { x: centre.x, y: centre.y + dy });
      expect(hit, `dy ${dy}`).toMatch(/^Pull request 102/);
    }
    if (isPhone(testInfo)) {
      const page_ = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
      expect(page_.scroll).toBeLessThanOrEqual(page_.width);
    }
  });

  test("gh is asked once per branch, not once per refresh", async ({ page, bridge }) => {
    const { gh, herdr } = world();
    const host = await bridge({ herdr, env: { PATH: `${gh.bin}:${process.env.PATH}` } });
    await openList(page, host);
    await expect(page.getByTestId("pull-request")).toHaveCount(6, { timeout: 30_000 });
    // The app polls the snapshot every couple of seconds; gh is not part of that.
    await page.waitForTimeout(6_000);
    const heads = gh.calls().map((call) => /--head (\S+)/.exec(call)![1]);
    expect(heads.sort()).toEqual(["feature/conflicts", "feature/ready", LONG].sort());
  });

  test("a host without gh shows nothing", async ({ page, bridge }) => {
    const { herdr } = world();
    // A PATH holding only what the fake herdr and the bridge's git reads need.
    const tools = scratch();
    for (const tool of ["bash", "git", "env"]) {
      const found = execFileSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim();
      symlinkSync(found, path.join(tools, tool));
    }
    const host = await bridge({ herdr, env: { PATH: tools } });
    await openList(page, host);
    await page.waitForTimeout(4_000);
    await expect(page.getByTestId("pull-request")).toHaveCount(0);
    await expect(card(page, "ready")).toContainText("feature/ready");
  });
});
