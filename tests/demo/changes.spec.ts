import { test, expect, isPhone } from "../fixtures";

// Demo mode has no bridge, so the Changes sheet shows a made-up checkout.

test.describe("Changes sheet in demo mode", () => {
  test("opens with sample changes and makes no bridge request", async ({ demo }, testInfo) => {
    const requests: string[] = [];
    demo.on("request", (request) => {
      if (request.url().includes("/api/")) requests.push(request.url());
    });
    await demo.getByText("auth-rewrite", { exact: true }).first().click();
    await expect(demo.getByRole("heading", { name: "auth-rewrite" })).toBeVisible();

    if (isPhone(testInfo)) {
      // The header keeps its room: the entry point is in the actions disclosure.
      await expect(demo.getByRole("button", { name: "Changes", exact: true })).toHaveCount(0);
      await demo.getByRole("button", { name: "More actions" }).click();
    }
    await demo.getByRole("button", { name: "Changes", exact: true }).click();

    const sheet = demo.getByRole("dialog", { name: "Changes" });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText("5 files changed")).toBeVisible();
    await expect(sheet.getByText("+17")).toBeVisible();
    await expect(sheet.getByText(/web on session-refresh/)).toBeVisible();

    const renamed = sheet.getByRole("button", { name: /^src\/auth\/tokens\.ts, Renamed, from src\/auth\/token\.ts/ });
    await expect(renamed).toBeVisible();
    await expect(sheet.getByRole("button", { name: /^public\/logo\.png, Modified, binary/ })).toBeVisible();
    await expect(sheet.getByRole("button", { name: /^src\/auth\/session\.test\.ts, Added, untracked/ })).toBeVisible();

    const edited = sheet.getByRole("button", { name: /^src\/auth\/session\.ts, Modified/ });
    await edited.click();
    const diff = sheet.getByRole("group", { name: "Diff of src/auth/session.ts" });
    await expect(diff).toContainText("const SKEW_MS = 30_000;");
    await sheet.getByRole("button", { name: "Refresh changes" }).click();
    await expect(sheet.getByText("5 files changed")).toBeVisible();

    await sheet.getByRole("button", { name: "Close changes" }).click();
    await expect(sheet).toBeHidden();
    expect(requests).toEqual([]);
  });
});
