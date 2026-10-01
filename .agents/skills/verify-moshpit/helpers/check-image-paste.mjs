import assert from "node:assert/strict";
import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatImageLine } from "../../../../src/lib/moshpit/image.ts";

assert.equal(
  formatImageLine({ id: "1", name: "tiny.png", size: 70 }),
  "> [image] tiny.png (70)",
);

const port = process.argv[2] ?? "8188";
const out = process.argv[3];
const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/tiny.png",
);

const b = await chromium.launch();
try {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  const p = await ctx.newPage();
  await p.goto(`http://127.0.0.1:${port}/?demo=1`, { waitUntil: "networkidle" });
  for (let i = 0; i < 2; i++)
    await p.getByRole("button", { name: "Next", exact: true }).click();
  await p.getByRole("button", { name: "Open moshpit" }).click();
  await p.getByText("migrate", { exact: true }).click();

  const attach = p.getByRole("button", { name: "Attach image" });
  assert.ok(await attach.count(), "Attach image button missing");
  console.log("ok   paperclip present");

  const input = p.locator('input[type="file"][accept="image/*"]');
  assert.equal(await input.getAttribute("accept"), "image/*", "accept is not image/*");
  await input.setInputFiles(fixture);
  await p.getByText("tiny.png").waitFor({ state: "visible" });
  console.log("ok   chip shows tiny.png");

  const send = p.getByRole("button", { name: "Send" });
  assert.ok(!(await send.isDisabled()), "send still disabled with chip");
  console.log("ok   send enabled with chip");

  await p.getByRole("button", { name: "Remove image" }).click();
  assert.equal(await p.getByText("tiny.png").count(), 0, "chip still present after remove");
  console.log("ok   chip cleared before send");

  await input.setInputFiles(fixture);
  await p.getByText("tiny.png").waitFor({ state: "visible" });
  await send.click();
  // Chat renders lines as markdown, so the pane line's leading "> " is
  // consumed as blockquote syntax and never appears as text.
  await p.getByText("[image] tiny.png").waitFor({ state: "visible" });
  console.log("ok   pane has image line");
  assert.equal(
    await p.getByRole("button", { name: "Remove image" }).count(),
    0,
    "chip still in composer after send",
  );
  console.log("ok   chip cleared after send");

  await p
    .getByRole("group", { name: "Blocked reply controls" })
    .waitFor({ state: "visible" });
  await p.getByRole("button", { name: "Enter", exact: true }).waitFor({ state: "visible" });
  await p.getByRole("button", { name: "Esc", exact: true }).waitFor({ state: "visible" });
  console.log("ok   blocked agent still waiting after image-only send");
  if (out) await p.screenshot({ path: out });
} finally {
  await b.close();
}
console.log("ok   image paste check passed");
