import path from "node:path";
import { test, expect, isPhone, ROOT } from "../fixtures";

const FIXTURE = path.join(ROOT, "tests/fixtures/tiny.png");

async function openQuickReplies(page: import("@playwright/test").Page) {
  await page.locator("summary").filter({ hasText: "Quick replies" }).click();
  return page.getByRole("region", { name: "Quick replies" });
}

test.describe("composer", () => {
  test.beforeEach(async ({ demo }) => {
    await demo.getByText("auth-rewrite", { exact: true }).first().click();
    await expect(demo.getByPlaceholder("Message this agent…")).toBeVisible();
  });

  test("a phone unmounts the hidden terminal behind chat", async ({ demo }, testInfo) => {
    test.skip(!isPhone(testInfo), "wide layouts keep both panes mounted on purpose");
    // Leaving the pane mounted behind chat kept a PTY socket open per agent.
    await expect(demo.getByRole("application", { name: /^Pane / })).toHaveCount(0);
  });

  test("typing survives the soft keyboard resizing the viewport", async ({ demo }, testInfo) => {
    test.skip(!isPhone(testInfo), "the soft-keyboard resize only happens on phones");
    const prompt = demo.getByPlaceholder("Message this agent…");
    await prompt.click();
    // A soft keyboard opening is a viewport resize; the draft and focus must
    // both survive it.
    await demo.setViewportSize({ width: 390, height: 500 });
    const text = "Keep the existing behavior and add a focused regression test.";
    await demo.keyboard.insertText(text);
    await expect(prompt).toHaveValue(text);
    await expect(prompt).toBeFocused();

    await demo.setViewportSize({ width: 390, height: 844 });
    await expect(prompt).toHaveValue(text);
  });

  test("the first Send press submits without blurring the textarea", async ({ demo }, testInfo) => {
    test.skip(!isPhone(testInfo), "the soft-keyboard focus path is phone-only");
    const prompt = demo.getByPlaceholder("Message this agent…");
    await prompt.fill("send on the first press");
    await prompt.focus();

    const send = demo.getByRole("button", { name: "Send" });
    const box = await send.boundingBox();
    expect(box, "Send button box").not.toBeNull();
    await demo.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await demo.mouse.down();
    await expect(prompt).toBeFocused();
    await demo.mouse.up();

    await expect(prompt).toHaveValue("");
    await expect(demo.getByText("send on the first press", { exact: true })).toBeVisible();
  });

  for (const name of ["Input tools", "Snippets"]) {
    test(`${name} opens without blurring the composer`, async ({ demo }, testInfo) => {
      const prompt = demo.getByPlaceholder("Message this agent…");
      await prompt.fill("Keep this draft");
      const trigger = demo.getByLabel(name, { exact: true });
      const content = demo.getByRole("button", { name: name === "Snippets" ? "Close snippets" : "Close input tools" });
      await prompt.focus();
      const box = await trigger.boundingBox();
      expect(box).not.toBeNull();
      await demo.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
      await demo.mouse.down();
      await expect(prompt).toBeFocused();
      await demo.mouse.up();
      await expect(content).toBeVisible();
      await expect(prompt).toBeFocused();
      await trigger.click();
      await expect(content).toBeHidden();

      if (isPhone(testInfo)) {
        await prompt.focus();
        await trigger.tap();
        await expect(content).toBeVisible();
        await expect(prompt).toBeFocused();
      } else {
        await trigger.focus();
        await demo.keyboard.press("Enter");
        await expect(content).toBeVisible();
      }
      if (name === "Snippets") {
        const input = demo.getByLabel("Snippet name");
        await input.click();
        await demo.keyboard.insertText("Review");
        await expect(input).toHaveValue("Review");
      }
      await content.click();
      await expect(content).toBeHidden();
      await expect(prompt).toHaveValue("Keep this draft");
    });
  }

  test("a file that is not an image asks first, then adds a quoted fixture path with no request", async ({ demo }) => {
    const calls: string[] = [];
    demo.on("request", (request) => { if (request.url().includes("/api/")) calls.push(request.url()); });
    const prompt = demo.getByPlaceholder("Message this agent…");
    await prompt.fill("see ");
    await demo.locator('input[type="file"]').setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });

    const ask = demo.getByRole("dialog", { name: "Copy this file to the host?" });
    await expect(ask).toContainText("notes.txt");
    await expect(ask).toContainText("stay there after this session");
    await ask.getByRole("button", { name: "Upload" }).click();
    await expect(ask).toBeHidden();
    await expect(prompt).toHaveValue("see '/srv/moshpit/files/3f9a1c/notes.txt'");
    await expect(demo.locator(".composer-file-note")).toContainText("/srv/moshpit/files/3f9a1c/notes.txt");
    await expect(demo.getByRole("button", { name: "Remove image" })).toHaveCount(0);
    expect(calls).toEqual([]);
  });

  test("attaches an image, clears it, and sends it as a line", async ({ demo }) => {
    const file = demo.locator('input[type="file"]');
    await expect(file).not.toHaveAttribute("accept");

    await file.setInputFiles(FIXTURE);
    await expect(demo.getByText("tiny.png")).toBeVisible();
    await expect(demo.getByRole("button", { name: "Send" })).toBeEnabled();

    await demo.getByRole("button", { name: "Remove image" }).click();
    await expect(demo.getByText("tiny.png")).toHaveCount(0);

    await file.setInputFiles(FIXTURE);
    await expect(demo.getByText("tiny.png")).toBeVisible();
    await demo.getByRole("button", { name: "Send" }).click();

    // Chat renders lines as markdown, so the pane line's leading "> " is
    // consumed as blockquote syntax and never appears as text.
    await expect(demo.getByText("[image] tiny.png")).toBeVisible();
  });
});

