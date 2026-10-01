#!/usr/bin/env node
// Drive the moshpit web demo in a fresh, isolated browser context.
// Usage: node helpers/drive.mjs <scenario> <port> <evidence-dir>
// Scenarios: onboard | list | steer | terminal | hosts | inbox
// Evidence: step screenshots (<dir>/<run>/NN-<label>.png) and an
// accessibility snapshot (JSON) per step. Exit 0 only if every assertion passes.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const [scenario, portArg, outBase] = process.argv.slice(2);
const port = Number(portArg ?? 8188);
if (!scenario || !outBase) {
  console.error(
    "usage: drive.mjs <scenario:onboard|list|steer|terminal|hosts|inbox> <port> <evidence-dir>",
  );
  process.exit(2);
}
const run = new Date().toISOString().replace(/[:.]/g, "-");
const out = path.join(outBase, `${run}-${scenario}`);
await mkdir(out, { recursive: true });

const NAV_INDEX = { moshpit: 0, Inbox: 1, Hosts: 2 };
// Nav buttons carry a badge in their accessible name ("moshpit2"), so address
// them by position inside nav[aria-label="Primary"] instead of by name.
const nav = (page, label) =>
  page.locator('nav[aria-label="Primary"] > button').nth(NAV_INDEX[label] ?? 0);

async function completeOnboarding(page) {
  for (let i = 0; i < 2; i++)
    await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("button", { name: "Open moshpit" }).click();
}

