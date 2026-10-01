import { test, expect } from "../fixtures";

test("Inbox makes an unparsed reply an insert, not an approval", async ({ demo }) => {
  await demo.getByRole("button", { name: /inbox/i }).first().click();
  const row = demo.locator("article").filter({ hasText: "Should I run prisma migrate? y/n" }).first();
  await expect(row).toBeVisible();
  await expect(row.getByRole("button", { name: "Type yes without submitting" })).toBeVisible();

  await row.getByRole("button", { name: "Type yes without submitting" }).click();
  await expect(row.getByRole("status")).toContainText("Typed into the pane");
  await expect(row.getByRole("button", { name: "Type yes without submitting" })).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Reply" })).toBeVisible();
});

test("Inbox advances the question and choices together", async ({ demo }) => {
  await demo.getByRole("button", { name: /inbox/i }).first().click();
  const row = demo.locator("article").filter({ hasText: "postcard-ui" });

  await expect(row).toContainText("Which deployment experience should we design first?");
  await row.getByRole("button", { name: "1. Own machine (Recommended)" }).click();

  await expect(row).toContainText("How should the machines talk to each other?");
  await expect(row).not.toContainText("Which deployment experience should we design first?");
  await expect(row.getByRole("button", { name: "1. Require Tailscale (Recommended)" })).toBeEnabled();
});
