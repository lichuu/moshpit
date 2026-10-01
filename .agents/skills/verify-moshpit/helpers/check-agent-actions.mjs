#!/usr/bin/env node
// One-shot check: rename and close an agent from the detail header, on the
// demo fixture. Usage: node helpers/check-agent-actions.mjs <port> <evidence-dir>
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const port = Number(process.argv[2] ?? 8188);
const outBase = process.argv[3];
if (!outBase) {
  console.error("usage: check-agent-actions.mjs <port> <evidence-dir>");
  process.exit(2);
}
const run = new Date().toISOString().replace(/[:.]/g, "-");
const out = path.join(outBase, `${run}-agent-actions`);
await mkdir(out, { recursive: true });

// On a phone the header keeps Rename and Close behind "More actions".
async function action(p, name) {
  const more = p.getByRole("button", { name: "More actions" });
  if ((await more.isVisible()) && (await more.getAttribute("aria-expanded")) !== "true") {
    await more.click();
  }
  return p.getByRole("button", { name });
}

const steps = [
  {
    label: "select-migrate",
    act: (p) => p.getByText("migrate", { exact: true }).first().click(),
    expect: async (p) => {
      await p
        .getByRole("button", { name: "Back", exact: true })
        .waitFor({ state: "visible" });
      return p.getByRole("heading", { name: "migrate" });
    },
  },
  {
    label: "open-rename",
    act: async (p) => (await action(p, "Rename agent")).click(),
    expect: async (p) => {
      const input = p.getByRole("textbox", { name: "New name" });
      await input.waitFor({ state: "visible" });
      return input;
    },
  },
  {
    label: "rename-commit",
    act: async (p) => {
      const input = p.getByRole("textbox", { name: "New name" });
      await input.fill("migration v2");
      await p.keyboard.press("Enter");
    },
    expect: async (p) => {
      await p
        .getByRole("heading", { name: "migration v2" })
        .waitFor({ state: "visible" });
      return p.getByRole("heading", { name: "migration v2" });
    },
  },
  {
    label: "rename-in-list",
    act: async (p) => {
      await p.getByRole("button", { name: "Back", exact: true }).click();
    },
    expect: async (p) => {
      await p
        .getByText("migration v2")
        .first()
        .waitFor({ state: "visible" });
      return p.getByText("migration v2").first();
    },
  },
  {
    label: "reopen-renamed",
    act: (p) => p.getByText("migration v2").first().click(),
    expect: async (p) => {
      await (await action(p, "Close pane")).waitFor({ state: "visible" });
      return p.getByRole("heading", { name: "migration v2" });
    },
  },
  {
    label: "close-arm",
    act: async (p) => (await action(p, "Close pane")).click(),
    expect: async (p) => {
      const confirm = p.getByRole("button", { name: "Really close" });
      await confirm.waitFor({ state: "visible" });
      return confirm;
    },
  },
  {
    label: "close-confirm",
    act: (p) => p.getByRole("button", { name: "Really close" }).click(),
    expect: async (p) => {
      // Closing the phone detail agent unmounts the dialog back to the list.
      await p
        .getByText("migration v2")
        .first()
        .waitFor({ state: "detached", timeout: 5000 });
      if ((await p.getByText("auth-rewrite").count()) === 0)
        throw new Error("auth-rewrite missing from list after close");
      return p.getByText("auth-rewrite");
    },
  },
];

const results = [];
let failed = false;
const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/?demo=1`, {
    waitUntil: "networkidle",
  });
  for (let i = 0; i < 2; i++)
    await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("button", { name: "Open moshpit" }).click();
  let i = 0;
  for (const step of steps) {
    i += 1;
    const name = String(step.label).slice(0, 48);
    try {
      if (step.act) await step.act(page);
      if (step.expect) {
        const locator = await step.expect(page);
        if (locator?.scrollIntoViewIfNeeded)
          await locator.scrollIntoViewIfNeeded().catch(() => {});
      }
      await page.screenshot({
        path: path.join(out, `${String(i).padStart(2, "0")}-${name}.png`),
      });
      const aria = await page.locator("body").ariaSnapshot();
      await import("node:fs/promises").then((fs) =>
        fs.writeFile(
          path.join(out, `${String(i).padStart(2, "0")}-${name}.aria.json`),
          aria,
        ),
      );
      results.push(`ok   ${name}`);
    } catch (e) {
      failed = true;
      results.push(`FAIL ${name}: ${e.message.split("\n")[0]}`);
      try {
        await page.screenshot({
          path: path.join(out, `${String(i).padStart(2, "0")}-${name}-FAIL.png`),
        });
      } catch {
        // Keep the original assertion failure when the failure screenshot fails.
      }
      break;
    }
  }
} finally {
  await browser.close();
}
console.log(results.join("\n"));
console.log(
  failed
    ? `\ncheck-agent-actions: FAILED`
    : `\ncheck-agent-actions: passed (${out})`,
);
process.exit(failed ? 1 : 0);
