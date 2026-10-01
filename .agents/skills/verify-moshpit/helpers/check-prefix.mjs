// One-shot check: the herdr prefix setting flows into the terminal surface.
// Change the prefix in Settings to ctrl+a; the terminal hint, key bar, and
// persisted state must follow.
import { chromium } from "playwright";

const port = process.argv[2] ?? "8188";
const out = process.argv[3];

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
const p = await ctx.newPage();
let cdp = null;
const initCdp = async () => (cdp ??= await ctx.newCDPSession(p));
await p.goto(`http://127.0.0.1:${port}/?demo=1`, { waitUntil: "networkidle" });

for (let i = 0; i < 2; i++)
  await p.getByRole("button", { name: "Next", exact: true }).click();
await p.getByRole("button", { name: "Open moshpit" }).click();

const moshpit = () => p.locator('nav[aria-label="Primary"] > button').nth(0);
const hosts = () => p.locator('nav[aria-label="Primary"] > button').nth(2);
const terminal = async () => {
  await moshpit().click();
  await p.getByText("migrate", { exact: true }).first().click();
  await p.getByRole("button", { name: "Terminal view" }).click();
};

// Swipe left on the pane (trusted touch events) and check the toast it sends.
async function swipeToast(label) {
  await initCdp();
  // A leftover toast from the previous swipe must not fake this check.
  await p.getByText(`${label} l — next tab`).waitFor({ state: "detached", timeout: 6000 }).catch(() => {});
  const box = await p.locator('[role="application"]').boundingBox();
  const y = box.y + box.height / 2;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + 300, y }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: box.x + 200, y }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await p.waitForTimeout(300);
  return (await p.getByText(`${label} l — next tab`).count()) > 0;
}

await hosts().click();
const input = p.getByPlaceholder("ctrl+b");
await input.waitFor();
console.log(
  (await input.inputValue()) === "ctrl+b"
    ? "ok   prefix input defaults to ctrl+b"
    : `FAIL default prefix is ${await input.inputValue()}`,
);
await input.fill("ctrl+a");
await p.waitForTimeout(200);

await terminal();
await p.waitForTimeout(200);
const hintOk = await swipeToast("ctrl+a");
console.log(
  hintOk
    ? "ok   terminal hint shows the new prefix"
    : "FAIL hint still says ctrl+b",
);
const btnAOk =
  (await p.getByRole("button", { name: "^A", exact: true }).count()) > 0;
console.log(
  btnAOk
    ? "ok   key bar shows ^A for the new prefix"
    : "FAIL no ^A key bar button",
);
const btnBGone =
  (await p.getByRole("button", { name: "^B", exact: true }).count()) === 0;
console.log(
  btnBGone ? "ok   old ^B button gone" : "FAIL ^B button still present",
);
if (out) await p.screenshot({ path: out });

await hosts().click();
await input.fill("shift+a");
await p.waitForTimeout(200);
await terminal();
await p.waitForTimeout(200);
const stillA = await swipeToast("ctrl+a");
console.log(
  stillA
    ? "ok   invalid draft did not change the prefix"
    : "FAIL invalid value reached the store",
);

await hosts().click();
await p.getByRole("button", { name: "Set prefix ctrl plus d" }).click();
await p.waitForTimeout(200);
await terminal();
await p.waitForTimeout(200);
const hintD = await swipeToast("ctrl+d");
console.log(
  hintD ? "ok   tapping ^D set the prefix" : "FAIL tap did not set prefix",
);

process.exit(hintOk && btnAOk && btnBGone && stillA && hintD ? 0 : 1);
