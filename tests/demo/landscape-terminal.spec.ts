import { test, expect } from "../fixtures";

test.describe("landscape terminal fits", () => {
  async function openTerminal(page: import("@playwright/test").Page) {
    await page.setViewportSize({ width: 844, height: 390 });
    await page.goto("/?demo=1", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Skip", exact: true }).click();
    await page.getByRole("navigation", { name: "Primary" }).waitFor();
    await page.getByText("migrate", { exact: true }).first().click();
    await page.getByRole("button", { name: "Terminal view", exact: true }).click();
    await page.getByRole("application", { name: /^Pane / }).waitFor();
    await page.locator('[role="application"] pre > div').first().waitFor();
  }

  test("the pane keeps a usable height and the keys and Send stay tappable", async ({ page }) => {
    await openTerminal(page);
    const boxes = await page.evaluate(() => {
      const box = (el: Element | null) => {
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { x: b.x, y: b.y, width: b.width, height: b.height, bottom: b.bottom, right: b.right };
      };
      const pane = document.querySelector<HTMLElement>('[role="application"]');
      const row = pane?.querySelector("pre > div") ?? null;
      const keybar = document.querySelector<HTMLElement>(".terminal-keys");
      const keys = keybar ? [...keybar.querySelectorAll("button")] : [];
      return {
        viewport: { width: innerWidth, height: innerHeight },
        pane: box(pane),
        line: box(row),
        keybar: box(keybar),
        keys: keys.map(box),
        textarea: box(document.querySelector(".composer-panel textarea")),
        send: box(document.querySelector('.composer-panel [aria-label="Send"]')),
        quickReplies: box(document.querySelector(".quick-replies")),
      };
    });
    const { height } = boxes.viewport;
    expect(boxes.pane, "pane").not.toBeNull();
    expect(boxes.line, "a rendered pane row").not.toBeNull();
    expect(boxes.pane!.height, "pane usable height").toBeGreaterThanOrEqual(
      2 * boxes.line!.height - 1,
    );
    expect(boxes.pane!.bottom, "pane bottom").toBeLessThanOrEqual(height + 1);
    expect(boxes.keybar!.bottom, "key bar bottom").toBeLessThanOrEqual(height + 1);
    for (const key of boxes.keys) {
      expect(key, "key button").not.toBeNull();
      expect(key!.width, "key width").toBeGreaterThan(0);
      expect(key!.y, "key top").toBeGreaterThanOrEqual(-1);
      expect(key!.bottom, "key bottom").toBeLessThanOrEqual(height + 1);
    }
    expect(boxes.textarea!.bottom, "textarea bottom").toBeLessThanOrEqual(height + 1);
    expect(boxes.send!.bottom, "Send bottom").toBeLessThanOrEqual(height + 1);
    expect(boxes.quickReplies, "quick replies").not.toBeNull();

    const keybar = page.locator(".terminal-keys");
    const pane = page.getByRole("application", { name: /^Pane / });
    await keybar.getByRole("button", { name: "esc", exact: true }).click();
    await expect(pane).toContainText("[esc]");
    await keybar.getByRole("button", { name: "right", exact: true }).click();
    await expect(pane).toContainText("right");

    await page.getByPlaceholder("Type or dictate terminal input").fill("ls");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(pane).toContainText("> ls");
  });

  test("quick replies open from the key bar, fit the viewport, and a tap reaches the pane", async ({ page }) => {
    await openTerminal(page);
    await page.locator(".terminal-keys").getByRole("button", { name: "Quick replies" }).click();
    const boxes = await page.evaluate(() => {
      const box = (el: Element | null) => {
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { x: b.x, y: b.y, width: b.width, height: b.height, bottom: b.bottom, right: b.right };
      };
      const section = document.querySelector<HTMLElement>('section[aria-label="Quick replies"]');
      return {
        viewport: { width: innerWidth, height: innerHeight },
        send: box(document.querySelector('.composer-panel [aria-label="Send"]')),
        section: box(section),
        buttons: [...(section?.querySelectorAll("button") ?? [])].map((b) => box(b)),
      };
    });
    const { width, height } = boxes.viewport;
    expect(boxes.send!.bottom, "Send bottom").toBeLessThanOrEqual(height + 1);
    expect(boxes.section, "quick replies popover").not.toBeNull();
    // The popover opens upward over the pane; every reply must be on screen.
    expect(boxes.section!.y, "popover top").toBeGreaterThanOrEqual(-1);
    expect(boxes.section!.right, "popover right").toBeLessThanOrEqual(width + 1);
    expect(boxes.section!.x, "popover left").toBeGreaterThanOrEqual(-1);
    for (const button of boxes.buttons) {
      expect(button!.width, "reply width").toBeGreaterThan(0);
      expect(button!.y, "reply top").toBeGreaterThanOrEqual(-1);
      expect(button!.bottom, "reply bottom").toBeLessThanOrEqual(height + 1);
    }

    const pane = page.getByRole("application", { name: /^Pane / });
    await page.getByRole("region", { name: "Quick replies" }).getByRole("button", { name: "skip", exact: true }).click();
    await expect(pane).toContainText("> skip");
  });
});
