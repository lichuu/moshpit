// Repro: does focusing the raw input field freeze the main thread?
// usage: node check-raw-input-focus.mjs <port> [screenshot]
//
// Probes while the field is focused:
//  - setInterval drift (250ms tick, 20 ticks) — event loop starvation
//  - requestAnimationFrame gaps
//  - Long Animation Frame events
//  - WS connection churn (browser-side /pty sockets)
import path from "node:path";
import { chromium } from "playwright";

const [portArg, shot] = process.argv.slice(2);
const port = Number(portArg ?? 8188);

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
const p = await ctx.newPage();

const lags = [];
p.on("console", (m) => {
  if (m.text().startsWith("HANGPROBE:")) lags.push(m.text());
});

await p.goto(`http://127.0.0.1:${port}/?demo=1`, { waitUntil: "networkidle" });
for (let i = 0; i < 2; i++)
  await p.getByRole("button", { name: "Next", exact: true }).click();
await p.getByRole("button", { name: "Open moshpit" }).click();

// Install the probes.
await p.evaluate(() => {
  // setInterval drift
  let expected = 0;
  const t0 = performance.now();
  window.__tickCount = 0;
  window.setInterval(() => {
    expected += 250;
    window.__tickCount++;
    const now = performance.now() - t0;
    const drift = expected - now;
    if (drift > 200) console.log(`HANGPROBE:tick ${Math.round(drift)}ms`);
  }, 250);
  // rAF gaps
  let last = performance.now();
  function raf() {
    const now = performance.now();
    const gap = now - last;
    last = now;
    if (gap > 400) console.log(`HANGPROBE:raf ${Math.round(gap)}ms`);
    requestAnimationFrame(raf);
  }
  requestAnimationFrame(raf);
  // long animation frames
  window.addEventListener("longanimationframe", (e) => {
    console.log(`HANGPROBE:laf ${Math.round(e.duration)}ms`);
  });
});

// Open the terminal (agent detail terminal view, like drive.mjs).
await p.locator('nav[aria-label="Primary"] > button').nth(0).click();
await p.getByText("migrate", { exact: true }).first().click();
await p.getByRole("button", { name: "Terminal view" }).click();
const input = p.getByPlaceholder("Type or dictate terminal input");
await input.waitFor();
if (shot) await p.screenshot({ path: path.join(shot, "01-terminal.png") });

// Baseline: 5s unfocused.
await p.waitForTimeout(5000);

// Focus and hold for 10s.
await input.click();
const focused = await p
  .locator('textarea[placeholder="Type or dictate terminal input"]')
  .evaluate((el) => document.activeElement === el);
console.log(focused ? "ok   raw input focused" : "FAIL focus did not land");
if (focused) await p.keyboard.type("hi");
if (shot) await p.screenshot({ path: path.join(shot, "02-focused.png") });
await p.waitForTimeout(10000);

const tick = await p.evaluate(() => ({
  count: window.__tickCount,
  now: performance.now(),
}));
console.log(`info ticks=${tick.count} (expected ~30 total incl. baseline)`);

const bad = lags.filter((l) => !l.includes("tick 0ms"));
console.log(bad.length ? bad.join("\n") : "ok   no long tasks while focused");
console.log(
  bad.length === 0 && focused ? "PASS no hang while raw input focused" : "FAIL",
);
await b.close();
