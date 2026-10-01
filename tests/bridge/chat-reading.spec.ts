import type { Page } from "@playwright/test";
import { test, expect, openApp, seedHosts, loginBridge, pairBridge } from "../fixtures";

// S6: a reader who scrolled up stays on the same message, at the same offset,
// while the conversation changes under them. The session route is stubbed from
// the test so each poll carries exactly the entries a case needs; everything
// else goes through a real, isolated bridge.

type Entry = Record<string, unknown> & { id: string };
const para = "The quick brown fox jumps over the lazy dog, and then it does so again for good measure. ";
const message = (id: string, turn: string, words = 4): Entry => ({ id, turnId: turn, kind: "message", role: "assistant", text: `${id}. ${para.repeat(words)}` });
const activity = (id: string, turn: string, status: string): Entry => ({ id, turnId: turn, kind: "activity", title: `run ${id}`, input: `echo ${id}`, output: "line\n".repeat(12), status });

const herdr = `
case "$*" in
  "api snapshot"*) echo '{"result":{"snapshot":{"agents":[{"pane_id":"w1:p1","agent":"codex","agent_status":"working","cwd":"/repo/app","workspace_id":"w1","terminal_title":"codex","agent_session":{"kind":"id","value":"s1"},"revision":1},{"pane_id":"w1:p2","agent":"codex","agent_status":"idle","cwd":"/repo/other","workspace_id":"w1","terminal_title":"codex","agent_session":{"kind":"id","value":"s2"},"revision":1}]}}}' ;;
  "pane list"*) echo '{"result":{"panes":[{"pane_id":"w1:p1","label":"reader","cwd":"/repo/app","workspace_id":"w1"},{"pane_id":"w1:p2","label":"elsewhere","cwd":"/repo/other","workspace_id":"w1"}]}}' ;;
  "pane read"*) printf 'codex' ;;
  *) echo '{}' ;;
esac`;

/** Serves /api/session from `sessions`, re-sending every entry on every poll. */
async function serveSessions(page: Page, url: string, sessions: Record<string, Entry[]>) {
  await page.route(`${url}/api/session?**`, (route) => {
    const target = new URL(route.request().url()).searchParams.get("target") ?? "";
    const entries = sessions[target] ?? [];
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        kind: "available", agentId: target, sessionId: `stream-${target}`,
        entries, cursor: String(entries.length), before: null, reset: false,
        capabilities: { inputModes: ["send"], stop: false, fit: false },
      }),
    });
  });
}

async function openReader(page: Page, url: string, port: number, label = "reader") {
  await openApp(page, { demo: false });
  const token = await loginBridge(page, url);
  await pairBridge(page, url, token);
  await seedHosts(page, [{ id: "e2e", label: "E2E", transport: "tailscale", user: "", hostname: "127.0.0.1", port, demo: false, tailnetUrl: url }], "e2e");
  await openAgent(page, label);
}

async function openAgent(page: Page, label: string) {
  const card = page.getByRole("button", { name: new RegExp(label) }).first();
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.click();
  await expect(page.locator(".conversation [data-entry-id]").first()).toBeVisible({ timeout: 20_000 });
}

/** Phones open an agent over the list; wider layouts show both, with no Back. */
async function back(page: Page) {
  const button = page.getByRole("button", { name: "Back" });
  if (await button.isVisible()) await button.click();
}

