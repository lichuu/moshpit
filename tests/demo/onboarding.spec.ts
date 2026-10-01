import { test, expect } from "../fixtures";

async function answerBridgeProbe(page: import("@playwright/test").Page) {
  await page.route("**/api/auth-info", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ protocol: 2, requiredFactors: ["tailscale"] }),
    }),
  );
}

test("a new install shows onboarding when the same-origin bridge is available", async ({ page }) => {
  await answerBridgeProbe(page);
  await page.goto("/?demo=1", { waitUntil: "networkidle" });

  await expect(page.getByRole("heading", { name: "A little space. For your whole herd." })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Primary" })).toHaveCount(0);
});

test("a completed install skips onboarding on later visits", async ({ page }) => {
  await answerBridgeProbe(page);
  await page.goto("/?demo=1", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Skip", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();

  await page.reload({ waitUntil: "networkidle" });

  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "A little space. For your whole herd." })).toHaveCount(0);
  await expect(page.getByText("What's new in moshpit", { exact: true })).toHaveCount(0);
});

test("an existing install sees the current release notice once", async ({ page }) => {
  await answerBridgeProbe(page);
  await page.goto("/?demo=1", { waitUntil: "networkidle" });
  await page.evaluate(() => {
    localStorage.setItem(
      "moshpit-v1",
      JSON.stringify({ state: { onboarded: true }, version: 0 }),
    );
  });
  await page.reload({ waitUntil: "networkidle" });

  await expect(page.getByText("What's new in moshpit", { exact: true })).toBeVisible();
  await expect(page.getByText("Quick replies now collapse, and Send works on the first tap when the keyboard is open.", { exact: true })).toBeVisible();

  await page.reload({ waitUntil: "networkidle" });

  await expect(page.getByText("What's new in moshpit", { exact: true })).toHaveCount(0);
});
