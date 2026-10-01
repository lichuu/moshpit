import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const state = await mkdtemp(path.join(tmpdir(), "moshpit-terminal-send-"));
const child = spawn(process.execPath, ["bridge/index.mjs"], {
  cwd: root,
  env: { ...process.env, MOSHPIT_PORT: "0", MOSHPIT_BIND: "127.0.0.1", MOSHPIT_TRUSTED_USER: "send-check", MOSHPIT_STATE_DIR: state, MOSHPIT_HERDR_BIN: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
let browser;
try {
  // The bridge startup log reports the configured port, so discover its ephemeral listener.
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Bridge startup timed out")), 10000);
    child.stdout.once("data", () => { clearTimeout(timer); resolve(); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error("Bridge exited")); });
  });
  const { execFileSync } = await import("node:child_process");
  const sockets = execFileSync("ss", ["-ltnp"], { encoding: "utf8" });
  const line = sockets.split("\n").find(row => row.includes(`pid=${child.pid},`));
  assert.ok(line, "Isolated bridge listener found");
  const port = line.match(/127\.0\.0\.1:(\d+)/)?.[1];
  assert.ok(port);
  browser = await chromium.launch();
  for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
    const context = await browser.newContext({ viewport, extraHTTPHeaders: { "tailscale-user-login": "send-check" } });
    await context.addInitScript(() => {
      window.SpeechRecognition = class {
        start() { this.onresult?.({ results: [[{ transcript: "dictated terminal message" }]] }); this.onend?.(); }
        stop() { this.onend?.(); }
      };
    });
    const page = await context.newPage();
    const sent = [];
    let closes = 0;
    let fallback = 0;
    page.on("websocket", socket => {
      if (!socket.url().includes("/pty")) return;
      socket.on("framesent", event => sent.push(JSON.parse(String(event.payload))));
      socket.on("close", () => closes++);
    });
    page.on("request", request => {
      if (!request.url().endsWith("/api/action")) return;
      const body = request.postDataJSON();
      if (body?.kind !== "start") fallback++;
    });
    await page.goto(`http://127.0.0.1:${port}`, { waitUntil: "networkidle" });
    const project = page.locator(".project-group").filter({ has: page.getByRole("button", { name: /^migrate/, includeHidden: true }) }).first();
    const projectToggle = project.getByRole("button", { name: /^Project / });
    await projectToggle.waitFor();
    await projectToggle.click();
    assert.equal(await project.getByRole("button", { name: /^migrate/ }).isVisible(), false);
    assert.ok((await projectToggle.innerText()).includes("waiting"), "Collapsed projects retain attention counts");
    await page.reload({ waitUntil: "networkidle" });
    assert.equal(await projectToggle.getAttribute("aria-expanded"), "false", "Collapsed projects persist across reload");
    await page.getByRole("button", { name: /^Blocked/ }).click();
    assert.equal(await project.getByRole("button", { name: /^migrate/ }).isVisible(), true, "Filtering reveals matching child agents");
    await page.getByRole("button", { name: "All", exact: true }).click();
    await projectToggle.click();
    await page.screenshot({ path: path.join(state, `projects-${viewport.width}.png`) });
    console.log("ok   project children, collapse persistence, attention counts, filtering");
    await page.getByRole("button", { name: "New agent in web" }).click();
    const sheet = page.getByRole("dialog");
    await sheet.getByRole("button", { name: "pi", exact: true }).click();
    const heading = page.getByRole("heading", { name: /^pi-/ });
    await heading.waitFor();
    const started = (await heading.innerText()).trim();
    const back = page.getByRole("button", { name: "Back", exact: true });
    if (await back.count()) await back.click();
    await page.getByRole("button", { name: new RegExp(`^${started}`) }).waitFor();
    console.log("ok   new agent starts in the project");
    await page.getByRole("button", { name: /^migrate/ }).click();
    assert.equal(await page.getByRole("button", { name: "Skip", exact: true }).count(), 0, "A detected bridge skips first-run onboarding");
    await page.getByRole("button", { name: "Terminal view" }).click();
    const input = page.getByRole("textbox", { name: "Terminal input", exact: true });
    await input.waitFor();
    await page.waitForTimeout(500);
    const initialCloses = closes;
    for (const message of [`single click proof ${viewport.width}`, `second message proof ${viewport.width}`]) {
      await input.fill(message);
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await page.waitForTimeout(300);
      assert.equal(closes, initialCloses, "Clicking Send must not close the terminal connection");
      assert.equal(fallback, 0, "Raw input must not fall back to the prompt API");
      assert.deepEqual(sent.slice(-2).map(frame => frame.keys), [message, "\r"]);
      assert.equal(await input.inputValue(), "");
      await page.getByRole("application").getByText(message, { exact: true }).waitFor();
    }
    const keyboardMessage = `keyboard enter proof ${viewport.width}`;
    await input.fill(keyboardMessage);
    await input.press("Enter");
    await page.waitForTimeout(300);
    assert.deepEqual(sent.slice(-2).map(frame => frame.keys), [keyboardMessage, "\r"]);
    await input.blur();
    await page.getByRole("application").getByText(keyboardMessage, { exact: true }).waitFor();
    assert.equal(closes, initialCloses, "Blur must repaint buffered terminal updates without reconnecting");
    await page.getByRole("button", { name: "Dictate", exact: true }).click();
    assert.equal(await input.inputValue(), "dictated terminal message", "Speech result populates the shared terminal composer");
    if (viewport.width === 390) {
      await input.focus();
      await page.evaluate(() => {
        Object.defineProperty(visualViewport, "height", { configurable: true, value: 420 });
        Object.defineProperty(visualViewport, "offsetTop", { configurable: true, value: 96 });
        visualViewport.dispatchEvent(new Event("resize"));
        visualViewport.dispatchEvent(new Event("scroll"));
      });
      const frame = await page.locator(".app-viewport").boundingBox();
      assert.equal(frame.y, 96, "App follows the visible viewport offset");
      assert.equal(frame.height, 420);
      assert.equal(await page.locator(".workspace-nav").isVisible(), false, "Keyboard hides bottom navigation");
      const composer = await input.boundingBox();
      assert.ok(composer.y >= 96 && composer.y + composer.height <= 516, "Composer stays above the keyboard");
      await page.screenshot({ path: path.join(state, "keyboard-offset.png") });
      await page.evaluate(() => {
        delete visualViewport.height;
        delete visualViewport.offsetTop;
        visualViewport.dispatchEvent(new Event("resize"));
      });
      assert.equal(await page.locator(".workspace-nav").isVisible(), true);
    }
    await input.fill("");
    const spacing = await page.locator(".ear-tag").first().evaluate(element => {
      const style = getComputedStyle(element);
      const marker = getComputedStyle(element, "::before");
      return parseFloat(style.paddingLeft) - parseFloat(marker.left) - parseFloat(marker.width);
    });
    assert.ok(spacing >= 6, `Status marker gap must be at least 6px, got ${spacing}`);
    await page.screenshot({ path: path.join(state, `terminal-${viewport.width}.png`) });
    await page.reload({ waitUntil: "networkidle" });
    assert.equal(await page.getByRole("button", { name: "Skip", exact: true }).count(), 0, "Reload never repeats onboarding");
    let outputFixture = "› Real request\n• Real answer\n› Ask Codex to do anything";
    let chatFixture = "Real answer";
    let chatAvailable = true;
    await page.route("**/api/agent-detail?*", route => route.fulfill({
      json: {
        agentId: "migrate", revision: 1,
        output: outputFixture,
        conversation: chatAvailable ? { kind: "available", messages: [
          { role: "user", text: "Real request" },
          { role: "agent", text: chatFixture },
          { role: "user", text: "Ask Codex to do anything" },
        ] } : { kind: "unavailable", reason: "No turn markers" },
      },
    }));
    await page.getByRole("button", { name: /^migrate/ }).first().click();
    await page.getByRole("button", { name: "Terminal view", exact: true }).click();
    await page.getByRole("button", { name: "Chat view", exact: true }).click();
    await page.locator(".conversation").getByText("Real answer", { exact: true }).waitFor();
    const agentBubble = page.locator('.conversation [data-role="agent"]').first();
    const userBubble = page.locator('.conversation [data-role="user"]').first();
    const bubbleStyle = await agentBubble.evaluate(el => {
      const style = getComputedStyle(el);
      return { radius: parseFloat(style.borderTopLeftRadius), padding: parseFloat(style.paddingLeft), background: style.backgroundColor };
    });
    assert.ok(bubbleStyle.radius >= 12 && bubbleStyle.padding >= 12, "Agent replies have padded rounded bubbles");
    assert.notEqual(bubbleStyle.background, "rgba(0, 0, 0, 0)");
    assert.ok((await agentBubble.boundingBox()).x < (await userBubble.boundingBox()).x, "Agent bubbles align left; user bubbles align right");
    await page.screenshot({ path: path.join(state, `chat-bubbles-${viewport.width}.png`) });
    assert.ok(!(await page.locator(".conversation").innerText()).includes("Ask Codex to do anything"));
    await page.locator('nav[aria-label="Agent views"]').getByText("Output", { exact: true }).click();
    await page.getByLabel("Agent output", { exact: true }).waitFor();
    assert.ok((await page.getByLabel("Agent output", { exact: true }).textContent()).includes("› Ask Codex to do anything"));
    console.log("ok   Codex placeholder hidden in Chat and preserved in Output");
    const code = 'const count: number = 42;\nconst text = "' + "long_unbroken_code_".repeat(30) + '";\n';
    chatFixture = '# Formatted answer\n\n**Bold** and `inline code`\n\n- First\n- Second\n\n```typescript\n' + code + '```\n\n| Name | Value |\n| --- | --- |\n| Result | ready |\n\n<script>window.chatUnsafe = true</script>\n\n![tracker](https://example.invalid/track.png)\n\n' + "─".repeat(172) + '\n~/projects/moshpit (master)\n↑411k ↓2.5k 13.4%/262k (auto) (llamacpp) qwen3.8 • medium\n bg 1 done · Shift↓ · /bg-clear';
    for (const scheme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.getByRole("button", { name: "Terminal view", exact: true }).click();
      await page.getByRole("button", { name: "Chat view", exact: true }).click();
      const markdown = page.locator('.conversation [data-role="agent"] .chat-markdown');
      await markdown.locator(".hljs-keyword").first().waitFor();
      assert.equal(await markdown.locator("h1").innerText(), "Formatted answer");
      assert.equal(await markdown.locator("strong").innerText(), "Bold");
      assert.equal(await markdown.locator("li").count(), 2);
      assert.equal(await markdown.locator("table td").count(), 2);
      assert.equal(await markdown.locator("pre code").textContent(), code);
      assert.equal(await markdown.locator("script, img").count(), 0);
      assert.ok(!(await markdown.innerText()).includes("↑411k"));
      assert.ok(!(await markdown.innerText()).includes("/bg-clear"));
      assert.ok(await markdown.evaluate(el => el.scrollWidth <= el.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth), "Markdown wraps without horizontal scrolling");
      await page.locator(".conversation").evaluate(el => { el.scrollTop = 0; });
      await page.screenshot({ path: path.join(state, `markdown-${viewport.width}-${scheme}.png`) });
    }
    console.log("ok   Chat Markdown, syntax, tables, safe HTML, footer filtering, phone/desktop wrapping");
    chatAvailable = false;
    outputFixture = chatFixture;
    await page.getByRole("button", { name: "Terminal view", exact: true }).click();
    await page.getByRole("button", { name: "Chat view", exact: true }).click();
    await page.locator(".conversation .hljs-keyword").first().waitFor();
    assert.ok(!(await page.locator(".conversation").innerText()).includes("─".repeat(20)), "Fallback strips footer separators across blank lines");
    assert.equal(await page.locator(".conversation pre code").textContent(), code);
    await page.getByRole("button", { name: "Exact terminal output", exact: true }).click();
    assert.ok((await page.getByLabel("Agent output", { exact: true }).textContent()).includes("↑411k"), "Footer remains in Output");
    chatAvailable = true;
    for (const dark of [false, true]) {
      await page.emulateMedia({ colorScheme: dark ? "dark" : "light" });
      outputFixture = "\u001b[31merror\u001b[0m\n\u001b[38;2;12;34;56mRGB\u001b[0m\n  literal <script>alert(1)</script>";
      await page.getByRole("button", { name: "Terminal view", exact: true }).click();
      await page.getByRole("button", { name: "Exact terminal output", exact: true }).click();
      const output = page.getByLabel("Agent output", { exact: true });
      await output.getByText("error", { exact: true }).waitFor();
      const color = await output.getByText("error", { exact: true }).evaluate(el => getComputedStyle(el).color);
      assert.equal(color, dark ? "rgb(239, 154, 148)" : "rgb(177, 60, 63)");
      assert.equal(await output.getByText("RGB", { exact: true }).evaluate(el => getComputedStyle(el).color), "rgb(12, 34, 56)");
      assert.equal(await output.locator("script").count(), 0);
      assert.equal(await output.textContent(), "error\nRGB\n  literal <script>alert(1)</script>");
      outputFixture = '```typescript\nconst count: number = 42;\n  const text = "' + "long_unbroken_code_".repeat(30) + '";\n```\n';
      await page.getByRole("button", { name: "Terminal view", exact: true }).click();
      await page.getByRole("button", { name: "Exact terminal output", exact: true }).click();
      await output.locator(".hljs-keyword").first().waitFor();
      assert.equal(await output.textContent(), outputFixture, "Highlighting preserves every character and fence");
      assert.ok(await output.evaluate(el => el.scrollWidth <= el.clientWidth + 1 && el.parentElement.scrollWidth <= el.parentElement.clientWidth + 1), "Long code wraps without horizontal scrolling");
      await page.screenshot({ path: path.join(state, `output-${viewport.width}-${dark ? "dark" : "light"}.png`) });
    }
    console.log("ok   Output ANSI, light/dark theme switching, fenced syntax, whitespace, safe HTML");
    console.log(`ok   ${viewport.width}px: single-click raw send, repeat send, stable connection, status spacing`);
    const kinds = ["claude-code", "codex", "pi", "opencode", "grok", "hermes", "gemini", "cursor", "github-copilot", "amp", "cline", "deepseek", "windsurf"];
    await page.route("**/api/snapshot", async route => {
      const response = await route.fetch();
      const snapshot = await response.json();
      const template = snapshot.agents[0];
      await route.fulfill({ json: { ...snapshot, agents: kinds.map((kind, index) => ({
        ...template, id: `icon-${kind}`, paneId: `icon-${kind}`, name: `Icon ${index}`, title: `Original title ${index}`, lastOutput: `Original title ${index}`, kind, status: "idle", attention: false,
      })) } });
    });
    await page.reload({ waitUntil: "networkidle" });
    for (const kind of kinds) {
      const icon = page.locator(`.agent-card [data-agent-kind="${kind}"]`);
      await icon.waitFor();
      assert.ok(await icon.evaluate(async el => {
        const mask = getComputedStyle(el).maskImage;
        const url = mask.match(/^url\("(.*)"\)$/)?.[1];
        if (!url) return false;
        const image = new Image();
        image.src = url;
        await image.decode();
        return image.naturalWidth > 0 && el.getBoundingClientRect().width >= 16;
      }), `${kind} logo decodes and has a visible size`);
    }
    for (const scheme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.screenshot({ path: path.join(state, `agent-icons-${viewport.width}-${scheme}.png`) });
    }
    assert.ok((await page.locator(".agent-list").innerText()).includes("Original title 0"), "Provider icons do not rewrite titles");
    assert.equal(await page.locator(".agent-card").first().getByText("Original title 0", { exact: true }).count(), 1, "Title is not duplicated as the preview");
    console.log("ok   catalog logos decode locally; original titles preserved and not duplicated");
    await context.close();
  }
  console.log(`Evidence: ${state}`);
} finally {
  await browser?.close();
  child.kill();
}
