// One-shot check: the terminal key bar has a literal "shift+tab" button and
// clicking it sends [shift+tab] to the focused pane.
import { chromium } from "playwright";

const port = process.argv[2] ?? "8188";
const out = process.argv[3];

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
const p = await ctx.newPage();
await p.goto(`http://127.0.0.1:${port}/?demo=1`, { waitUntil: "networkidle" });

for (let i = 0; i < 2; i++)
  await p.getByRole("button", { name: "Next", exact: true }).click();
await p.getByRole("button", { name: "Open moshpit" }).click();
await p.getByText("migrate", { exact: true }).first().click();
await p.getByRole("button", { name: "Terminal view" }).click();
await p.waitForTimeout(200);

const btn = p.getByRole("button", { name: "shift+tab", exact: true });
console.log(
  (await btn.count())
    ? "ok   key bar has a button labeled shift+tab"
    : "FAIL no shift+tab button",
);
if (!(await btn.count())) process.exit(1);

const before = await p.getByText(/\[shift\+tab\]/).count();
await btn.click();
await p.waitForTimeout(400);
const after = await p.getByText(/\[shift\+tab\]/).count();
console.log(
  after > before
    ? "ok   click sent [shift+tab] into the pane log"
    : "FAIL no [shift+tab] line after click",
);
if (out) await p.screenshot({ path: out });
process.exit(after > before ? 0 : 1);
