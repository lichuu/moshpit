// One-shot check: a hardware modifier combination the pane does not support
// is reported and sent nowhere. Ctrl+Enter used to reach the pane as a bare
// carriage return, which submits whatever the agent had staged.
import { chromium } from "playwright";

const port = process.argv[2] ?? "8188";
const out = process.argv[3];

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
const p = await ctx.newPage();
await p.goto(`http://127.0.0.1:${port}/?demo=1`, { waitUntil: "networkidle" });

for (let i = 0; i < 2; i++) await p.getByRole("button", { name: "Next", exact: true }).click();
await p.getByRole("button", { name: "Open moshpit" }).click();
await p.getByText("migrate", { exact: true }).first().click();
await p.getByRole("button", { name: "Terminal view" }).click();
await p.waitForTimeout(300);

const pane = p.locator('[aria-label^="Pane "]').first();
if (!(await pane.count())) {
  console.log("FAIL no focusable pane surface");
  process.exit(1);
}
await pane.focus();

const lines = () => pane.locator("div").count();
let failures = 0;
const check = (ok, good, bad) => {
  console.log(ok ? `ok   ${good}` : `FAIL ${bad}`);
  if (!ok) failures++;
};

// Ctrl+Enter must be reported, and must not reach the pane.
const beforeCombo = await lines();
await p.keyboard.press("Control+Enter");
await p.waitForTimeout(500);
const afterCombo = await lines();
const toast = await p.getByText(/Ctrl\+Enter is not sent to the pane/).count();

check(toast > 0, "Ctrl+Enter is reported to the user", "no unsupported toast for Ctrl+Enter");
check(afterCombo === beforeCombo, "Ctrl+Enter added no pane output", `Ctrl+Enter changed pane rows ${beforeCombo} -> ${afterCombo}`);

// A plain Enter must still be delivered, or the fix broke the terminal.
await pane.focus();
const beforeEnter = await lines();
await p.keyboard.press("Enter");
await p.waitForTimeout(500);
const afterEnter = await lines();
check(afterEnter > beforeEnter, "plain Enter still reaches the pane", `plain Enter added no output (${beforeEnter} -> ${afterEnter})`);

if (out) await p.screenshot({ path: out });
await b.close();
process.exit(failures ? 1 : 0);
