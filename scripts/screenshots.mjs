#!/usr/bin/env node
// Regenerates the README screenshots in docs/screenshots from the seeded
// demo, in the dark palette, at 2x. Start a server first, then:
//
//   npm run dev                                   # or npm run preview
//   node scripts/screenshots.mjs http://localhost:8080
import { chromium } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const base = process.argv[2];
if (!base) {
  process.stderr.write("usage: screenshots.mjs <base URL of a running moshpit server>\n");
  process.exit(2);
}
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../docs/screenshots");

const browser = await chromium.launch();

async function open(viewport) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, colorScheme: "dark" });
  const page = await context.newPage();
  await page.goto(new URL("/?demo=1", base).href, { waitUntil: "networkidle" });
  // Through onboarding, as tests/fixtures.ts openApp does.
  for (let step = 0; step < 2; step += 1) await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("button", { name: "Open moshpit" }).click();
  await page.getByRole("navigation", { name: "Primary" }).waitFor();
  await page.getByRole("button", { name: "Dismiss" }).first().click(); // the demo notice
  await page.evaluate(() => document.fonts.ready);
  return page;
}

async function shot(page, name) {
  await page.waitForTimeout(400); // let transitions settle
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  process.stdout.write(`wrote docs/screenshots/${name}.png\n`);
}

const desktop = await open({ width: 1440, height: 900 });
await desktop.getByRole("button", { name: /^migrate\b/ }).first().click();
await desktop.locator('[data-role="question"]').first().waitFor();
await shot(desktop, "desktop-chat");
await desktop.getByRole("button", { name: "Terminal view", exact: true }).click();
await shot(desktop, "desktop-terminal");

const phone = await open({ width: 390, height: 844 });
await shot(phone, "phone-agents");
const nav = phone.getByRole("navigation", { name: "Primary" });
await nav.getByRole("button", { name: /inbox/i }).click();
await phone.getByText("A moment of your time").waitFor();
await shot(phone, "phone-inbox");
await nav.getByRole("button", { name: /moshpit/i }).click();
await phone.getByRole("button", { name: /^migrate\b/ }).first().click();
await phone.locator('[data-role="question"]').first().waitFor();
await shot(phone, "phone-chat");

await browser.close();
