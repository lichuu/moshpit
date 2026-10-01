import { test, expect, isPhone, openApp, STORE_KEY } from "../fixtures";

test.describe("responsive shell", () => {
  test("phones get bottom navigation, wide layouts get a rail", async ({ demo }, testInfo) => {
    const nav = demo.getByRole("navigation", { name: "Primary" });
    await expect(nav).toBeVisible();
    // The same destinations either way; only the chrome differs. Assert the
    // destinations rather than a button count — the rail carries an extra
    // control that bottom navigation does not.
    for (const destination of [/moshpit/i, /inbox/i, /hosts/i]) {
      await expect(nav.getByRole("button", { name: destination }).first()).toBeVisible();
    }

    const box = await nav.boundingBox();
    const viewport = demo.viewportSize()!;
    expect(box).not.toBeNull();
    if (isPhone(testInfo)) {
      // Bottom navigation: a wide, short strip in the lower half. Measured
      // against the viewport rather than a magic pixel row.
      expect(box!.width).toBeGreaterThan(viewport.width * 0.7);
      expect(box!.y).toBeGreaterThan(viewport.height / 2);
    } else {
      // A rail down the side: taller than it is wide, and at the left edge.
      expect(box!.x).toBeLessThan(200);
      expect(box!.height).toBeGreaterThan(box!.width);
    }
  });

  test("a wide layout shows the list and the detail pane together", async ({ demo }, testInfo) => {
    test.skip(isPhone(testInfo), "a phone shows one at a time, with Back");
    await demo.getByText("migrate", { exact: true }).first().click();
    // Both visible at once is the whole point of the wide layout, and it is
    // why Back does not exist here.
    await expect(demo.getByRole("heading", { name: "migrate" })).toBeVisible();
    await expect(demo.getByText("auth-rewrite").first()).toBeVisible();
    await expect(demo.getByRole("button", { name: "Back", exact: true })).toHaveCount(0);
  });
});

test.describe("boot status", () => {
  test("shows a centred message and spinner while the bridge probe is pending", async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), "centring is measured against the wide viewport");
    // Never fulfil the probe, so the boot state stays on screen to be measured.
    await page.route("**/api/auth-info", () => {});
    await page.goto("/?demo=1");

    const status = page.getByRole("status");
    await expect(status).toBeVisible();
    await expect(status.getByText("Connecting to your herd…")).toBeVisible();

    const viewport = page.viewportSize()!;
    const message = await status.locator("div").first().boundingBox();
    expect(message).not.toBeNull();
    expect(
      Math.abs(message!.x + message!.width / 2 - viewport.width / 2),
      "boot message must be horizontally centred",
    ).toBeLessThan(8);
    await expect(status.locator("svg").first()).toBeVisible();
  });
});

test.describe("settings persistence", () => {
  test("a second tab does not clobber settings the first one changed", async ({ demo, context }) => {
    const settings = (page: import("@playwright/test").Page) =>
      page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key) ?? "{}")?.state?.settings ?? null,
        STORE_KEY,
      );

    // A second tab on the same origin shares local storage, so onboarding is
    // already complete for it — going through openDemo would hang on a Next
    // button that is not there.
    const second = await context.newPage();
    await second.goto("/?demo=1", { waitUntil: "networkidle" });
    await expect.poll(() => settings(second)).not.toBeNull();

    // Change a setting in the first tab only.
    await demo.getByRole("button", { name: /hosts/i }).first().click();
    await demo.getByRole("button", { name: "Set prefix ctrl plus a" }).click();
    await expect.poll(async () => (await settings(demo))?.prefix).toBe("ctrl+a");

    // The idle tab must not write its stale copy back over that. Only the tab
    // that changed a setting writes it.
    await second.waitForTimeout(500);
    expect((await settings(second))?.prefix ?? (await settings(demo))?.prefix).toBe("ctrl+a");
    await second.close();
  });

  test("an idle tab does not write back over hosts another tab saved", async ({ page }) => {
    await openApp(page, { demo: false });
    const host = { id: "elsewhere", label: "Elsewhere", transport: "tailscale", user: "", hostname: "127.0.0.1", port: 1, demo: false, tailnetUrl: "http://127.0.0.1:1" };
    await page.evaluate(({ key, host }) => {
      const raw = JSON.parse(localStorage.getItem(key) ?? "{}");
      raw.state = { ...raw.state, hosts: [host] };
      localStorage.setItem(key, JSON.stringify(raw));
    }, { key: STORE_KEY, host });

    // Outlast the 1.8 s runtime tick, which changes nothing here.
    await page.waitForTimeout(4000);
    const hosts = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "{}").state.hosts, STORE_KEY);
    expect(hosts).toEqual([host]);
  });
});

test.describe("waiting badge", () => {
  test("the tab title counts the agents waiting on you", async ({ demo }) => {
    await expect(demo).toHaveTitle(/^\(\d+\) moshpit$/);
    const count = Number((await demo.title()).match(/\d+/)![0]);
    await expect(
      demo.getByRole("navigation", { name: "Primary" }).getByText(String(count), { exact: true }).first(),
    ).toBeVisible();
  });
});
