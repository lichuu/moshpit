import { test, expect } from "../fixtures";

// The wide layout (list beside detail) opens at 860 x 480. The iPhone Duo's
// inner display held landscape gets it; an iPad in portrait, a phone held
// landscape and the Duo's outer display keep the phone layout.
const CASES = [
  { name: "Duo inner display, landscape", size: { width: 890, height: 626 }, layout: "wide" },
  { name: "Duo outer display", size: { width: 383, height: 678 }, layout: "phone" },
  { name: "iPad Air, portrait", size: { width: 820, height: 1180 }, layout: "phone" },
  { name: "large phone, landscape", size: { width: 932, height: 430 }, layout: "phone" },
] as const;

for (const { name, size, layout } of CASES) {
  test(`${name} uses the ${layout} layout`, async ({ demo }) => {
    await demo.setViewportSize(size);
    await expect(demo.locator("html")).toHaveAttribute("data-layout", layout);
  });
}

test("the Duo inner display shows a blocked question and the composer beside the list", async ({ demo }) => {
  await demo.setViewportSize({ width: 890, height: 626 });
  await demo.getByRole("button", { name: /^migrate\b/ }).first().click();
  await expect(demo.getByRole("button", { name: /^migrate\b/ }).first()).toBeInViewport();
  await expect(demo.getByRole("button", { name: "Answer in Terminal" })).toBeInViewport({ ratio: 1 });
  await expect(demo.getByRole("button", { name: "Send" })).toBeInViewport({ ratio: 1 });
});

test("the Terminal key bar is one scrolling row on the Duo's touch screen", async ({ demo }) => {
  test.skip(!(await demo.evaluate(() => matchMedia("(pointer: coarse)").matches)), "touch only; a mouse wraps the keys");
  await demo.setViewportSize({ width: 890, height: 626 });
  await demo.getByRole("button", { name: /^migrate\b/ }).first().click();
  await demo.getByRole("button", { name: "Terminal view", exact: true }).click();
  const tops = await demo.getByRole("button", { name: /^(esc|tab|up|down|left|right|shift\+tab|\^[A-Z])$/ }).evaluateAll((keys) => [...new Set(keys.map((key) => Math.round(key.getBoundingClientRect().top)))]);
  expect(tops).toHaveLength(1);
});
