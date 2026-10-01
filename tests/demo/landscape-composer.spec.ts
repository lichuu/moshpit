import path from "node:path";
import { test, expect, ROOT } from "../fixtures";

const FIXTURE = path.join(ROOT, "tests/fixtures/tiny.png");

test.describe("landscape composer fits", () => {
  async function openAgent(page: import("@playwright/test").Page, name: string | RegExp) {
    await page.goto("/?demo=1", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Skip", exact: true }).click();
    await page.getByRole("navigation", { name: "Primary" }).waitFor();
    await page.getByText(name, { exact: typeof name === "string" }).first().click();
    await page.getByPlaceholder("Message this agent…").waitFor();
  }

  async function composerBoxes(page: import("@playwright/test").Page) {
    return page.evaluate(() => {
      const box = (el: Element | null) => {
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { x: b.x, y: b.y, width: b.width, height: b.height, bottom: b.bottom };
      };
      const $ = (s: string) => document.querySelector(s);
      return {
        viewport: { width: innerWidth, height: innerHeight },
        // The conversation's painted area is its root's box: the scroll box
        // inside it can carry a layout rect that overflows a collapsed root
        // on short viewports, but that overflow is clipped and cannot
        // intercept taps.
        conversation: box($(".conversation")?.parentElement ?? null),
        composerWrap: box($(".composer-wrap")),
        panel: box($(".composer-panel")),
        textarea: box($(".composer-panel textarea")),
        send: box($('.composer-panel [aria-label="Send"]')),
        quickReplies: box($(".quick-replies")),
        blockedBanner: box($(".composer-blocks > div.mb-2")),
        replyKeys: box($('[aria-label="Blocked reply controls"]')),
      };
    });
  }

  test("migrate (blocked) keeps the Send row and textarea inside the viewport", async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await openAgent(page, "migrate");
    const boxes = await composerBoxes(page);
    const { height } = boxes.viewport;
    expect(boxes.send, "Send button").not.toBeNull();
    expect(boxes.textarea, "textarea").not.toBeNull();
    expect(boxes.quickReplies, "quick replies").not.toBeNull();
    // The question card in Chat carries the prompt, so the composer adds no
    // banner that could push the Send row off a landscape phone.
    expect(boxes.blockedBanner, "blocked banner").toBeNull();
    expect(boxes.send!.bottom, "Send row bottom").toBeLessThanOrEqual(height + 1);
    expect(boxes.textarea!.bottom, "textarea bottom").toBeLessThanOrEqual(height + 1);
    expect(boxes.composerWrap!.bottom, "composer bottom").toBeLessThanOrEqual(height + 1);
  });

  test("an idle agent keeps quick replies and the Send row inside the viewport", async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await openAgent(page, "tailscale-docs");
    const boxes = await composerBoxes(page);
    const { height } = boxes.viewport;
    expect(boxes.send, "Send button").not.toBeNull();
    expect(boxes.quickReplies, "quick replies").not.toBeNull();
    expect(boxes.send!.bottom, "Send row bottom").toBeLessThanOrEqual(height + 1);
    expect(boxes.composerWrap!.bottom, "composer bottom").toBeLessThanOrEqual(height + 1);
  });

  test("a blocked typed insertion keeps Enter/Esc and the Send row inside the viewport", async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await openAgent(page, "migrate");
    await page.getByPlaceholder("Message this agent…").fill("y");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByRole("group", { name: "Blocked reply controls" })).toBeVisible();
    const boxes = await composerBoxes(page);
    const { height } = boxes.viewport;
    expect(boxes.replyKeys, "blocked reply controls").not.toBeNull();
    expect(boxes.replyKeys!.bottom).toBeLessThanOrEqual(height + 1);
    expect(boxes.send!.bottom, "Send row bottom").toBeLessThanOrEqual(height + 1);
    expect(boxes.composerWrap!.bottom, "composer bottom").toBeLessThanOrEqual(height + 1);
  });

  test("an attached image keeps the conversation clear of the composer", async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await openAgent(page, "migrate");
    await page
      .locator('input[type="file"]')
      .setInputFiles(FIXTURE);
    const preview = page.getByRole("img", { name: "Attachment preview: tiny.png", exact: true });
    await preview.waitFor();
    const boxes = await composerBoxes(page);
    const { height } = boxes.viewport;
    expect(boxes.send!.bottom, "Send row bottom").toBeLessThanOrEqual(height + 1);
    expect(boxes.composerWrap!.bottom, "composer bottom").toBeLessThanOrEqual(height + 1);
    expect(boxes.conversation, "conversation").not.toBeNull();
    const overlap = boxes.composerWrap!.y - boxes.conversation!.bottom;
    expect(overlap, "conversation/composer gap").toBeGreaterThanOrEqual(-1);
    await page.getByRole("button", { name: "Remove image", exact: true }).click();
    await expect(preview).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  });
});
