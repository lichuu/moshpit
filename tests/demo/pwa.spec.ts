import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, expect, isPhone, ROOT } from "../fixtures";

const DIST = path.join(ROOT, "dist/spa");

test.describe("installable build", () => {
  test.beforeEach(async ({}, testInfo) => {
    test.skip(!isPhone(testInfo), "build artefacts do not vary by viewport");
  });

  test("the service worker is built, not a template", async () => {
    const worker = await readFile(path.join(DIST, "sw.js"), "utf8");
    // The build stamps a real id in; shipping the placeholder means the worker
    // never invalidates and users are pinned to a stale app forever.
    expect(worker).not.toContain("__BUILD_ID__");
    expect(worker.length).toBeGreaterThan(0);
  });

  test("the manifest declares an installable app", async ({ page }) => {
    const response = await page.request.get("/manifest.webmanifest");
    expect(response.ok()).toBeTruthy();
    const manifest = JSON.parse(await response.text());
    expect(manifest.name ?? manifest.short_name).toBeTruthy();
    expect(manifest.start_url).toBeTruthy();
    expect(manifest.display).toBeTruthy();
    expect(Array.isArray(manifest.icons) && manifest.icons.length).toBeTruthy();
  });

  // README promises the app reopens offline after one online visit. It came
  // up blank until 2026-09-25: the worker's asset lookup honoured
  // `Vary: Origin`, and a module script's request carries an Origin header
  // the precache request did not, so every lookup missed.
  test("reopens offline after one online visit", async ({ demo, context }) => {
    // Onboarding has to be done first, or the reload lands on the onboarding
    // screen and proves nothing about caching.
    const page = demo;
    // The worker has to finish installing before it can serve anything.
    await page.waitForFunction(async () => {
      const registration = await navigator.serviceWorker?.getRegistration();
      return Boolean(registration?.active);
    }, undefined, { timeout: 20_000 });

    await context.setOffline(true);
    await page.reload({ waitUntil: "domcontentloaded" });

    // The shell must come back from cache and actually render — the app is
    // client-rendered, so an empty body at domcontentloaded proves nothing.
    // Agent operations still need a bridge; only the app is promised offline.
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible({
      timeout: 20_000,
    });
    await context.setOffline(false);
  });

  // A home-screen app is resumed rather than reloaded, so it only learned of a
  // new release on a cold launch and could run a weeks-old build.
  test("offers a refresh when a release lands while it sits in the background", async ({ demo }) => {
    const page = demo;
    await page.waitForFunction(async () => {
      const registration = await navigator.serviceWorker?.getRegistration();
      return Boolean(registration?.active && navigator.serviceWorker.controller);
    }, undefined, { timeout: 20_000 });
    const file = path.join(DIST, "sw.js");
    const worker = await readFile(file, "utf8");
    try {
      await writeFile(file, `${worker}\n// next release\n`);
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await expect(page.getByRole("button", { name: "Refresh to update" })).toBeVisible({ timeout: 20_000 });
    } finally {
      await writeFile(file, worker);
    }
  });
});

test.describe("waiting for a herd", () => {
  test("a connected host with no agents says so rather than looking broken", async ({ page }) => {
    // No auto-discovered bridge, so onboarding is the manual path.
    await page.route("**/api/vapid", (route) => route.fulfill({ status: 404 }));
    await page.route("**/api/pair", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: '{"deviceId":"d"}' }),
    );
    await page.route("**/api/snapshot", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ hostId: "test", herdrRunning: true, agents: [], kinds: [] }),
      }),
    );

    await page.goto("/", { waitUntil: "networkidle" });
    for (let step = 0; step < 2; step += 1) {
      await page.getByRole("button", { name: "Next", exact: true }).click();
    }
    await page.getByRole("button", { name: "Open moshpit" }).click();

    await page.evaluate(() => {
      const raw = JSON.parse(localStorage.getItem("moshpit-v1") ?? "{}");
      raw.state = {
        ...raw.state,
        hosts: [
          { id: "test", label: "Test", tailnetUrl: location.origin, demo: false },
        ],
        connectedHostId: "test",
      };
      localStorage.setItem("moshpit-v1", JSON.stringify(raw));
    });
    await page.reload({ waitUntil: "networkidle" });

    // An empty herd is a state, not an error: the app should say the herd is
    // empty rather than sit on a spinner.
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
    await expect(page.getByText(/no agents|empty|waiting/i).first()).toBeVisible({
      timeout: 15_000,
    });
  });
});
