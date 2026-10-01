import { test, expect, isPhone, agentAction } from "../fixtures";

test.describe("agent detail header", () => {
  test("renames an agent and the list picks up the new name", async ({ demo }, testInfo) => {
    await demo.getByText("migrate", { exact: true }).first().click();
    await expect(demo.getByRole("heading", { name: "migrate" })).toBeVisible();

    await (await agentAction(demo, "Rename agent")).click();
    const input = demo.getByRole("textbox", { name: "New name" });
    await expect(input).toBeVisible();

    await input.fill("migration v2");
    await demo.getByRole("button", { name: "Save rename" }).click();
    await expect(demo.getByRole("heading", { name: "migration v2" })).toBeVisible();

    // Back exists only on phones; wider layouts already show the list beside
    // the detail pane, so the rename is visible there without navigating.
    if (isPhone(testInfo)) {
      await demo.getByRole("button", { name: "Back", exact: true }).click();
    }
    await expect(demo.getByText("migration v2").first()).toBeVisible();
  });

  test("the rename field has usable width, not zero", async ({ demo }, testInfo) => {
    // Regression: the StatusPill and the Shell/Rename/Close buttons stayed
    // rendered beside the input while renaming. On a phone the row wanted
    // 340px in 282px of space, so the flex child holding the field collapsed
    // to exactly 0px — present in the DOM, focused, and invisible.
    await demo.getByText("migrate", { exact: true }).first().click();
    await (await agentAction(demo, "Rename agent")).click();

    const input = demo.getByRole("textbox", { name: "New name" });
    await expect(input).toBeVisible();
    const box = await input.boundingBox();
    expect(box, "the rename field must have a bounding box").not.toBeNull();
    expect.soft(box!.height).toBeGreaterThan(10);
    expect(
      box!.width,
      `rename field is ${box!.width}px wide on ${testInfo.project.name}`,
    ).toBeGreaterThan(80);

    // It must also actually accept typing, not merely occupy space.
    await input.fill("typed into it");
    await expect(input).toHaveValue("typed into it");
  });

  test("renaming hides the actions that would crowd the field", async ({ demo }) => {
    await demo.getByText("migrate", { exact: true }).first().click();
    await expect(await agentAction(demo, "Close pane")).toBeVisible();

    await (await agentAction(demo, "Rename agent")).click();
    // Cancel and Save are the only sensible actions mid-rename; leaving Close
    // live meant a stray tap could destroy the pane you were renaming.
    await expect(demo.getByRole("button", { name: "Close pane" })).toBeHidden();
    await expect(demo.getByRole("button", { name: "Rename agent" })).toBeHidden();
    await expect(demo.getByRole("button", { name: "More actions" })).toBeHidden();
    await expect(demo.getByRole("button", { name: "Cancel rename" })).toBeVisible();
    await expect(demo.getByRole("button", { name: "Save rename" })).toBeVisible();

    await demo.getByRole("button", { name: "Cancel rename" }).click();
    await expect(await agentAction(demo, "Close pane")).toBeVisible();
  });

  test("closing a pane asks for confirmation first", async ({ demo }) => {
    await demo.getByText("migrate", { exact: true }).first().click();
    await (await agentAction(demo, "Close pane")).click();
    await expect(demo.getByRole("button", { name: "Really close?" })).toBeVisible();
  });

  test("on a phone the name gets the row, and the actions sit in a menu", async ({ demo }, testInfo) => {
    test.skip(!isPhone(testInfo), "wide layouts keep the actions inline");
    await demo.getByRole("button", { name: "postcard-ui" }).click();
    const heading = demo.getByRole("heading", { name: "postcard-ui" });
    await expect(heading).toBeVisible();
    // The full name fits: nothing truncated.
    expect(await heading.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await expect(demo.getByRole("button", { name: "Rename agent" })).toBeHidden();

    await demo.getByRole("button", { name: "More actions" }).click();
    await expect(demo.getByRole("button", { name: "Rename agent" })).toBeVisible();
    await demo.getByRole("heading", { name: "postcard-ui" }).click();
    await expect(demo.getByRole("button", { name: "Rename agent" })).toBeHidden();

    // Close arms in place, and the second tap is the one that closes.
    await (await agentAction(demo, "Close pane")).click();
    await expect(demo.getByRole("button", { name: "Really close?" })).toBeVisible();
    await demo.getByRole("button", { name: "Really close?" }).click();
    await expect(heading).toBeHidden();
  });

  test("Back goes back on the first tap while the keyboard is up", async ({ demo }, testInfo) => {
    test.skip(!isPhone(testInfo), "Back and the soft keyboard are phone-only");
    await demo.getByText("migrate", { exact: true }).first().click();
    const prompt = demo.getByPlaceholder("Message this agent…");
    await prompt.focus();

    // The press must not blur the composer: that closes the keyboard, resizes
    // the app under the finger, and the tap is lost.
    const back = demo.getByRole("button", { name: "Back", exact: true });
    const box = await back.boundingBox();
    await demo.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await demo.mouse.down();
    await expect(prompt).toBeFocused();
    await demo.mouse.up();
    await expect(demo.getByRole("dialog", { name: "Agent detail" })).toHaveCount(0);
  });
});
