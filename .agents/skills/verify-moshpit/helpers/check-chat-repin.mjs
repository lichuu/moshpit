#!/usr/bin/env node
// Usage: node helpers/check-chat-repin.mjs <port> <evidence-dir>
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const port = Number(process.argv[2]);
const outBase = process.argv[3] ?? ".";
if (!process.argv[2]) process.exit(2);
const out = path.join(outBase, `chat-repin-${new Date().toISOString().replace(/[:.]/g, "-")}`);
await mkdir(out, { recursive: true });

const conversation = (page) =>
  page.evaluate(() => {
    const el = document.querySelector(".conversation");
    if (!el) return null;
    return {
      client: Math.round(el.clientHeight),
      fromBottom: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
    };
  });

const browser = await chromium.launch();
let failed = false;
const log = (line) => console.log(line);
try {
  const ctx = await browser.newContext({ viewport: { width: 440, height: 956 } });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/?demo=1`, { waitUntil: "networkidle" });
  for (let i = 0; i < 2; i++) await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("button", { name: "Open moshpit" }).click();

  await page.getByText("migrate", { exact: true }).click();
  await page.getByRole("button", { name: "Back", exact: true }).waitFor({ state: "visible" });
  await page.locator(".conversation").waitFor();
  await page.evaluate(() => {
    const el = document.querySelector(".conversation");
    el.scrollTop = el.scrollHeight;
    el.dispatchEvent(new Event("scroll"));
  });
  await page.waitForTimeout(200);
  const resting = await conversation(page);
  log(`ok   resting at the bottom: ${JSON.stringify(resting)}`);
  if (resting.fromBottom > 48) throw new Error(`did not start pinned: ${JSON.stringify(resting)}`);
  await page.screenshot({ path: path.join(out, "01-pinned.png") });

  // The keyboard opening shrinks the app box by about this much.
  await page.setViewportSize({ width: 440, height: 500 });
  await page.waitForTimeout(400);
  const shrunk = await conversation(page);
  log(`ok   after the box shrank: ${JSON.stringify(shrunk)}`);
  await page.screenshot({ path: path.join(out, "02-shrunk.png") });

  await page.setViewportSize({ width: 440, height: 956 });
  await page.waitForTimeout(400);
  const restored = await conversation(page);
  log(`ok   after the box grew back: ${JSON.stringify(restored)}`);
  await page.screenshot({ path: path.join(out, "03-restored.png") });

  // 48 is the threshold the conversation itself uses to decide it is following.
  if (shrunk.client < resting.client && shrunk.fromBottom <= 48 && restored.fromBottom <= 48) {
    log("PASS the log stays pinned to the bottom across a resize");
  } else {
    log(`FAIL resting=${JSON.stringify(resting)} shrunk=${JSON.stringify(shrunk)} restored=${JSON.stringify(restored)}`);
    failed = true;
  }
} catch (e) {
  failed = true;
  console.log(`FAIL ${e.message.split("\n")[0]}`);
} finally {
  await browser.close();
}
console.log(failed ? `\ncheck-chat-repin: FAILED (${out})` : `\ncheck-chat-repin: passed (${out})`);
process.exit(failed ? 1 : 0);