// Each step: { label, act?, expect: string | string[] | Function }
const SCENARIOS = {
  onboard: [
    {
      label: "onboarding-first-step",
      expect: (p) =>
        p.getByRole("heading", { name: /A little space/ }),
    },
    {
      label: "next",
      act: (p) => p.getByRole("button", { name: "Next", exact: true }).click(),
    },
    {
      label: "next-2",
      act: (p) => p.getByRole("button", { name: "Next", exact: true }).click(),
    },
    {
      label: "open-moshpit",
      act: (p) => p.getByRole("button", { name: "Open moshpit" }).click(),
      expect: async (p) => {
        await nav(p, "moshpit").waitFor({ state: "visible" });
        return p.getByRole("button", { name: "moshpit" }).first();
      },
    },
    {
      label: "moshpit-tab-active",
      expect: async (p) => {
        const tab = nav(p, "moshpit");
        await tab.waitFor({ state: "visible" });
        if ((await tab.getAttribute("aria-current")) !== "page")
          throw new Error("moshpit tab is not aria-current=page");
        return p.getByText("migrate", { exact: true }).first();
      },
    },
    {
      label: "agent-cards",
      expect: (p) => p.getByText("migrate", { exact: true }).first(),
    },
  ],

  list: [
    { label: "onboarded" },
    {
      label: "new-agent-sheet",
      act: (p) => p.getByRole("button", { name: "New agent in web" }).click(),
      expect: (p) => p.getByRole("dialog").getByRole("button", { name: "pi", exact: true }),
    },
    {
      label: "start-pi",
      act: (p) => p.getByRole("dialog").getByRole("button", { name: "pi", exact: true }).click(),
      expect: (p) => p.getByRole("heading", { name: /^pi-/ }),
    },
    {
      label: "back-from-new-agent",
      act: (p) => p.getByRole("button", { name: "Back", exact: true }).click(),
      expect: (p) => p.getByRole("button", { name: /^pi-/ }),
    },
    {
      label: "filter-blocked",
      act: (p) => p.getByRole("button", { name: /^Blocked/ }).click(),
      expect: async (p) => {
        await p.getByText("postcard-ui").waitFor({ state: "visible" });
        return p.getByText("postcard-ui");
      },
    },
    {
      label: "working-hidden",
      expect: async (p) => {
        await p.getByText("postcard-ui").waitFor({ state: "visible" });
        if ((await p.getByText("auth-rewrite").count()) > 0)
          throw new Error(
            "working agent auth-rewrite visible under Blocked filter",
          );
        return p.getByText("migrate", { exact: true }).first();
      },
    },
    {
      label: "select-postcard-ui",
      act: (p) => p.getByText("postcard-ui").click(),
      expect: async (p) => {
        await p.getByRole("button", { name: "Back", exact: true }).waitFor({
          state: "visible",
        });
        if ((await nav(p, "moshpit").getAttribute("aria-current")) !== "page")
          throw new Error("moshpit tab not active behind agent detail");
        return p.getByRole("heading", { name: "postcard-ui" });
      },
    },
  ],

  steer: [
    { label: "onboarded" },
    {
      label: "select-migrate",
      act: (p) => p.getByText("migrate", { exact: true }).click(),
      expect: async (p) => {
        await p.getByRole("button", { name: "Back", exact: true }).waitFor({
          state: "visible",
        });
        return p.getByPlaceholder("Message this agent…");
      },
    },
    {
      label: "type-y-insert",
      act: async (p) => {
        await p.getByPlaceholder("Message this agent…").fill("y");
        await p.getByRole("button", { name: "Send" }).click();
      },
      expect: async (p) => {
        const controls = p.getByRole("group", { name: "Blocked reply controls" });
        await controls.waitFor({ state: "visible" });
        if (
          (await p.getByText("Typed without submitting").count()) === 0
        )
          throw new Error("insert status missing after Send while blocked");
        if ((await p.getByText("running prisma migrate deploy").count()) > 0)
          throw new Error("answer submitted before Enter");
        await p.getByRole("button", { name: "Enter", exact: true }).waitFor({
          state: "visible",
        });
        await p.getByRole("button", { name: "Esc", exact: true }).waitFor({
          state: "visible",
        });
        return controls;
      },
    },
    {
      label: "enter-activates",
      act: (p) =>
        p.getByRole("button", { name: "Enter", exact: true }).click(),
      expect: async (p) => {
        const detail = p.getByRole("dialog", { name: "Agent detail" });
        const output = detail.getByText("running prisma migrate deploy");
        await output.waitFor({ state: "visible" });
        return output;
      },
    },
    {
      label: "status-working",
      expect: async (p) => {
        const status = p
          .getByRole("dialog", { name: "Agent detail" })
          .getByText("working", { exact: true });
        await status.waitFor({ state: "visible" });
        return status;
      },
    },
    {
      label: "chat-user-bubble",
      expect: async (p) => {
        const user = p
          .getByRole("dialog", { name: "Agent detail" })
          .locator('[data-role="user"]')
          .filter({ hasText: /y/ });
        await user.waitFor({ state: "visible" });
        return user;
      },
    },
    {
      label: "agent-bubble",
      expect: async (p) => {
        const agent = p
          .getByRole("dialog", { name: "Agent detail" })
          .locator('[data-role="agent"]')
          .filter({ hasText: "running prisma migrate deploy" });
        await agent.waitFor({ state: "visible" });
        return agent;
      },
    },
    {
      label: "output-view-removed",
      act: (p) =>
        p.getByRole("button", { name: "Exact terminal output" }).waitFor({
          state: "detached",
        }),
      expect: async (p) => {
        return p.getByRole("button", { name: "Terminal view" });
      },
    },
    {
      label: "terminal-keeps-detail",
      act: (p) => p.getByRole("button", { name: "Terminal view" }).click(),
      expect: async (p) => {
        const back = p.getByRole("button", { name: "Back", exact: true });
        await back.waitFor({ state: "visible" });
        if ((await nav(p, "moshpit").getAttribute("aria-current")) !== "page")
          throw new Error("moshpit tab not active behind agent Terminal");
        if ((await p.locator('[data-role="user"]').count()) > 0)
          throw new Error("chat bubbles leaked into Terminal");
        await p.getByText("running prisma migrate deploy").waitFor({
          state: "visible",
        });
        return p.getByText("esc").first();
      },
    },
    {
      label: "terminal-back-to-chat",
      act: (p) => p.getByRole("button", { name: "Chat view" }).click(),
      expect: async (p) => {
        const detail = p.getByRole("dialog", { name: "Agent detail" });
        const bubble = detail
          .locator('[data-role="agent"]')
          .filter({ hasText: "running prisma migrate deploy" });
        await bubble.waitFor({ state: "visible" });
        return bubble;
      },
    },
    {
      label: "back-to-list",
      act: (p) => p.getByRole("button", { name: "Back", exact: true }).click(),
      expect: async (p) => {
        if ((await p.getByRole("dialog", { name: "Agent detail" }).count()) > 0)
          throw new Error("agent detail stayed open after Back");
        return p.getByText("migrate", { exact: true }).first();
      },
    },
  ],

  terminal: [
    { label: "onboarded" },
    {
      label: "open-agent-terminal",
      act: async (p) => {
        await p.getByText("migrate", { exact: true }).first().click();
        await p.getByRole("button", { name: "Terminal view" }).click();
      },
      expect: async (p) => {
        await p.getByRole("button", { name: "Back", exact: true }).waitFor({
          state: "visible",
        });
        return p.getByText("esc").first();
      },
    },
    {
      label: "press-esc",
      act: (p) => p.getByText("esc", { exact: true }).first().click(),
      expect: async (p) => {
        await p.getByText("[esc]").waitFor({ state: "visible" });
        return p.getByText("[esc]");
      },
    },
    {
      label: "press-shift-tab",
      act: (p) => p.getByText("shift+tab", { exact: true }).first().click(),
      expect: async (p) => {
        await p.getByText("[shift+tab]").waitFor({ state: "visible" });
        return p.getByText("[shift+tab]");
      },
    },
    {
      label: "raw-input",
      act: async (p) => {
        await p
          .getByRole("textbox", { name: "Terminal input", exact: true })
          .click({ force: true });
        await p.keyboard.type("hello from verify");
        await p.getByRole("button", { name: "Send" }).click();
      },
      expect: async (p) => {
        await p.getByText("hello from verify").waitFor({ state: "visible" });
        return p.getByText("hello from verify");
      },
    },
  ],

  hosts: [
    { label: "onboarded" },
    {
      label: "hosts-tab",
      act: (p) => nav(p, "Hosts").click(),
      expect: async (p) => {
        await p.getByText("Demo herdr").first().waitFor({ state: "visible" });
        return p.getByText("Demo herdr").first();
      },
    },
    {
      label: "live-badge",
      expect: async (p) => {
        await p
          .getByText("live", { exact: true })
          .waitFor({ state: "visible" });
        return p.getByText("live", { exact: true });
      },
    },
    {
      label: "disconnect",
      act: (p) => p.getByRole("button", { name: "Disconnect" }).click(),
      expect: async (p) => {
        if ((await p.getByText("live", { exact: true }).count()) > 0)
          throw new Error("live badge still present after disconnect");
        return null;
      },
    },
    {
      label: "no-host-empty-state",
      act: (p) => nav(p, "moshpit").click(),
      expect: async (p) => {
        await p
          .getByText("Attach a host to see who’s blocked.")
          .waitFor({ state: "visible" });
        return p.getByRole("button", { name: "Connect Demo herdr" });
      },
    },
    {
      label: "connect-demo",
      act: (p) => p.getByRole("button", { name: "Connect Demo herdr" }).click(),
      expect: async (p) => {
        await p
          .getByText("migrate", { exact: true })
          .waitFor({ state: "visible" });
        return p.getByText("migrate", { exact: true }).first();
      },
    },
    {
      label: "simulate-blocked",
      act: async (p) => {
        await nav(p, "Hosts").click();
        await p
          .getByRole("button", { name: "Simulate: agent blocked" })
          .click();
      },
      expect: async (p) => {
        // Blocked badge on the moshpit nav button (nav[aria-label=Primary] > button)
        const badge = p
          .locator('nav[aria-label="Primary"] button')
          .first()
          .locator("span")
          .filter({ hasText: /^\d+$/ });
        await badge.first().waitFor({ state: "visible", timeout: 5000 });
        return badge.first();
      },
    },
    {
      label: "reset-demo",
      act: async (p) => {
        await nav(p, "Hosts").click();
        await p.getByRole("button", { name: "Reset demo" }).click();
        await nav(p, "moshpit").click();
      },
      expect: async (p) => {
        await p
          .getByText("migrate", { exact: true })
          .waitFor({ state: "visible" });
        return p.getByText("migrate", { exact: true }).first();
      },
    },
  ],

  inbox: [
    { label: "onboarded" },
    {
      label: "inbox-migrate-row",
      act: (p) => nav(p, "Inbox").click(),
      expect: async (p) => {
        const badge = nav(p, "Inbox")
          .locator("span")
          .filter({ hasText: /^\d+$/ });
        await badge.first().waitFor({ state: "visible", timeout: 5000 });
        const row = p
          .locator("article")
          .filter({ hasText: "Should I run prisma migrate? y/n" })
          .first();
        await row.waitFor({ state: "visible" });
        if (
          (await row
            .getByRole("button", { name: "Type yes without submitting" })
            .count()) === 0
        )
          throw new Error("Type yes without submitting missing on migrate row");
        return row;
      },
    },
    {
      label: "type-yes-insert",
      act: (p) =>
        p
          .locator("article")
          .filter({ hasText: "Should I run prisma migrate? y/n" })
          .first()
          .getByRole("button", { name: "Type yes without submitting" })
          .click(),
      expect: async (p) => {
        const row = p
          .locator("article")
          .filter({ hasText: "Should I run prisma migrate? y/n" })
          .first();
        const status = row.getByRole("status");
        await status
          .filter({ hasText: "Typed into the pane" })
          .waitFor({ state: "visible" });
        if (
          (await row
            .getByRole("button", { name: "Type yes without submitting" })
            .count()) > 0
        )
          throw new Error("insert button still offered after insert");
        if (
          (await row.getByRole("button", { name: "Reply" }).count()) === 0
        )
          throw new Error("Reply missing after insert");
        const badge = nav(p, "Inbox")
          .locator("span")
          .filter({ hasText: /^\d+$/ });
        if ((await badge.count()) === 0)
          throw new Error("unresolved badge gone after insert");
        return status;
      },
    },
    {
      label: "reply-enter",
      act: (p) =>
        p
          .locator("article")
          .filter({ hasText: "Should I run prisma migrate? y/n" })
          .first()
          .getByRole("button", { name: "Reply" })
          .click(),
      expect: async (p) => {
        const controls = p.getByRole("group", { name: "Blocked reply controls" });
        await controls.waitFor({ state: "visible" });
        await p.getByRole("button", { name: "Enter", exact: true }).waitFor({
          state: "visible",
        });
        return controls;
      },
    },
    {
      label: "enter-answers",
      act: async (p) => {
        await p.getByRole("button", { name: "Enter", exact: true }).click();
        await p.getByRole("button", { name: "Back", exact: true }).click();
      },
      expect: async (p) => {
        const answered = p.getByRole("button", {
          name: /answered migrate.*Should I run prisma migrate\? y\/n/i,
        });
        await answered.waitFor({ state: "visible" });
        if (await p.locator("article").filter({ hasText: "Should I run prisma migrate? y/n" }).count())
          throw new Error("answered event remains in Needs you");
        return answered;
      },
    },
    {
      label: "answered-row-persists",
      expect: async (p) => {
        const row = p.getByRole("button", {
          name: /answered migrate.*Should I run prisma migrate\? y\/n/i,
        });
        await row.waitFor({ state: "visible" });
        return row;
      },
    },
  ],
};

const steps = SCENARIOS[scenario];
if (!steps) {
  console.error(`unknown scenario: ${scenario}`);
  process.exit(2);
}

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
  if (scenario !== "onboard") await completeOnboarding(page);
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
          path: path.join(
            out,
            `${String(i).padStart(2, "0")}-${name}-FAIL.png`,
          ),
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
    ? `\ndrive ${scenario}: FAILED`
    : `\ndrive ${scenario}: passed (${out})`,
);
process.exit(failed ? 1 : 0);
