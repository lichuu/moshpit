import { test, expect, isPhone } from "../fixtures";

test.describe("ask-user questions in chat", () => {
  test("steps a three-question choose wizard without leaving Chat", async ({ demo }) => {
    await demo.getByRole("button", { name: "postcard-ui" }).click();

    const first = demo.getByRole("button", {
      name: "Answer Which deployment experience should we design first?: Own machine (Recommended)",
    });
    const second = demo.getByRole("button", {
      name: "Answer How should the machines talk to each other?: Require Tailscale (Recommended)",
    });
    const third = demo.getByRole("button", {
      name: "Answer What is the first step after choosing?: One command, then browser (Recommended)",
    });
    await expect(first).toBeVisible();
    await expect(second).toBeVisible();
    await expect(third).toBeVisible();
    await expect(first).toContainText("1");
    await expect(second).toBeDisabled();
    await expect(third).toBeDisabled();
    await expect(demo.getByRole("button", { name: "Send" })).toBeDisabled();

    await first.click();
    await expect(demo.getByText("How should the machines talk to each other?").first()).toBeVisible();
    await expect(first).toBeDisabled();
    await expect(second).toBeEnabled();
    await expect(third).toBeDisabled();

    await second.click();
    await expect(demo.getByText("What is the first step after choosing?").first()).toBeVisible();
    await expect(third).toBeEnabled();
    await third.click();

    await expect(demo.getByText("Answered: One command, then browser (Recommended)")).toBeVisible();
    await expect(demo.getByText("working", { exact: true }).first()).toBeVisible();
    await expect(demo.getByRole("button", { name: "Send" })).toBeEnabled();
  });

  test("a dialog the bridge cannot read offers the Terminal instead of a guess", async ({ demo }) => {
    // The agent card, not the answer rows that name the same agent.
    await demo.getByRole("button", { name: /^migrate\b/ }).click();

    const yes = demo.getByRole("button", { name: "Answer Should I run prisma migrate?: Yes" });
    // The keys of a y/n prompt are not on the card, so no row may be tapped:
    // sending a positioned digit would answer whatever the TUI has selected.
    await expect(yes).toBeDisabled();
    const card = demo.locator('[data-role="question"]');
    await expect(card.getByRole("button", { name: "Answer in Terminal" })).toBeVisible();
  });

  test("option rows wrap instead of running off the card", async ({ demo }) => {
    await demo.getByRole("button", { name: "postcard-ui" }).click();
    const card = demo.locator('[data-role="question"]').first();
    await expect(card).toBeVisible();
    // A label plus its description used to sit on one unshrinkable line, so on
    // a phone the tail of the row ran past the edge of the screen.
    const overflow = await card.evaluate((el) => {
      const box = el.getBoundingClientRect();
      return [...el.querySelectorAll("button, p, span")].filter((child) => {
        const r = child.getBoundingClientRect();
        return r.right > box.right + 1 || child.scrollWidth > child.clientWidth + 1;
      }).length;
    });
    expect(overflow).toBe(0);
    await expect(card.getByText("Run it on your laptop")).toBeVisible();
  });

  test("a resolved question keeps showing the answer that was given", async ({ demo }) => {
    await demo.getByRole("button", { name: "auth-rewrite" }).click();
    await expect(demo.getByText("Answered: rotate on use")).toHaveCount(1);
  });
});

test.describe("conversation pinning", () => {
  test("stays pinned to the bottom when the app box resizes", async ({ demo }, testInfo) => {
    test.skip(!isPhone(testInfo), "the soft-keyboard resize this covers is phone-only");
    await demo.getByText("migrate", { exact: true }).first().click();

    const conversation = demo.locator(".conversation");
    await expect(conversation).toBeVisible();

    const distanceFromBottom = () =>
      conversation.evaluate((el) =>
        Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
      );

    // Start pinned.
    await expect.poll(distanceFromBottom).toBeLessThan(4);

    // A soft keyboard opening shrinks the box. Losing the pin here strands the
    // newest message off-screen exactly when you are about to reply to it.
    await demo.setViewportSize({ width: 390, height: 500 });
    await expect.poll(distanceFromBottom).toBeLessThan(4);

    await demo.setViewportSize({ width: 390, height: 844 });
    await expect.poll(distanceFromBottom).toBeLessThan(4);
  });

  // The other half of the rule: a reader who scrolls away is left there,
  // even when the box resizes under them.
  test("a reader who scrolls up stays up through a resize", async ({ demo }, testInfo) => {
    test.skip(!isPhone(testInfo), "the soft-keyboard resize this covers is phone-only");
    await demo.getByText("migrate", { exact: true }).first().click();
    const conversation = demo.locator(".conversation");
    const distanceFromBottom = () =>
      conversation.evaluate((el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight));
    await expect.poll(distanceFromBottom).toBeLessThan(4);

    const box = await conversation.boundingBox();
    if (!box) throw new Error("conversation has no box");
    await demo.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await demo.mouse.wheel(0, -400);
    await expect.poll(distanceFromBottom).toBeGreaterThan(100);

    await demo.setViewportSize({ width: 390, height: 500 });
    await demo.waitForTimeout(300);
    expect(await distanceFromBottom(), "a resize does not pull the reader back down").toBeGreaterThan(48);
  });
});
