#!/usr/bin/env node
// Usage: node helpers/check-theme-clobber.mjs <port> <evidence-dir>
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const port = Number(process.argv[2]);
const outBase = process.argv[3] ?? ".";
if (!process.argv[2]) process.exit(2);
const out = path.join(outBase, `theme-clobber-${new Date().toISOString().replace(/[:.]/g, "-")}`);
await mkdir(out, { recursive: true });

const KEY = "moshpit-v1";
const stored = (page) =>
  page.evaluate((k) => {
    try {
      const raw = localStorage.getItem(k);
      return raw ? JSON.parse(raw).state.settings : null;
    } catch {
      return null;
    }
  }, KEY);
const painted = (page) =>
  page.evaluate(() => document.documentElement.dataset.theme);

async function onboard(page) {
  await page.goto(`http://127.0.0.1:${port}/?demo=1`, { waitUntil: "networkidle" });
  const next = page.getByRole("button", { name: "Next", exact: true });
  if (await next.count()) {
    for (let i = 0; i < 2; i++) await next.click();
    await page.getByRole("button", { name: "Open moshpit" }).click();
  }
}

const browser = await chromium.launch();
let failed = false;
const log = (line) => console.log(line);
try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });

  const tabB = await ctx.newPage();
  await onboard(tabB);

  const tabA = await ctx.newPage();
  await onboard(tabA);
  await tabA.locator('nav[aria-label="Primary"] > button').nth(2).click();
  await tabA.locator('select[aria-label="Appearance"]').selectOption("catppuccin");
  await tabA.screenshot({ path: path.join(out, "01-a-chose-catppuccin.png") });
  log(`ok   tab A chose catppuccin; stored=${JSON.stringify(await stored(tabA))}`);
  if ((await stored(tabA))?.theme !== "catppuccin") throw new Error("stored theme is not catppuccin after picker");

  await tabB.locator('nav[aria-label="Primary"] > button').nth(1).click();
  await tabB.screenshot({ path: path.join(out, "02-b-tapped-inbox.png") });
  const after = await stored(tabB);
  log(`ok   after tab B set, stored=${JSON.stringify(after)}`);

  // Tab B changes its own theme: its write must still land.
  await tabB.locator('nav[aria-label="Primary"] > button').nth(2).click();
  await tabB.locator('select[aria-label="Appearance"]').selectOption("nord");
  const ownB = await stored(tabB);
  if (ownB?.theme !== "nord") throw new Error(`own settings write lost: ${JSON.stringify(ownB)}`);
  log(`ok   tab B's own picker write lands: ${JSON.stringify(ownB)}`);

  // Tab A last touched settings first, but B's choice is newer.
  // A's next non-settings action must not restamp catppuccin over it.
  await tabA.locator('nav[aria-label="Primary"] > button').nth(1).click();
  await tabA.screenshot({ path: path.join(out, "03-a-tapped-inbox-after-b.png") });
  const afterB = await stored(tabA);
  log(`ok   after tab A set post-B, stored=${JSON.stringify(afterB)}`);
  if (afterB?.theme !== "nord") throw new Error(`stale A restamp clobbered B's choice: ${JSON.stringify(afterB)}`);

  // A changes its own theme after the flag cleared: its write must still land.
  await tabA.locator('nav[aria-label="Primary"] > button').nth(2).click();
  await tabA.locator('select[aria-label="Appearance"]').selectOption("tokyo-night");
  const ownA = await stored(tabA);
  if (ownA?.theme !== "tokyo-night") throw new Error(`own settings write lost: ${JSON.stringify(ownA)}`);
  log(`ok   tab A's later own write lands: ${JSON.stringify(ownA)}`);

  const newInv = await ctx.newPage();
  await onboard(newInv);
  const newTheme = await painted(newInv);
  log(`ok   fresh invocation paints ${newTheme}`);
  await newInv.screenshot({ path: path.join(out, "04-fresh-invocation.png") });

  if (after?.theme === "catppuccin" && ownB.theme === "nord" && afterB.theme === "nord" && ownA.theme === "tokyo-night" && newTheme === "tokyo-night") {
    log("PASS last writer wins; own writes land; stale restamps adopted from disk");
  } else {
    log(`FAIL clobber=${JSON.stringify(after)} ownB=${JSON.stringify(ownB)} afterB=${JSON.stringify(afterB)} ownA=${JSON.stringify(ownA)} painted=${newTheme}`);
    failed = true;
  }
} catch (e) {
  failed = true;
  console.log(`FAIL ${e.message.split("\n")[0]}`);
} finally {
  await browser.close();
}
console.log(failed ? `\ncheck-theme-clobber: FAILED (${out})` : `\ncheck-theme-clobber: passed (${out})`);
process.exit(failed ? 1 : 0);
