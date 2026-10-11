import { test, expect, openDemo } from "../fixtures";

// The dot beside "working" pulses wherever a working agent is listed, not
// only in the open agent's header; every other status holds still.

test("the working dot pulses in the agent list, and other statuses do not", async ({ page }) => {
  await openDemo(page);
  const animation = (text: string) =>
    page.locator(".ear-tag", { hasText: new RegExp(`^${text}$`) }).first().evaluate((el) => getComputedStyle(el, "::before").animationName);
  await expect(page.locator(".ear-tag", { hasText: /^working$/ }).first()).toBeVisible();
  expect(await animation("working")).toBe("pit-blink");
  expect(await animation("blocked")).toBe("none");
});