test.describe("blocked composer", () => {
  test("a live choose dialog answers from Chat and keeps Send off", async ({ demo }) => {
    await demo.getByRole("button", { name: "postcard-ui" }).click();
    await expect(demo.getByPlaceholder("Message this agent…")).toBeVisible();
    await expect(demo.getByRole("button", { name: "Send" })).toBeDisabled();
    // The card already has the printed keys, so the composer must not repeat
    // the Terminal dead-end underneath it.
    await expect(demo.locator(".composer-wrap").getByRole("button", { name: "Answer in Terminal" })).toHaveCount(0);
  });

  test("an unread dialog's card is the only place offering Terminal", async ({ demo }) => {
    await demo.getByRole("button", { name: /^migrate\b/ }).click();
    // The card shows the prompt and the Terminal way out; the composer must
    // not repeat either underneath it.
    await expect(demo.locator('[data-role="question"]').getByRole("button", { name: "Answer in Terminal" })).toBeVisible();
    await expect(demo.getByRole("button", { name: "Answer in Terminal" })).toHaveCount(1);
    await expect(demo.locator(".composer-wrap").getByText("Should I run prisma migrate? y/n")).toHaveCount(0);
    await expect(demo.getByRole("button", { name: "Send" })).toBeEnabled();
  });

  test("a blocked insert surfaces Enter and Esc without submitting", async ({ demo }) => {
    await demo.getByRole("button", { name: /^migrate\b/ }).click();
    const prompt = demo.getByPlaceholder("Message this agent…");
    await prompt.fill("y");
    await demo.getByRole("button", { name: "Send" }).click();

    await expect(demo.getByRole("group", { name: "Blocked reply controls" })).toBeVisible();
    await expect(demo.getByRole("button", { name: "Enter", exact: true })).toBeVisible();
    await expect(demo.getByRole("button", { name: "Esc", exact: true })).toBeVisible();
    await expect(demo.getByText("Should I run prisma migrate? y/n").first()).toBeVisible();
  });
});

test.describe("quick replies", () => {
  test("is collapsed by default and can be expanded again", async ({ demo }) => {
    await demo.getByRole("button", { name: "tailscale-docs" }).click();
    const disclosure = demo.locator("summary").filter({ hasText: "Quick replies" });
    const dock = demo.getByRole("region", { name: "Quick replies" });
    await expect(disclosure).toBeVisible();
    await expect(dock).toBeHidden();

    await disclosure.click();
    await expect(dock).toBeVisible();
    await expect(dock.getByRole("button", { name: "yes", exact: true })).toBeEnabled();
    await expect(dock.getByRole("button", { name: "commit and push", exact: true })).toBeEnabled();

    await disclosure.click();
    await expect(dock).toBeHidden();
  });

  test("sends quick reply text without consuming the saved draft or attachment", async ({ demo }) => {
    await demo.getByRole("button", { name: "tailscale-docs" }).click();
    const prompt = demo.getByPlaceholder("Message this agent…");
    await prompt.fill("keep this draft");
    await demo.locator('input[type="file"]').setInputFiles(FIXTURE);
    await expect(demo.getByText("tiny.png")).toBeVisible();

    const dock = await openQuickReplies(demo);
    await dock.getByRole("button", { name: "yes", exact: true }).click();

    await expect(prompt).toHaveValue("keep this draft");
    await expect(demo.getByText("tiny.png")).toBeVisible();
    await expect(demo.getByText("[image] tiny.png")).toHaveCount(0);
  });

  test("refuses quick replies while a choose dialog owns the keyboard", async ({ demo }) => {
    await demo.getByRole("button", { name: "postcard-ui" }).click();
    const dock = await openQuickReplies(demo);
    await dock.getByRole("button", { name: "yes", exact: true }).click();
    await expect(demo.getByText("This dialog owns the keyboard. Pick an option or answer in Terminal.")).toBeVisible();
  });

  test("types yes into an unread dialog without submitting", async ({ demo }) => {
    await demo.getByRole("button", { name: /^migrate\b/ }).click();
    const dock = await openQuickReplies(demo);
    await dock.getByRole("button", { name: "yes", exact: true }).click();
    await expect(demo.getByRole("group", { name: "Blocked reply controls" })).toBeVisible();
    await expect(demo.getByText("Should I run prisma migrate? y/n").first()).toBeVisible();
  });
});

