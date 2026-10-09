import type { Page } from "@playwright/test";
import { test, expect, openApp, seedHosts, loginBridge, pairBridge } from "../fixtures";

// S5/S11: a Connect the user pressed announces its success once; startup and
// automatic reconnects stay silent; and an attempt the user has since replaced
// cannot announce, or attach, anything.

const herdr = `
case "$*" in
  "api snapshot"*) echo '{"result":{"snapshot":{"agents":[]}}}' ;;
  *) echo '{}' ;;
esac`;

const profile = (id: string, label: string, bridge: { url: string; port: number }) => ({
  id, label, transport: "tailscale", user: "", hostname: "127.0.0.1", port: bridge.port, demo: false, tailnetUrl: bridge.url,
});

async function enroll(page: Page, url: string) {
  const token = await loginBridge(page, url);
  await pairBridge(page, url, token);
}

// The toast only: the Hosts screen has its own "Connected to {host}" line.
const attached = (page: Page, label?: string) =>
  page.locator("[data-sonner-toast]").filter({ hasText: label ? `Connected to ${label}` : /^Connected to / });

test.describe("connection intent", () => {
  test("an explicit Connect announces once; a startup reconnect is silent", async ({ page, bridge }) => {
    const host = await bridge({ herdr });
    await openApp(page, { demo: false });
    await enroll(page, host.url);
    await seedHosts(page, [profile("a", "Alpha", host)]);

    await page.getByRole("button", { name: /hosts/i }).first().click();
    await page.getByRole("button", { name: "Connect" }).click();
    await expect(attached(page, "Alpha")).toHaveCount(1);

    // Reopening the app reconnects the remembered host on its own.
    await page.reload({ waitUntil: "networkidle" });
    await expect(page.getByText("Alpha · 0 agents")).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(500);
    await expect(attached(page)).toHaveCount(0);
  });

  test("a replaced attempt neither attaches nor announces", async ({ page, bridge }) => {
    const slow = await bridge({ herdr });
    const fast = await bridge({ herdr });
    await openApp(page, { demo: false });
    await enroll(page, slow.url);
    await enroll(page, fast.url);
    await seedHosts(page, [profile("s", "Slow", slow), profile("f", "Fast", fast)]);

    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let snapshots = 0;
    await page.route(`${slow.url}/api/snapshot`, async (route) => {
      snapshots += 1;
      const response = await route.fetch();
      await held;
      await route.fulfill({ response });
    });

    await page.getByRole("button", { name: /hosts/i }).first().click();
    await page.getByRole("button", { name: "Connect" }).nth(0).click();
    await expect.poll(() => snapshots).toBe(1);
    // Connect is disabled while an attempt runs; removing its host is how the
    // user leaves it, and that must free Connect for the other one.
    await page.getByRole("button", { name: "Remove" }).first().click();
    await page.getByRole("button", { name: "Connect" }).click();
    await expect(attached(page, "Fast")).toHaveCount(1);

    // The slow host's snapshot lands after the user moved on.
    release();
    await page.waitForTimeout(1000);
    await expect(attached(page, "Slow")).toHaveCount(0);
    const connected = await page.evaluate(() => JSON.parse(localStorage.getItem("moshpit-v1") ?? "{}").state?.connectedHostId);
    expect(connected).toBe("f");
  });

  test("a failed explicit Connect announces no success", async ({ page, bridge }) => {
    const host = await bridge({ herdr });
    await openApp(page, { demo: false });
    await enroll(page, host.url);
    await seedHosts(page, [profile("a", "Alpha", host)]);
    await page.route(`${host.url}/api/snapshot`, (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "boom", message: "snapshot failed" } }) }),
    );

    await page.getByRole("button", { name: /hosts/i }).first().click();
    await page.getByRole("button", { name: "Connect" }).click();
    await expect(page.getByText("Bridge unreachable").first()).toBeVisible({ timeout: 20_000 });
    await expect(attached(page)).toHaveCount(0);
  });

  test("the success toast lasts 2.5 seconds, not the library default", async ({ page, bridge }) => {
    const host = await bridge({ herdr });
    await openApp(page, { demo: false });
    await enroll(page, host.url);
    await seedHosts(page, [profile("a", "Alpha", host)]);

    await page.getByRole("button", { name: /hosts/i }).first().click();
    await page.getByRole("button", { name: "Connect" }).click();
    const toast = attached(page, "Alpha");
    await expect(toast).toBeVisible();
    // 2.5 s plus the exit animation; the default 4 s would still be on screen.
    await expect(toast).toBeHidden({ timeout: 3600 });
  });

  test("a long hostname wraps inside the toast and stays on screen at 320px", async ({ page, bridge }) => {
    const host = await bridge({ herdr });
    const long = "a-very-long-machine-name-with-no-spaces-in-it-at-all-".repeat(2) + "end";
    await page.setViewportSize({ width: 320, height: 640 });
    await openApp(page, { demo: false });
    await enroll(page, host.url);
    await seedHosts(page, [profile("a", long, host)]);

    await page.getByRole("button", { name: /hosts/i }).first().click();
    await page.getByRole("button", { name: "Connect" }).click();
    const card = page.locator("[data-sonner-toast]").filter({ hasText: "Connected to" });
    await expect(card).toBeVisible();
    // Let the entrance transition finish before measuring.
    await page.waitForTimeout(600);
    const box = (await card.boundingBox())!;
    expect(box.x, "16px margin on the left").toBeGreaterThanOrEqual(15);
    expect(box.x + box.width, "16px margin on the right").toBeLessThanOrEqual(305);
    expect(box.width).toBeLessThanOrEqual(360);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.height, "the name wrapped onto several lines").toBeGreaterThan(60);
    expect(await card.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  });
});
