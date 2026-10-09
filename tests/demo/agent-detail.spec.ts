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

  test("the name gets the row; Rename and Close sit in the Agent actions disclosure", async ({ demo }) => {
    await demo.getByText("postcard-ui", { exact: true }).first().click();
    const heading = demo.getByRole("heading", { name: "postcard-ui" });
    await expect(heading).toBeVisible();
    // The full name fits: nothing truncated.
    expect(await heading.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    // Shell is one tap away on every layout; the rest is behind the disclosure.
    await expect(demo.getByRole("button", { name: "Open shell here" })).toBeVisible();
    await expect(demo.getByRole("button", { name: "Rename agent" })).toBeHidden();

    const more = demo.getByRole("button", { name: "More actions" });
    await more.click();
    await expect(more).toHaveAttribute("aria-expanded", "true");
    const group = demo.getByRole("group", { name: "Agent actions" });
    await expect(group.getByRole("button", { name: "Rename agent" })).toBeVisible();
    await expect(group.getByRole("button", { name: "Close pane" })).toBeVisible();
    // Ordinary buttons in a disclosure, not an ARIA menu.
    await expect(demo.getByRole("menu")).toHaveCount(0);
    // The full title and the pane ID are text a person can select.
    await expect(group.locator("p.select-text")).toHaveCount(2);
    await expect(group.locator("p.select-text").first()).toHaveText("postcard-ui");

    // Escape closes it and hands focus back to its button.
    await demo.keyboard.press("Escape");
    await expect(group).toBeHidden();
    await expect(more).toBeFocused();

    await more.click();
    await heading.click();
    await expect(group).toBeHidden();
  });

  test("Close asks in a dialog that says it ends the pane; Cancel and Escape keep it", async ({ demo }) => {
    await demo.getByText("migrate", { exact: true }).first().click();
    const trigger = await agentAction(demo, "Close pane");
    await trigger.click();

    const dialog = demo.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Close ends the pane");
    // The safe choice holds focus.
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();

    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(demo.getByRole("heading", { name: "migrate" })).toBeVisible();

    await trigger.click();
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await demo.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(demo.getByRole("heading", { name: "migrate" })).toBeVisible();
  });

  test("a close confirmation does not time out, and confirming closes the pane", async ({ demo }) => {
    await demo.getByText("postcard-ui", { exact: true }).first().click();
    await (await agentAction(demo, "Close pane")).click();
    const dialog = demo.getByRole("alertdialog");
    // The old arm-then-tap button disarmed itself after four seconds.
    await demo.waitForTimeout(4500);
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Close pane" }).click();
    await expect(dialog).toBeHidden();
    await expect(demo.getByRole("heading", { name: "postcard-ui" })).toBeHidden();
  });

  test("Back never closes the pane", async ({ demo }, testInfo) => {
    test.skip(!isPhone(testInfo), "Back is phone-only");
    await demo.getByText("migrate", { exact: true }).first().click();
    await demo.getByRole("button", { name: "Back", exact: true }).click();
    await expect(demo.getByText("migrate", { exact: true }).first()).toBeVisible();
    await expect(demo.getByRole("alertdialog")).toHaveCount(0);
  });

  test("header controls stay visible and at least 44px at 320px", async ({ demo }, testInfo) => {
    await demo.setViewportSize({ width: 320, height: 640 });
    await demo.getByText("migrate", { exact: true }).first().click();
    const names = ["Open shell here", "More actions", ...(isPhone(testInfo) ? ["Back"] : [])];
    for (const name of names) {
      const box = await demo.getByRole("button", { name, exact: true }).boundingBox();
      expect(box, `${name} must be laid out`).not.toBeNull();
      expect.soft(box!.height, `${name} height`).toBeGreaterThanOrEqual(44);
      expect.soft(box!.width, `${name} width`).toBeGreaterThanOrEqual(44);
      expect.soft(box!.x + box!.width, `${name} stays inside 320px`).toBeLessThanOrEqual(320);
    }
    const tabs = demo.getByRole("navigation", { name: "Agent views" }).getByRole("button");
    for (let i = 0; i < 3; i += 1) {
      expect((await tabs.nth(i).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    // Rename's own controls are 44px too, and the field keeps its width.
    await (await agentAction(demo, "Rename agent")).click();
    for (const name of ["Cancel rename", "Save rename"]) {
      expect((await demo.getByRole("button", { name }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    expect((await demo.getByRole("textbox", { name: "New name" }).boundingBox())!.width).toBeGreaterThan(80);
  });

  test("rename: Escape and Cancel discard; Enter commits", async ({ demo }) => {
    await demo.getByText("migrate", { exact: true }).first().click();
    await (await agentAction(demo, "Rename agent")).click();
    const input = demo.getByRole("textbox", { name: "New name" });
    await input.fill("discarded");
    await demo.keyboard.press("Escape");
    await expect(input).toBeHidden();
    await expect(demo.getByRole("heading", { name: "migrate" })).toBeVisible();

    await (await agentAction(demo, "Rename agent")).click();
    await input.fill("discarded too");
    await demo.getByRole("button", { name: "Cancel rename" }).click();
    await expect(demo.getByRole("heading", { name: "migrate" })).toBeVisible();

    await (await agentAction(demo, "Rename agent")).click();
    await input.fill("by enter");
    await demo.keyboard.press("Enter");
    await expect(demo.getByRole("heading", { name: "by enter" })).toBeVisible();
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
