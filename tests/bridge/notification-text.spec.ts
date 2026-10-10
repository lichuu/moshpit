import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect, openApp, seedHosts, loginBridge, pairBridge, type Bridge } from "../fixtures";

// C17: the Hosts screen offers what a notification may show, only while
// notifications are on for this device, and the host keeps the answer with
// the device's subscription.

const herdr = `
case "$*" in
  "api snapshot"*) echo '{"result":{"snapshot":{"agents":[]}}}' ;;
  *) echo '{}' ;;
esac`;

const profile = (bridge: Bridge) => ({
  id: "a", label: "Alpha", transport: "tailscale", user: "", hostname: "127.0.0.1", port: bridge.port, demo: false, tailnetUrl: bridge.url,
});

/** Permission reads as granted and subscribing yields a fixture subscription at a known push host. */
async function stubPush(page: Page) {
  await page.context().addInitScript(() => {
    if (typeof Notification !== "undefined") {
      Object.defineProperty(Notification, "permission", { get: () => "granted" });
      Notification.requestPermission = async () => "granted";
    }
    if (typeof PushManager !== "undefined") {
      PushManager.prototype.subscribe = async () =>
        ({
          toJSON: () => ({
            endpoint: "https://fcm.googleapis.com/fcm/send/fixture-device",
            keys: { p256dh: "BFixtureKey", auth: "fixtureAuth" },
          }),
        }) as unknown as PushSubscription;
    }
  });
}

/** What the host holds for the one enrolled device. */
async function stored(bridge: Bridge) {
  const file = path.join(bridge.dir, "state", "push.json");
  const entries = Object.values(JSON.parse(await readFile(file, "utf8").catch(() => "{}")) as Record<string, { endpoint: string; privacy?: string }>);
  return entries[0] ?? null;
}

async function connected(page: Page, bridge: (options?: { herdr?: string }) => Promise<Bridge>) {
  const host = await bridge({ herdr });
  await stubPush(page);
  await openApp(page, { demo: false });
  await pairBridge(page, host.url, await loginBridge(page, host.url));
  await seedHosts(page, [profile(host)]);
  await page.getByRole("button", { name: /hosts/i }).first().click();
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByRole("button", { name: "Disconnect" })).toBeVisible();
  return host;
}

const group = (page: Page) => page.getByRole("group", { name: "Notification text" });
const option = (page: Page, name: string) => group(page).getByRole("button", { name, exact: true });

test("the choice appears with notifications, defaults to full, and the host keeps each change", async ({ page, bridge }) => {
  const host = await connected(page, bridge);
  await expect(group(page), "nothing to choose while notifications are off").toHaveCount(0);

  await page.getByRole("checkbox", { name: "Notify when an agent blocks" }).check();
  await expect(group(page)).toBeVisible();
  await expect(option(page, "Full")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("A lock screen shows the agent’s name and what it needs.")).toBeVisible();
  await expect.poll(async () => (await stored(host))?.endpoint).toBe("https://fcm.googleapis.com/fcm/send/fixture-device");
  expect((await stored(host))?.privacy, "a new subscription is full by default").toBe("full");

  await option(page, "Agent name only").click();
  await expect(option(page, "Agent name only")).toHaveAttribute("aria-pressed", "true");
  await expect(option(page, "Full")).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByText("A lock screen shows the agent’s name, not what it needs.")).toBeVisible();
  expect((await stored(host))?.privacy).toBe("name");

  await option(page, "Generic").click();
  await expect(option(page, "Generic")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("A lock screen shows only “An agent is blocked.”")).toBeVisible();
  expect((await stored(host))?.privacy).toBe("generic");

  // The choice survives a reload, and reconnecting does not reset it to full.
  await page.reload();
  await page.getByRole("button", { name: /hosts/i }).first().click();
  await expect(option(page, "Generic")).toHaveAttribute("aria-pressed", "true", { timeout: 20_000 });
  expect((await stored(host))?.privacy).toBe("generic");

  await page.getByRole("checkbox", { name: "Notify when an agent blocks" }).uncheck();
  await expect(group(page)).toHaveCount(0);
});

test("a change the host refuses says so and keeps the previous choice", async ({ page, bridge }) => {
  const host = await connected(page, bridge);
  await page.getByRole("checkbox", { name: "Notify when an agent blocks" }).check();
  await option(page, "Agent name only").click();
  await expect(option(page, "Agent name only")).toHaveAttribute("aria-pressed", "true");

  await page.route(`${host.url}/api/push-subscription`, (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "internal_error", message: "The host could not save that." } }),
    }),
  );
  await option(page, "Generic").click();
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Notification text not changed" })).toBeVisible();
  await expect(option(page, "Agent name only")).toHaveAttribute("aria-pressed", "true");
  await expect(option(page, "Generic")).toHaveAttribute("aria-pressed", "false");
  await expect(option(page, "Generic")).toBeEnabled();
  expect((await stored(host))?.privacy, "the host still holds the previous choice").toBe("name");
});