test.describe("snippets", () => {
  test.beforeEach(async ({ demo }) => {
    await demo.getByText("auth-rewrite", { exact: true }).first().click();
    await expect(demo.getByPlaceholder("Message this agent…")).toBeVisible();
  });

  const openPicker = async (page: import("@playwright/test").Page) => {
    await page.getByLabel("Snippets", { exact: true }).click();
    await expect(page.getByLabel("Snippet name")).toBeVisible();
  };

  test("saves, inserts without sending, and keeps the picker open", async ({ demo }) => {
    const prompt = demo.getByPlaceholder("Message this agent…");
    await prompt.click();
    await demo.keyboard.insertText("Please fix ");

    await openPicker(demo);
    await demo.getByLabel("Snippet name").fill("greet");
    // The text field prefills from the draft.
    await expect(demo.getByLabel("Snippet text")).toHaveValue("Please fix ");
    await demo.getByRole("button", { name: "Save snippet" }).click();

    const insert = demo.getByRole("button", { name: "Insert snippet greet" });
    await expect(insert).toBeVisible();
    await insert.click();
    await expect(prompt).toHaveValue("Please fix Please fix ");
    // Insertion must never submit.
    await expect(demo.getByText("Sending…")).toHaveCount(0);

    // The picker stays open: insertSnippet advances the captured selection so
    // several snippets can go in one after another.
    await expect(demo.getByLabel("Snippet name")).toBeVisible();
    await insert.click();
    await expect(prompt).toHaveValue("Please fix Please fix Please fix ");
  });

  test("has a close button", async ({ demo }) => {
    // <details> has no outside-click dismissal, so without this the only way
    // out was the same small icon that opened it.
    await openPicker(demo);
    await demo.getByRole("button", { name: "Close snippets" }).click();
    await expect(demo.getByLabel("Snippet name")).toBeHidden();
  });

  test("rejects empty fields without discarding what was typed", async ({ demo }) => {
    await openPicker(demo);
    await demo.getByLabel("Snippet name").fill("   ");
    await demo.getByLabel("Snippet text").fill("");
    await demo.getByRole("button", { name: "Save snippet" }).click();

    await expect(demo.getByRole("alert")).toBeVisible();
    await expect(demo.getByLabel("Snippet name")).toHaveValue("   ");
  });

  test("edits and deletes, and survives a reload", async ({ demo }) => {
    await openPicker(demo);
    await demo.getByLabel("Snippet name").fill("keep");
    await demo.getByLabel("Snippet text").fill("kept body");
    await demo.getByRole("button", { name: "Save snippet" }).click();
    await expect(demo.getByRole("button", { name: "Insert snippet keep" })).toBeVisible();

    // Snippets persist in local storage, so they must come back after a reload.
    await demo.reload({ waitUntil: "networkidle" });
    await demo.getByText("auth-rewrite", { exact: true }).first().click();
    await openPicker(demo);
    await expect(demo.getByRole("button", { name: "Insert snippet keep" })).toBeVisible();

    await demo.getByRole("button", { name: "Edit snippet keep" }).click();
    await demo.getByLabel("Snippet name").fill("renamed");
    await demo.getByRole("button", { name: "Update snippet" }).click();
    await expect(demo.getByRole("button", { name: "Insert snippet renamed" })).toBeVisible();

    await demo.getByRole("button", { name: "Delete snippet renamed" }).click();
    await expect(demo.getByRole("button", { name: "Insert snippet renamed" })).toHaveCount(0);
  });
});
