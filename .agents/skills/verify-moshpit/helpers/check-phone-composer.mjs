import assert from "node:assert/strict";
import { chromium } from "playwright";

const port = process.argv[2] ?? "8188";
const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/?demo=1`, {
    waitUntil: "networkidle",
  });

  for (let step = 0; step < 2; step += 1) {
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await page.waitForTimeout(150);
  }
  await page.getByRole("button", { name: "Open moshpit" }).click();

  await page.getByText("auth-rewrite", { exact: true }).first().click();

  const prompt = page.getByPlaceholder("Message this agent…");
  await prompt.waitFor({ state: "visible" });
  assert.equal(
    await page.getByRole("application", { name: /^Pane / }).count(),
    0,
    "phone detail must unmount the hidden terminal",
  );

  await prompt.click();
  await page.setViewportSize({ width: 390, height: 500 });
  const text = "Keep the existing behavior and add a focused regression test.";
  await page.keyboard.insertText(text);
  assert.equal(await prompt.inputValue(), text);
  assert.equal(
    await prompt.evaluate((element) => element === document.activeElement),
    true,
  );

  await page.setViewportSize({ width: 390, height: 844 });
  const openTerminal = page.getByRole("button", { name: "Terminal view" });
  assert.equal(
    await openTerminal.count(),
    1,
    "agent detail must expose its Terminal view",
  );
  await openTerminal.click();
  await page
    .getByPlaceholder("Type or dictate terminal input")
    .waitFor({ state: "visible" });
  assert.equal(
    await page.getByRole("button", { name: "Back", exact: true }).count(),
    1,
    "Terminal must stay inside the phone agent detail",
  );

  const raw = page.getByPlaceholder("Type or dictate terminal input");
  await raw.click({ force: true });
  const rawText = "x".repeat(2_000);
  await page.keyboard.insertText(rawText);
  assert.equal(await raw.inputValue(), rawText);
  assert.equal(
    await raw.evaluate((element) => element === document.activeElement),
    true,
  );

  console.log("ok   Chat does not keep a hidden Terminal mounted");
  console.log(
    "ok   unblocked composer stays focused through keyboard resize and typing",
  );
  await page.getByRole("button", { name: "Chat view" }).click();
  await prompt.waitFor({ state: "visible" });

  console.log("ok   agent detail mounts only its current view");
  console.log("ok   raw terminal input survives sustained phone typing");
  console.log(
    "ok   Terminal returns directly to Chat and keeps Back available",
  );
  await context.close();
} finally {
  await browser.close();
}
