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

const attached = (page: Page, label?: string) => page.getByText(label ? `Attached to ${label}` : /^Attached to /);

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
});
