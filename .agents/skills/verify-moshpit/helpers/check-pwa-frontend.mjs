import { chromium } from "playwright";

const port = process.argv[2] ?? "8193";
const out = process.argv[3];
const b = await chromium.launch();
let failed = false;
const log = (ok, msg) => {
  console.log(ok ? `ok   ${msg}` : `FAIL ${msg}`);
  if (!ok) failed = true;
};

async function onboard(p) {
  for (let i = 0; i < 2; i++)
    await p.getByRole("button", { name: "Next", exact: true }).click();
  await p.getByRole("button", { name: "Open moshpit" }).click();
}

const ctx = await b.newContext({
  viewport: { width: 390, height: 844 },
  serviceWorkers: "allow",
});
await ctx.grantPermissions(["notifications"], {
  origin: `http://127.0.0.1:${port}`,
});
const p = await ctx.newPage();
await p.goto(`http://127.0.0.1:${port}/?demo=1&tab=steer&agent=migrate`, {
  waitUntil: "networkidle",
});
await onboard(p);
await p.waitForTimeout(400);

// Steer is no longer a tab: a deep link opens the agent detail over whichever
// tab you were on, so assert the detail rather than a nav selection.
log(
  (await p.getByRole("button", { name: /^back$/i }).count()) > 0,
  "deep link opens the agent detail",
);
log(
  (await p
    .getByPlaceholder(/Type y, n, or a reply|Prompt this agent|Message this agent…/)
    .count()) > 0,
  "steer composer visible after deep link",
);

const sw = await p.evaluate(async () => {
  if (!("serviceWorker" in navigator)) return { ready: false };
  const reg = await navigator.serviceWorker.ready;
  const src = await fetch("/sw.js").then((r) => r.text());
  return {
    ready: Boolean(reg.active || reg.installing || reg.waiting),
    script: src.includes('data.type !== "block"') && src.includes("openWindow"),
  };
});
log(sw.ready, "service worker registered");
log(sw.script, "sw.js push handler is the block handler");

if (out) await p.screenshot({ path: out });
await b.close();
process.exit(failed ? 1 : 0);
