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
  const button = page.getByRole("button", { name: "Back", exact: true });
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

  test("Working sits above the turn's latest tool group and stays there", async ({ page, bridge }) => {
    const host = await bridge({ herdr });
    const live: Entry[] = [message("m1", "t1", 1), activity("a1", "t2", "running")];
    await serveSessions(page, host.url, { "w1:p1": live });
    await openReader(page, host.url, host.port);

    const working = page.getByRole("status").filter({ hasText: "Working" });
    const group = page.locator('details[data-entry-id="a1"]');
    const above = () => working.evaluate((el) => el.nextElementSibling?.getAttribute("data-entry-id"));
    await expect(group.locator("summary").first()).toHaveText("Running a1");
    await expect(working).toHaveCount(1);
    expect(await above()).toBe("a1");

    // The line does not move when the tool finishes and the agent keeps going.
    live[1] = activity("a1", "t2", "complete");
    await expect(group.locator("summary").first()).toHaveText("Ran a command");
    await expect(working).toHaveCount(1);
    expect(await above()).toBe("a1");
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

  // C2: long user messages sit behind Show more. The choice is a reading, so it
  // survives leaving the agent, holds the reader's place and yields to search.
  test.describe("long user messages", () => {
    const user = (id: string, text: string): Entry => ({ id, turnId: `t-${id}`, kind: "message", role: "user", text });
    /** Exactly `n` characters of prose that wraps like a real message. */
    const prose = (n: number) => {
      let text = "";
      while (text.length < n) text += "lorem ";
      return `${text.slice(0, n - 1)}.`;
    };
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");
    const toggle = (page: Page, id: string) => page.locator(`[data-entry-id="${id}"]`).getByRole("button", { name: /^Show (more|less)$/ });
    const clamp = (page: Page, id: string) => page.locator(`[data-entry-id="${id}"] .message-clamp`);

    test("only user messages past 400 characters or five lines collapse", async ({ page, bridge }) => {
      const host = await bridge({ herdr });
      await serveSessions(page, host.url, {
        "w1:p1": [
          user("short", "Please fix the build."),
          user("chars-400", prose(400)), user("chars-401", prose(401)),
          user("lines-5", lines(5)), user("lines-6", lines(6)),
          message("long-agent", "t9", 12),
        ],
      });
      await openReader(page, host.url, host.port);

      for (const id of ["short", "chars-400", "lines-5", "long-agent"]) await expect(toggle(page, id), `${id} is not collapsed`).toHaveCount(0);
      for (const id of ["chars-401", "lines-6"]) {
        await expect(toggle(page, id), `${id} is collapsed`).toHaveText("Show more");
        await expect(toggle(page, id)).toHaveAttribute("aria-expanded", "false");
      }
      // The clamp really hides text and says so with a fade; the agent's long
      // reply and a short user message have neither.
      await expect(clamp(page, "lines-6")).toHaveAttribute("data-clipped", "true");
      await expect(clamp(page, "short")).toHaveCount(0);
      await expect(clamp(page, "long-agent")).toHaveCount(0);
    });

    test("Show more and Show less toggle with a 44px target, by pointer and keyboard", async ({ page, bridge }) => {
      const host = await bridge({ herdr });
      await serveSessions(page, host.url, { "w1:p1": [user("long", lines(12)), message("m1", "t2", 1)] });
      await openReader(page, host.url, host.port);

      const button = toggle(page, "long");
      const height = () => clamp(page, "long").evaluate((el) => el.getBoundingClientRect().height);
      const collapsedHeight = await height();
      expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      expect((await button.boundingBox())?.width).toBeGreaterThanOrEqual(44);

      await button.click();
      await expect(button).toHaveText("Show less");
      await expect(button).toHaveAttribute("aria-expanded", "true");
      await expect(clamp(page, "long")).toHaveAttribute("data-collapsed", "false");
      await expect(clamp(page, "long")).not.toHaveAttribute("data-clipped", "true");
      expect(await height()).toBeGreaterThan(collapsedHeight + 40);

      await button.focus();
      await page.keyboard.press("Enter");
      await expect(button).toHaveAttribute("aria-expanded", "false");
      await page.keyboard.press("Space");
      await expect(button).toHaveAttribute("aria-expanded", "true");
      await page.keyboard.press("Space");
      await expect(button).toHaveText("Show more");
      expect(await height()).toBeCloseTo(collapsedHeight, 0);
    });

    test("Copy returns the whole message while it is collapsed", async ({ page, bridge }) => {
      const host = await bridge({ herdr });
      // A fence that would be left open if the Markdown source were cut short.
      const text = `Run this:\n\n\`\`\`sh\n${lines(9)}\n\`\`\`\n\nand then read [the docs](https://example.com/docs) before you reply.`;
      await serveSessions(page, host.url, { "w1:p1": [user("long", text)] });
      await openReader(page, host.url, host.port);
      await page.evaluate(() => {
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => { (window as unknown as { __copied: string }).__copied = t; } } });
      });

      await expect(toggle(page, "long")).toHaveText("Show more");
      await page.locator('[data-entry-id="long"]').getByRole("button", { name: "Copy message" }).click();
      expect(await page.evaluate(() => (window as unknown as { __copied: string }).__copied)).toBe(text);
      // The text is only clipped, not cut: the link is still in the document.
      await expect(page.locator('[data-entry-id="long"] a[href="https://example.com/docs"]')).toBeAttached();
    });

    test("the choice survives leaving the agent and coming back", async ({ page, bridge }) => {
      const host = await bridge({ herdr });
      await serveSessions(page, host.url, {
        "w1:p1": [user("opened", lines(8)), user("closed", lines(8)), message("m1", "t2", 1)],
        "w1:p2": [message("x1", "t1", 1)],
      });
      await openReader(page, host.url, host.port);

      await toggle(page, "opened").click();
      await expect(toggle(page, "opened")).toHaveAttribute("aria-expanded", "true");
      // A poll that re-sends the same entries changes nothing.
      await page.waitForTimeout(1200);
      await expect(toggle(page, "opened")).toHaveAttribute("aria-expanded", "true");

      await back(page);
      await openAgent(page, "elsewhere");
      await back(page);
      await openAgent(page, "reader");
      await expect(toggle(page, "opened")).toHaveAttribute("aria-expanded", "true");
      await expect(toggle(page, "closed")).toHaveAttribute("aria-expanded", "false");

      // Closing it again is a return to the default, and that is remembered too.
      await toggle(page, "opened").click();
      await back(page);
      await openAgent(page, "elsewhere");
      await back(page);
      await openAgent(page, "reader");
      await expect(toggle(page, "opened")).toHaveAttribute("aria-expanded", "false");
    });

    test("a paused reader keeps their place when a long message above or at it is toggled", async ({ page, bridge }) => {
      const host = await bridge({ herdr });
      await serveSessions(page, host.url, {
        "w1:p1": [
          message("m1", "t1", 1), user("above", lines(14)), message("m2", "t2", 1), message("m3", "t2", 1),
          user("at", lines(14)), message("m4", "t3", 1), message("m5", "t3", 1), message("m6", "t3", 1), message("m7", "t3", 1), message("m8", "t3", 1), message("m9", "t3", 1), message("m10", "t3", 1),
        ],
      });
      await openReader(page, host.url, host.port);

      const frames = async (entryId: string, act: () => Promise<void>) => {
        const start = await offsetOf(page, entryId);
        if (start === null) throw new Error("anchor missing");
        await page.evaluate(() => { (window as unknown as { __sampling: boolean }).__sampling = true; });
        await startSampling(page, entryId);
        await act();
        await page.waitForTimeout(300);
        const samples = await stopSampling(page);
        const usable = samples.filter((s) => s.offset !== null && !s.clamped);
        expect(usable.length, "frames were sampled").toBeGreaterThan(10);
        return Math.max(...usable.map((s) => Math.abs((s.offset as number) - start)));
      };
      const pane = page.locator(".conversation");
      const height = () => pane.evaluate((el) => el.scrollHeight);

      // Above: the reader is on m3, the tall message sits over it.
      await readAt(page, "m3");
      const before = await height();
      let grown = before;
      const worstAbove = await frames("m3", async () => {
        await toggle(page, "above").evaluate((el) => (el as HTMLButtonElement).click());
        await expect(toggle(page, "above")).toHaveAttribute("aria-expanded", "true");
        grown = await height();
        await toggle(page, "above").evaluate((el) => (el as HTMLButtonElement).click());
        await expect(toggle(page, "above")).toHaveAttribute("aria-expanded", "false");
      });
      expect(worstAbove, "the anchor moved by at most 2px while a message above was toggled").toBeLessThanOrEqual(2);
      expect(grown, "the toggle changed the content height").toBeGreaterThan(before + 40);

      // At: the reader is on the tall message itself and taps its own button.
      await readAt(page, "at");
      const worstAt = await frames("at", async () => {
        await toggle(page, "at").click();
        await expect(toggle(page, "at")).toHaveAttribute("aria-expanded", "true");
        // Expanded, its button is below the fold; a real click would scroll to it, which is the test moving the reader.
        await toggle(page, "at").evaluate((el) => (el as HTMLButtonElement).click());
        await expect(toggle(page, "at")).toHaveAttribute("aria-expanded", "false");
      });
      expect(worstAt, "the message under the reader's thumb stayed put").toBeLessThanOrEqual(2);
    });

    test("search opens a collapsed match, and clearing it returns the saved choice", async ({ page, bridge }) => {
      const host = await bridge({ herdr });
      await serveSessions(page, host.url, {
        "w1:p1": [user("hit", `${lines(9)}\nneedle in the tail`), user("kept-open", `${lines(9)}\nneedle again`), message("m1", "t1", 1)],
      });
      await openReader(page, host.url, host.port);

      await toggle(page, "kept-open").click();
      await expect(toggle(page, "hit")).toHaveAttribute("aria-expanded", "false");

      // The match sits below the clamp; search opens the message, with nothing to toggle.
      const search = page.getByRole("textbox", { name: "Search conversation" });
      await search.fill("needle");
      await expect(toggle(page, "hit")).toHaveCount(0);
      await expect(clamp(page, "hit")).toHaveAttribute("data-collapsed", "false");
      await expect(clamp(page, "hit")).not.toHaveAttribute("data-clipped", "true");
      expect(await clamp(page, "hit").evaluate((el) => el.scrollHeight - el.clientHeight), "nothing is hidden").toBeLessThanOrEqual(1);

      await search.fill("");
      await expect(toggle(page, "hit")).toHaveAttribute("aria-expanded", "false");
      await expect(toggle(page, "kept-open")).toHaveAttribute("aria-expanded", "true");
    });

  });
});
