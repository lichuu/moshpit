import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const state = await mkdtemp(path.join(tmpdir(), "moshpit-live-detail-"));
const child = spawn(process.execPath, ["bridge/index.mjs"], {
  cwd: root,
  env: {
    ...process.env,
    MOSHPIT_PORT: "0",
    MOSHPIT_BIND: "127.0.0.1",
    MOSHPIT_TRUSTED_USER: "detail-check",
    MOSHPIT_STATE_DIR: state,
    MOSHPIT_HERDR_BIN: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let browser;
try {
  // The bridge startup log reports the configured port, so discover its ephemeral listener.
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Bridge startup timed out")),
      10000,
    );
    child.stdout.once("data", () => {
      clearTimeout(timer);
      resolve();
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("Bridge exited"));
    });
  });
  const { execFileSync } = await import("node:child_process");
  const sockets = execFileSync("ss", ["-ltnp"], { encoding: "utf8" });
  const line = sockets
    .split("\n")
    .find((row) => row.includes(`pid=${child.pid},`));
  assert.ok(line, "Isolated bridge listener found");
  const port = line.match(/127\.0\.0\.1:(\d+)/)?.[1];
  assert.ok(port);
  browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    extraHTTPHeaders: { "tailscale-user-login": "detail-check" },
  });
  const page = await context.newPage();
  let text = "Streaming chunk one";
  let failed = false;
  let requests = 0;
  let active = 0;
  let maxActive = 0;
  await page.route("**/api/agent-detail?*", async (route) => {
    requests++;
    active++;
    maxActive = Math.max(maxActive, active);
    const agentId = new URL(route.request().url()).searchParams.get("target");
    const chunk = text;
    await new Promise((resolve) => setTimeout(resolve, 100));
    active--;
    await route
      .fulfill({
        status: failed ? 503 : 200,
        json: {
          agentId,
          revision: 1,
          output: chunk,
          conversation: {
            kind: "available",
            messages: [{ role: "agent", text: chunk }],
          },
        },
      })
      .catch(() => {});
  });
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /^migrate/ }).click();
  await page.getByRole("button", { name: "Chat view", exact: true }).click();
  const input = page.getByRole("textbox", { name: "Message agent" });
  await page
    .locator('[data-role="agent"]')
    .getByText(text, { exact: true })
    .waitFor();
  await input.fill("Keep my unsent draft");
  text = "Streaming chunk two, still working";
  await page
    .locator('[data-role="agent"]')
    .getByText(text, { exact: true })
    .waitFor({ timeout: 3000 });
  assert.equal(await input.inputValue(), "Keep my unsent draft");
  assert.equal(
    await input.evaluate((el) => el === document.activeElement),
    true,
  );
  await page.getByRole("button", { name: "Exact terminal output" }).click();
  text = "Output changes while the same revision is still active";
  await page
    .getByLabel("Agent output", { exact: true })
    .getByText(text, { exact: true })
    .waitFor({ timeout: 3000 });
  failed = true;
  await page.waitForTimeout(800);
  assert.ok(
    (
      await page.getByLabel("Agent output", { exact: true }).innerText()
    ).includes(text),
    "Failure preserves last readable output",
  );
  failed = false;
  text = "Recovered without a new agent response";
  await page
    .getByLabel("Agent output", { exact: true })
    .getByText(text, { exact: true })
    .waitFor({ timeout: 3000 });
  assert.equal(maxActive, 1, "Detail reads never overlap");
  await page.getByRole("button", { name: "Chat view", exact: true }).click();
  text = "Growing answer " + "streamed text ".repeat(400) + "first tail";
  const conversation = page.locator(".conversation");
  await conversation
    .getByText(text, { exact: true })
    .waitFor({ timeout: 3000 });
  await page.waitForTimeout(100);
  text += "more words ".repeat(400) + "second tail";
  await conversation
    .getByText(text, { exact: true })
    .waitFor({ timeout: 3000 });
  await page.waitForTimeout(100);
  assert.ok(
    await conversation.evaluate(
      (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 48,
    ),
    "Follows growing output with the same line count",
  );
  await conversation.evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  text += " and another chunk";
  await conversation
    .getByText(text, { exact: true })
    .waitFor({ timeout: 3000 });
  assert.ok(
    await conversation.evaluate((el) => el.scrollTop < 48),
    "Reading earlier output keeps its scroll position",
  );
  await page.getByRole("button", { name: "Exact terminal output" }).click();

  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(200);
  const hiddenRequests = requests;
  await page.waitForTimeout(800);
  assert.equal(requests, hiddenRequests, "Hidden page pauses polling");
  text = "Fresh after returning to the PWA";
  await page.evaluate(() => {
    delete document.hidden;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page
    .getByLabel("Agent output", { exact: true })
    .getByText(text, { exact: true })
    .waitFor({ timeout: 3000 });
  await page
    .getByRole("button", { name: "Terminal view", exact: true })
    .click();
  const terminalRequests = requests;
  await page.waitForTimeout(900);
  assert.equal(
    requests,
    terminalRequests,
    "Terminal unmount stops detail polling",
  );
  console.log(
    "ok live detail: unchanged revision, focused draft, Chat/Output, recovery, single request, visibility, unmount",
  );
  await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem("moshpit-v1"));
    const host = saved.state.hosts.find(
      (h) => h.id === saved.state.connectedHostId,
    );
    host.label = "box.tail1.ts.net";
    localStorage.setItem("moshpit-v1", JSON.stringify(saved));
  });
  await page.reload({ waitUntil: "networkidle" });
  const label = page.locator(
    '.sidebar-footer [title="box.tail1.ts.net"]',
  );
  await label.waitFor();
  const layout = await label.evaluate((el) => ({
    overflow: getComputedStyle(el).textOverflow,
    height: el.getBoundingClientRect().height,
    line: parseFloat(getComputedStyle(el).lineHeight),
  }));
  assert.equal(layout.overflow, "ellipsis");
  assert.ok(
    layout.height <= layout.line + 1,
    "Sidebar hostname stays on one line",
  );
  await page.screenshot({ path: path.join(state, "sidebar-host.png") });
  console.log(`ok sidebar hostname; evidence: ${state}`);
} finally {
  await browser?.close();
  child.kill();
}
