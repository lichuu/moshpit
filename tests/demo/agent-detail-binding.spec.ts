import type { Page } from "@playwright/test";
import { test, expect, agentAction } from "../fixtures";
import { DEV_URL } from "../../playwright.config";

// A pending rename or close belongs to one pane on one host. The close dialog
// is modal and rename is not, but a snapshot, a host switch or a keyboard jump
// can all change the pane under either, so these drive the store directly the
// way those would, through the dev server where the store module is importable.

const STORE = "/src/lib/moshpit/store.ts";

test.beforeEach(async ({}, testInfo) => {
  test.skip(testInfo.project.name !== "phone", "store-driven; viewport-independent");
});

async function openDevDemo(page: Page) {
  await page.goto(`${DEV_URL}/?demo=1`, { waitUntil: "networkidle" });
  for (let step = 0; step < 2; step += 1) {
    await page.getByRole("button", { name: "Next", exact: true }).click();
  }
  await page.getByRole("button", { name: "Open moshpit" }).click();
  await page.getByRole("navigation", { name: "Primary" }).waitFor();
}

const agentIds = (page: Page) =>
  page.evaluate(async (mod) => {
    const { useMoshpitStore } = await import(mod);
    return useMoshpitStore.getState().agents.map((a: { id: string }) => a.id);
  }, STORE);

const patch = (page: Page, change: { selectAgent?: string; connectedHostId?: string }) =>
  page.evaluate(async ({ mod, change }) => {
    const { useMoshpitStore } = await import(mod);
    const store = useMoshpitStore.getState();
    if (change.selectAgent) store.selectAgent(change.selectAgent);
    if (change.connectedHostId) useMoshpitStore.setState({ connectedHostId: change.connectedHostId });
  }, { mod: STORE, change });

test.describe("connection toast", () => {
  test("overlays the page without moving it, and honours reduced motion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openDevDemo(page);
    const watched = [page.getByRole("navigation", { name: "Primary" }), page.getByRole("heading").first()];
    const measure = async () => ({
      boxes: await Promise.all(watched.map((locator) => locator.boundingBox())),
      scroll: await page.evaluate(() => document.documentElement.scrollHeight),
    });
    const before = await measure();

    await page.evaluate(async (mod) => {
      const { useMoshpitStore } = await import(mod);
      const state = useMoshpitStore.getState();
      const demo = state.hosts.find((h: { demo?: boolean }) => h.demo);
      state.connectHost(demo.id, "explicit");
    }, STORE);
    const card = page.locator("[data-sonner-toast]").filter({ hasText: "Connected to Demo herdr" });
    await expect(card).toBeVisible();
    expect(await measure()).toEqual(before);
    expect(await card.evaluate((el) => getComputedStyle(el).position)).toBe("absolute");
    expect(await card.evaluate((el) => el.closest("[data-sonner-toaster]") && getComputedStyle(el.closest("[data-sonner-toaster]")!).position)).toBe("fixed");
    expect(await card.evaluate((el) => getComputedStyle(el).transitionDuration)).toBe("0s");
    // Polite live region, supplied by the library.
    await expect(page.locator("section[aria-live='polite']")).toHaveCount(1);
  });
});

test.describe("pending detail actions are bound to host and pane", () => {
  test("switching agent dismisses an open close dialog and closes nothing", async ({ page }) => {
    await openDevDemo(page);
    await page.getByText("migrate", { exact: true }).first().click();
    await (await agentAction(page, "Close pane")).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    const before = await agentIds(page);

    await patch(page, { selectAgent: "accent" });
    await expect(page.getByRole("heading", { name: "postcard-ui" })).toBeVisible();
    await expect(dialog).toBeHidden();

    // Coming back must not resurrect it, and no pane was closed meanwhile.
    await patch(page, { selectAgent: "migrate" });
    await expect(page.getByRole("heading", { name: "migrate" })).toBeVisible();
    await expect(dialog).toBeHidden();
    expect(await agentIds(page)).toEqual(before);
  });

  test("the same pane ID on another host is another target", async ({ page }) => {
    await openDevDemo(page);
    await page.getByText("migrate", { exact: true }).first().click();
    await (await agentAction(page, "Close pane")).click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    const before = await agentIds(page);

    await patch(page, { connectedHostId: "another-host" });
    await expect(page.getByRole("alertdialog")).toBeHidden();
    expect(await agentIds(page)).toEqual(before);
  });

  test("switching agent mid-rename drops the draft and renames nothing", async ({ page }) => {
    await openDevDemo(page);
    await page.getByText("migrate", { exact: true }).first().click();
    await (await agentAction(page, "Rename agent")).click();
    await page.getByRole("textbox", { name: "New name" }).fill("half typed");

    await patch(page, { selectAgent: "accent" });
    await expect(page.getByRole("heading", { name: "postcard-ui" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "New name" })).toBeHidden();

    await patch(page, { selectAgent: "migrate" });
    await expect(page.getByRole("heading", { name: "migrate" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "New name" })).toBeHidden();
    await expect(page.getByText("half typed")).toHaveCount(0);
  });
});