/** Scrolls up with a real gesture until `entryId` sits in the upper part of the pane. */
async function readAt(page: Page, entryId: string) {
  const pane = page.locator(".conversation");
  const box = await pane.boundingBox();
  if (!box) throw new Error("conversation has no box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 40; i += 1) {
    const offset = await offsetOf(page, entryId);
    if (offset !== null && offset > 20 && offset < box.height / 3) {
      // WebKit animates a wheel scroll, so the place is where it stops.
      await pane.evaluate((el) => new Promise<void>((resolve) => {
        let last = el.scrollTop;
        let still = 0;
        const frame = () => {
          still = el.scrollTop === last ? still + 1 : 0;
          last = el.scrollTop;
          if (still >= 10) resolve();
          else requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      }));
      const settled = await offsetOf(page, entryId);
      if (settled !== null && settled > 20 && settled < box.height / 3) return;
      continue;
    }
    await page.mouse.wheel(0, offset !== null && offset < 20 ? -60 : 60 * Math.sign((offset ?? -1) - 20) || -200);
    await page.waitForTimeout(30);
  }
  throw new Error(`could not bring ${entryId} to the top of the pane`);
}

const offsetOf = (page: Page, entryId: string) =>
  page.locator(".conversation").evaluate((el, id) => {
    const card = el.querySelector(`[data-entry-id="${CSS.escape(id)}"]`);
    return card ? card.getBoundingClientRect().top - el.getBoundingClientRect().top : null;
  }, entryId);

/**
 * Records the anchor's offset on every animation frame, the way a reader sees
 * it, not only once the updates have settled. A frame where the scroll range
 * had to clamp is marked, since no anchoring can hold there.
 */
async function startSampling(page: Page, entryId: string) {
  await page.locator(".conversation").evaluate((el, id) => {
    const samples: { offset: number | null; clamped: boolean }[] = [];
    (window as unknown as { __samples: typeof samples }).__samples = samples;
    const tick = () => {
      const card = el.querySelector(`[data-entry-id="${CSS.escape(id)}"]`);
      samples.push({
        offset: card ? card.getBoundingClientRect().top - el.getBoundingClientRect().top : null,
        clamped: el.scrollTop <= 0 || el.scrollTop >= el.scrollHeight - el.clientHeight,
      });
      if ((window as unknown as { __sampling?: boolean }).__sampling !== false) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, entryId);
}

async function stopSampling(page: Page) {
  return page.evaluate(() => {
    (window as unknown as { __sampling: boolean }).__sampling = false;
    return (window as unknown as { __samples: { offset: number | null; clamped: boolean }[] }).__samples;
  });
}

test.describe("stable chat reading", () => {
  test("a paused reader holds the same message through streaming, completion and repeats", async ({ page, bridge }) => {
    const host = await bridge({ herdr });
    const sessions: Record<string, Entry[]> = {
      "w1:p1": [
        message("m1", "t1"), activity("a1", "t2", "running"), activity("a2", "t2", "running"),
        message("m2", "t3"), message("m3", "t3"), message("m4", "t3"), message("m5", "t3"), message("m6", "t3"),
      ],
    };
    await serveSessions(page, host.url, sessions);
    await openReader(page, host.url, host.port);

    await readAt(page, "m3");
    const start = await offsetOf(page, "m3");
    if (start === null) throw new Error("anchor missing");
    await startSampling(page, "m3");

    // The same entries arrive again on every poll: nothing new happened.
    await page.waitForTimeout(1500);
    await expect(page.getByRole("button", { name: "New activity" })).toHaveCount(0);

    // Activity above the reader completes, which rewrites its summary; new
    // messages stream in below, one of them growing across polls.
    const live = sessions["w1:p1"];
    live[1] = activity("a1", "t2", "complete");
    live[2] = activity("a2", "t2", "complete");
    await page.waitForTimeout(700);
    live.push(message("m7", "t4", 1));
    await page.waitForTimeout(700);
    live[live.length - 1] = message("m7", "t4", 8);
    live.push(message("m8", "t4", 6));
    await page.waitForTimeout(1200);

    const samples = await stopSampling(page);
    const usable = samples.filter((s) => s.offset !== null && !s.clamped);
    expect(usable.length, "frames were sampled").toBeGreaterThan(60);
    const worst = Math.max(...usable.map((s) => Math.abs((s.offset as number) - start)));
    expect(worst, "the anchor moved by at most 2px in every frame").toBeLessThanOrEqual(2);
    await expect(page.getByRole("button", { name: "New activity" })).toBeVisible();
  });

  test("a follower keeps following as messages stream, and a view switch keeps a paused place", async ({ page, bridge }) => {
    const host = await bridge({ herdr });
    const sessions: Record<string, Entry[]> = {
      "w1:p1": [message("m1", "t1"), message("m2", "t1"), message("m3", "t1"), message("m4", "t1"), message("m5", "t1")],
    };
    await serveSessions(page, host.url, sessions);
    await openReader(page, host.url, host.port);

    const pane = page.locator(".conversation");
    const fromBottom = () => pane.evaluate((el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight));
    await expect.poll(fromBottom).toBeLessThan(4);
    for (const id of ["m6", "m7", "m8"]) {
      sessions["w1:p1"].push(message(id, "t2", 3));
      await expect(page.locator(`[data-entry-id="${id}"]`)).toBeAttached();
      await expect.poll(fromBottom, `still at the bottom after ${id}`).toBeLessThan(4);
    }
    await expect(page.getByRole("button", { name: "New activity" })).toHaveCount(0);

    await readAt(page, "m4");
    const start = await offsetOf(page, "m4");
    if (start === null) throw new Error("anchor missing");
    await page.getByRole("button", { name: "Terminal view" }).click();
    await expect(pane).toHaveCount(0);
    await page.getByRole("button", { name: "Chat view" }).click();
    await expect.poll(async () => Math.abs(((await offsetOf(page, "m4")) ?? Infinity) - start)).toBeLessThanOrEqual(2);
  });

  test("nested activity choices survive leaving and coming back", async ({ page, bridge }) => {
    const host = await bridge({ herdr });
    const sessions: Record<string, Entry[]> = {
      "w1:p1": [message("m1", "t1", 1), activity("done", "t2", "complete"), activity("busy", "t2", "running"), message("m2", "t3", 1)],
      "w1:p2": [message("x1", "t1", 1)],
    };
    await serveSessions(page, host.url, sessions);
    await openReader(page, host.url, host.port);

    const group = page.locator('details[data-entry-id="done"]');
    const done = page.locator('[data-activity-id="done"]');
    const busy = page.locator('[data-activity-id="busy"]');
    const isOpen = (locator: typeof done) => locator.evaluate((el) => (el as HTMLDetailsElement).open);
    // A turn's tool calls sit behind one line that names what is running now;
    // nothing is expanded until the reader asks.
    await expect(group.locator("summary").first()).toHaveText("Running busy");
    expect(await isOpen(group)).toBe(false);
    expect(await isOpen(busy)).toBe(false);

    // Open the group and the finished call: both differ from the default.
    await group.locator("summary").first().click();
    await done.locator("summary").click();
    expect(await isOpen(group)).toBe(true);
    expect(await isOpen(done)).toBe(true);
    expect(await isOpen(busy)).toBe(false);

    // A poll that re-sends the same entries changes nothing.
    await page.waitForTimeout(1200);
    expect(await isOpen(group)).toBe(true);
    expect(await isOpen(done)).toBe(true);
    expect(await isOpen(busy)).toBe(false);

    // Leave for another agent and come back: the Conversation remounts.
    await back(page);
    await openAgent(page, "elsewhere");
    await back(page);
    await openAgent(page, "reader");
    await expect.poll(() => isOpen(page.locator('details[data-entry-id="done"]'))).toBe(true);
    expect(await isOpen(page.locator('[data-activity-id="done"]'))).toBe(true);
    expect(await isOpen(page.locator('[data-activity-id="busy"]'))).toBe(false);
  });

  test("a turn's tool calls read as one tally across harness naming", async ({ page, bridge }) => {
    const host = await bridge({ herdr });
    const tool = (id: string, title: string, input: string, status = "complete"): Entry => ({ id, turnId: "t2", kind: "activity", title, input, output: "", status });
    const sessions: Record<string, Entry[]> = {
      "w1:p1": [
        message("m1", "t1", 1),
        tool("r1", "Read `/repo/app/a.txt`", ""),
        tool("r2", "Read", JSON.stringify({ file_path: "/repo/app/b.txt" })),
        tool("x1", "Execute `curl -sS http://localhost`", ""),
        tool("x2", "Bash", JSON.stringify({ command: "false" }), "failed"),
        tool("f1", "Fetch: https://example.com/post", ""),
        message("m2", "t3", 1),
      ],
    };
    await serveSessions(page, host.url, sessions);
    await openReader(page, host.url, host.port);

    const group = page.locator('details[data-entry-id="r1"]');
    await expect(group.locator("summary").first()).toHaveText("Read 2 files, ran 2 commands, fetched a page · 1 failed");
    // A failure opens the group and its row so it is not missed.
    expect(await group.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(true);
    await expect(page.locator('[data-activity-id="x2"] summary')).toHaveText("Ranfalsefailed");
    await expect(page.locator('[data-activity-id="r2"] summary')).toHaveText("Read/repo/app/b.txt");
    await expect(page.locator('[data-activity-id="x1"] summary')).toHaveText("Rancurl -sS http://localhost");
  });

  test("a running tool line stands in for the Working indicator", async ({ page, bridge }) => {
    const host = await bridge({ herdr });
    const live: Entry[] = [message("m1", "t1", 1), activity("a1", "t2", "running")];
    await serveSessions(page, host.url, { "w1:p1": live });
    await openReader(page, host.url, host.port);

    const working = page.getByRole("status").filter({ hasText: "Working" });
    await expect(page.locator('details[data-entry-id="a1"] summary').first()).toHaveText("Running a1");
    await expect(working).toHaveCount(0);

    // Between tool calls the agent is still busy, and only Working says so.
    live[1] = activity("a1", "t2", "complete");
    await expect(page.locator('details[data-entry-id="a1"] summary').first()).toHaveText("Ran a command");
    await expect(working).toBeVisible();
  });

  test("search keeps its own position and expansion, and clearing it restores the reader", async ({ page, bridge }) => {
    const host = await bridge({ herdr });
    const sessions: Record<string, Entry[]> = {
      "w1:p1": [
        message("m1", "t1"), activity("a1", "t2", "complete"), message("m2", "t3"), message("m3", "t3"),
        message("m4", "t3"), activity("a2", "t4", "complete"), message("m5", "t5"), message("m6", "t5"),
      ],
    };
    await serveSessions(page, host.url, sessions);
    await openReader(page, host.url, host.port);

    const group = page.locator('details[data-entry-id="a1"]');
    const isOpen = () => group.evaluate((el) => (el as HTMLDetailsElement).open);
    expect(await isOpen()).toBe(false);

    await readAt(page, "m4");
    const start = await offsetOf(page, "m4");
    if (start === null) throw new Error("anchor missing");

    // Search opens every matching group and moves the pane; then the reader
    // scrolls around inside the results.
    const search = page.getByRole("textbox", { name: "Search conversation" });
    await search.fill("run");
    await expect.poll(isOpen).toBe(true);
    const pane = page.locator(".conversation");
    const box = await pane.boundingBox();
    if (!box) throw new Error("conversation has no box");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(200);

    await search.fill("");
    await expect.poll(isOpen, "the forced-open search group closes again").toBe(false);
    await expect.poll(async () => Math.abs(((await offsetOf(page, "m4")) ?? Infinity) - start)).toBeLessThanOrEqual(2);
    await expect(page.getByRole("button", { name: "New activity" })).toHaveCount(0);
  });
});
