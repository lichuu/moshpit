import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { test, expect, openApp, seedHosts, loginBridge, pairBridge, isPhone } from "../fixtures";

const QUESTION = "How should the generated file be indented?";
const CARD_ONE = [
  "Question 1/2 (2 unanswered)",
  QUESTION,
  "› 1. Tabs (Recommended)  Indent code with tab characters.",
  "  2. Spaces              Indent code with space characters.",
  "",
  "tab to add notes | enter to submit answer | ←/→ to navigate questions | esc to interrupt",
].join("\n");
const CARD_TWO = CARD_ONE.replace("Question 1/2 (2 unanswered)", "Question 2/2 (1 unanswered)");
const CLAUDE_CARD = [
  "Earlier assistant output.",
  "────────────────────────────────────────",
  "← ☐ Indent  ☐ Width  ✔ Submit →",
  "",
  QUESTION,
  "",
  "  1. Tabs (Recommended)",
  "     Indent code with tab characters.",
  "❯ 2. Spaces",
  "     Indent code with space characters.",
  "  3. Type something.",
  "────────────────────────────────────────",
  "  4. Chat about this",
  "",
  "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
].join("\n");
const CLAUDE_NEXT = CLAUDE_CARD.replace(QUESTION, "Which indentation width should we use?")
  .replace("← ☐ Indent  ☐ Width", "← ☑ Indent  ☐ Width")
  .replace("Tabs (Recommended)", "4 spaces").replace("Spaces", "8 spaces");
const CLAUDE_REVIEW = [
  "────────────────────────────────────────",
  "← ☑ Indent  ☑ Width  ✔ Submit →",
  "Review your answers",
  "",
  QUESTION,
  "  → Tabs (Recommended)",
  "Which indentation width should we use?",
  "  → 4 spaces",
  "",
  "Ready to submit your answers?",
  "❯ 1. Submit answers",
  "  2. Cancel",
].join("\n");
const CLAUDE_SESSION = JSON.stringify({
  type: "assistant",
  uuid: "tool-1",
  message: { content: [{
    type: "tool_use", id: "question-1", name: "AskUserQuestion",
    input: { questions: [
      { header: "Indent", question: QUESTION, multiSelect: false, options: [
        { label: "Tabs (Recommended)", description: "Indent code with tab characters." },
        { label: "Spaces", description: "Indent code with space characters." },
      ] },
      { header: "Width", question: "Which indentation width should we use?", multiSelect: false, options: [
        { label: "4 spaces", description: "Indent code with tab characters." },
        { label: "8 spaces", description: "Indent code with space characters." },
      ] },
    ] },
  }] },
}) + "\n";
const claudeHerdr = `
case "$*" in
  "api snapshot"*) if [ -f "$MOSHPIT_STATE_DIR/submitted" ]; then status=working; else status=blocked; fi; printf '{"result":{"snapshot":{"agents":[{"pane_id":"w1:p1","agent":"claude","agent_status":"%s","cwd":"/repo/app","workspace_id":"w1","terminal_title":"claude","agent_session":{"kind":"id","value":"session"},"revision":1}]}}}' "$status" ;;
  "pane list"*) echo '{"result":{"panes":[{"pane_id":"w1:p1","label":"answerer","cwd":"/repo/app","workspace_id":"w1"}]}}' ;;
  "pane read w1:p1"*) if [ -f "$MOSHPIT_STATE_DIR/review" ]; then printf '%b' ${JSON.stringify(CLAUDE_REVIEW)}; elif [ -f "$MOSHPIT_STATE_DIR/answered" ]; then printf '%b' ${JSON.stringify(CLAUDE_NEXT)}; else printf '%b' ${JSON.stringify(CLAUDE_CARD)}; fi ;;
  "pane send-text w1:p1"*) printf '%s\\n' "$4" >> "$MOSHPIT_STATE_DIR/answer-keys"; if [ -f "$MOSHPIT_STATE_DIR/hold" ]; then echo '{}'; exit 0; fi; if [ -f "$MOSHPIT_STATE_DIR/review" ]; then touch "$MOSHPIT_STATE_DIR/submitted"; elif [ -f "$MOSHPIT_STATE_DIR/answered" ]; then touch "$MOSHPIT_STATE_DIR/review"; else touch "$MOSHPIT_STATE_DIR/answered"; fi; echo '{}' ;;
  "pane send-keys w1:p1"*) printf '%s\\n' "$4" >> "$MOSHPIT_STATE_DIR/answer-keys"; echo '{}' ;;
  *) echo '{}' ;;
esac`;
const SESSION = [
  {
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Please choose the indentation." }],
    },
    id: "message-1",
  },
  {
    type: "response_item",
    payload: {
      type: "custom_tool_call",
      call_id: "question-1",
      name: "request_user_input",
      input: JSON.stringify({
        questions: [{
          question: QUESTION,
          options: [
            { label: "Tabs (Recommended)", description: "Indent code with tab characters." },
            { label: "Spaces", description: "Indent code with space characters." },
          ],
        }],
      }),
    },
    id: "tool-1",
  },
].map((row) => JSON.stringify(row)).join("\n") + "\n";

const herdr = `
case "$*" in
  "api snapshot"*) echo '{"result":{"snapshot":{"agents":[{"pane_id":"w1:p1","agent":"codex","agent_status":"blocked","cwd":"/repo/app","workspace_id":"w1","terminal_title":"codex","agent_session":{"kind":"id","value":"session"},"revision":1}]}}}' ;;
  "pane list"*) echo '{"result":{"panes":[{"pane_id":"w1:p1","label":"answerer","cwd":"/repo/app","workspace_id":"w1"}]}}' ;;
  "pane read w1:p1"*) if [ -f "$MOSHPIT_STATE_DIR/answered" ]; then printf '%b' ${JSON.stringify(CARD_TWO)}; else printf '%b' ${JSON.stringify(CARD_ONE)}; fi ;;
  "pane send-text w1:p1"*) touch "$MOSHPIT_STATE_DIR/answered"; echo '{}' ;;
  *) echo '{}' ;;
esac`;

async function connectAnswerer(page: import("@playwright/test").Page, host: { url: string; port: number }) {
  await openApp(page, { demo: false });
  const token = await loginBridge(page, host.url);
  await pairBridge(page, host.url, token);
  await seedHosts(page, [{
    id: "e2e",
    label: "E2E",
    transport: "tailscale",
    user: "",
    hostname: "127.0.0.1",
    port: host.port,
    demo: false,
    tailnetUrl: host.url,
  }], "e2e");
  await expect(page.getByRole("button", { name: /answerer/ }).first()).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: /answerer/ }).first().click();
}

async function openAnswerer(page: import("@playwright/test").Page, host: { url: string; port: number }) {
  await connectAnswerer(page, host);
  await expect(page.getByRole("button", { name: `Answer ${QUESTION}: Tabs (Recommended)` })).toBeVisible({ timeout: 20_000 });
}

test.describe("Claude AskUserQuestion taps", () => {
  test("an unchanged consumed card stays guarded after navigating to Inbox", async ({ page, bridge }, testInfo) => {
    const host = await bridge({ herdr: claudeHerdr, home: { ".claude/projects/app/session.jsonl": CLAUDE_SESSION } });
    await writeFile(path.join(host.dir, "state", "hold"), "");
    await openAnswerer(page, host);
    const first = page.getByRole("button", { name: `Answer ${QUESTION}: Tabs (Recommended)` });
    if (isPhone(testInfo)) await first.tap();
    else await first.click();
    await expect(first).toBeDisabled();
    await page.waitForResponse((response) => response.url().startsWith(`${host.url}/api/snapshot`));
    await expect(first).toBeDisabled();
    await page.getByRole("button", { name: /Inbox/ }).first().click();
    const inboxFirst = page.getByRole("button", { name: "1. Tabs (Recommended)", exact: true });
    await expect(inboxFirst).toBeVisible();
    const refused = page.waitForResponse((response) => response.url() === `${host.url}/api/action`);
    if (isPhone(testInfo)) await inboxFirst.tap();
    else await inboxFirst.click();
    const response = await refused;
    expect(response.request().postDataJSON().kind).toBe("answer");
    expect(response.ok()).toBe(false);
    expect(await readFile(path.join(host.dir, "state", "answer-keys"), "utf8")).toBe("1\n");
  });

  test("Chat matches wrapped questions, labels, and descriptions", async ({ page, bridge }, testInfo) => {
    const wrapped = CLAUDE_CARD.replace(QUESTION, "How should the generated\nfile be indented?")
      .replace("  1. Tabs (Recommended)", "  1. Tabs\n     (Recommended)")
      .replace("Indent code with tab characters.", "Indent code with tab\n     characters.");
    const host = await bridge({
      herdr: claudeHerdr.replace(JSON.stringify(CLAUDE_CARD), JSON.stringify(wrapped)),
      home: { ".claude/projects/app/session.jsonl": CLAUDE_SESSION },
    });
    await openAnswerer(page, host);
    const first = page.getByRole("button", { name: `Answer ${QUESTION}: Tabs (Recommended)` });
    await expect(first).toBeEnabled();
    if (isPhone(testInfo)) await first.tap();
    else await first.click();
    await expect(page.getByRole("button", { name: "Answer Which indentation width should we use?: 4 spaces" })).toBeEnabled({ timeout: 10_000 });
    expect(await readFile(path.join(host.dir, "state", "answer-keys"), "utf8")).toBe("1\n");
  });

  test("Chat answers the active question and unlocks the next question", async ({ page, bridge }, testInfo) => {
    const host = await bridge({ herdr: claudeHerdr, home: { ".claude/projects/app/session.jsonl": CLAUDE_SESSION } });
    await openAnswerer(page, host);
    const first = page.getByRole("button", { name: `Answer ${QUESTION}: Tabs (Recommended)` });
    const next = page.getByRole("button", { name: "Answer Which indentation width should we use?: 4 spaces" });
    await expect(first).toBeEnabled();
    await expect(next).toBeDisabled();
    if (isPhone(testInfo)) await first.tap();
    else await first.click();
    await expect(next).toBeEnabled({ timeout: 10_000 });
    expect(await readFile(path.join(host.dir, "state", "answer-keys"), "utf8")).toBe("1\n");
  });

  test("Inbox retains options above the cursor and submits a tapped answer", async ({ page, bridge }, testInfo) => {
    const host = await bridge({ herdr: claudeHerdr, home: { ".claude/projects/app/session.jsonl": CLAUDE_SESSION } });
    await connectAnswerer(page, host);
    await page.getByRole("button", { name: /Inbox/ }).first().click();
    const first = page.getByRole("button", { name: "1. Tabs (Recommended)", exact: true });
    await expect(first).toBeVisible();
    await expect(first).toBeEnabled();
    if (isPhone(testInfo)) await first.tap();
    else await first.click();
    const inboxRow = page.locator("article").filter({ has: page.getByRole("button", { name: "Reply", exact: true }) });
    await expect(inboxRow.getByText("Which indentation width should we use?", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => readFile(path.join(host.dir, "state", "answer-keys"), "utf8").catch(() => "")).toBe("1\n");
    expect(await readFile(path.join(host.dir, "state", "answer-keys"), "utf8")).toBe("1\n");
  });

  for (const surface of ["Chat", "Inbox"]) {
    test(`${surface} waits for an explicit review submission`, async ({ page, bridge }, testInfo) => {
      const host = await bridge({ herdr: claudeHerdr, home: { ".claude/projects/app/session.jsonl": CLAUDE_SESSION } });
      await openAnswerer(page, host);
      if (surface === "Inbox") await page.getByRole("button", { name: /Inbox/ }).first().click();
      const first = page.getByRole("button", { name: surface === "Chat" ? `Answer ${QUESTION}: Tabs (Recommended)` : "1. Tabs (Recommended)", exact: true });
      await expect(first).toBeEnabled();
      await page.screenshot({ path: `/tmp/moshpit-question-${testInfo.project.name}-${surface.toLowerCase()}-choices.png` });
      if (isPhone(testInfo)) await first.tap();
      else await first.click();
      const next = page.getByRole("button", { name: surface === "Chat" ? "Answer Which indentation width should we use?: 4 spaces" : "1. 4 spaces", exact: true });
      await expect(next).toBeEnabled({ timeout: 10_000 });
      if (isPhone(testInfo)) await next.tap();
      else await next.click();
      const submit = page.getByRole("button", { name: surface === "Chat" ? "1 Submit answers" : "1. Submit answers", exact: true });
      await expect(submit).toBeEnabled({ timeout: 10_000 });
      await page.screenshot({ path: `/tmp/moshpit-question-${testInfo.project.name}-${surface.toLowerCase()}-review.png` });
      expect(await readFile(path.join(host.dir, "state", "answer-keys"), "utf8")).toBe("1\n1\n");
      if (isPhone(testInfo)) await submit.tap();
      else await submit.click();
      await expect(submit).toBeHidden({ timeout: 10_000 });
      expect(await readFile(path.join(host.dir, "state", "answer-keys"), "utf8")).toBe("1\n1\n1\n");
    });
  }
});

test.describe("live answer locks", () => {
  test("conversation locks every sibling until the delayed response advances the token", async ({ page, bridge }) => {
    const host = await bridge({
      herdr,
      home: { ".codex/sessions/foo-session.jsonl": SESSION },
    });
    await openAnswerer(page, host);

    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route(`${host.url}/api/action`, async (route) => {
      const response = await route.fetch();
      await held;
      await route.fulfill({ response });
    });

    const first = page.getByRole("button", { name: `Answer ${QUESTION}: Tabs (Recommended)` });
    const second = page.getByRole("button", { name: `Answer ${QUESTION}: Spaces` });
    await first.click();
    await expect(first).toBeDisabled();
    await expect(second).toBeDisabled();

    release();
    await expect(second).toBeEnabled({ timeout: 10_000 });
  });

  test("a failed conversation answer unlocks the card and permits a retry", async ({ page, bridge }) => {
    const host = await bridge({
      herdr,
      home: { ".codex/sessions/foo-session.jsonl": SESSION },
    });
    await openAnswerer(page, host);

    let failed = true;
    await page.route(`${host.url}/api/action`, async (route) => {
      if (failed) {
        failed = false;
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { message: "answer refused" } }) });
        return;
      }
      await route.continue();
    });

    const first = page.getByRole("button", { name: `Answer ${QUESTION}: Tabs (Recommended)` });
    const second = page.getByRole("button", { name: `Answer ${QUESTION}: Spaces` });
    await first.click();
    await expect(second).toBeEnabled({ timeout: 10_000 });

    await first.click();
    await expect(second).toBeEnabled({ timeout: 10_000 });
  });

  test("a failed composer fallback answer unlocks and permits a retry", async ({ page, bridge }) => {
    const host = await bridge({ herdr });
    await connectAnswerer(page, host);

    const first = page.getByRole("button", { name: "1 Tabs (Recommended)" });
    const second = page.getByRole("button", { name: "2 Spaces" });
    await expect(first).toBeVisible({ timeout: 20_000 });

    let failed = true;
    await page.route(`${host.url}/api/action`, async (route) => {
      if (failed) {
        failed = false;
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { message: "answer refused" } }) });
        return;
      }
      await route.continue();
    });

    await first.click();
    await expect(second).toBeEnabled({ timeout: 10_000 });
    await first.click();
    await expect(second).toBeEnabled({ timeout: 10_000 });
  });

  test("a failed Inbox answer unlocks and permits a retry", async ({ page, bridge }) => {
    const host = await bridge({
      herdr,
      home: { ".codex/sessions/foo-session.jsonl": SESSION },
    });
    await connectAnswerer(page, host);
    await page.getByRole("button", { name: /Inbox/ }).first().click();

    const first = page.getByRole("button", { name: "1. Tabs (Recommended)" });
    const second = page.getByRole("button", { name: "2. Spaces" });
    await expect(first).toBeVisible({ timeout: 20_000 });

    let failed = true;
    await page.route(`${host.url}/api/action`, async (route) => {
      if (failed) {
        failed = false;
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { message: "answer refused" } }) });
        return;
      }
      await route.continue();
    });

    await first.click();
    await expect(second).toBeEnabled({ timeout: 10_000 });
    await first.click();
    await expect(second).toBeEnabled({ timeout: 10_000 });
  });
});

// A pane the codex detector cannot claim: Claude's numbered dialog. The bridge
// reads the keys off the pane text instead of minting an answer token, so the
// Inbox sends a keystroke and no token is spent.
const KEYED_QUESTION = "Do you want to proceed?";
const KEYED_CARD = [
  "Running the migration needs a decision.",
  KEYED_QUESTION,
  "❯ 1. Yes",
  "  2. No, tell me what to do instead",
].join("\n");
const keyedHerdr = `
case "$*" in
  "api snapshot"*) echo '{"result":{"snapshot":{"agents":[{"pane_id":"w1:p1","agent":"claude","agent_status":"blocked","cwd":"/repo/app","workspace_id":"w1","terminal_title":"claude","revision":1}]}}}' ;;
  "pane list"*) echo '{"result":{"panes":[{"pane_id":"w1:p1","label":"keyed","cwd":"/repo/app","workspace_id":"w1"}]}}' ;;
  "pane read w1:p1"*) printf '%b' ${JSON.stringify(KEYED_CARD)} ;;
  *) echo '{}' ;;
esac`;

const INSERTION_QUESTION = "Continue with the migration? y/n";
const insertionHerdr = `
case "$*" in
  "api snapshot"*)
    if [ -f "$MOSHPIT_STATE_DIR/new-session" ]; then
      echo '{"result":{"snapshot":{"agents":[{"pane_id":"w1:p1","agent":"codex","agent_status":"blocked","cwd":"/repo/app","workspace_id":"w1","terminal_title":"codex","agent_session":{"kind":"id","value":"replacement"},"revision":1}]}}}'
    else
      echo '{"result":{"snapshot":{"agents":[{"pane_id":"w1:p1","agent":"codex","agent_status":"blocked","cwd":"/repo/app","workspace_id":"w1","terminal_title":"codex","agent_session":{"kind":"id","value":"session"},"revision":1}]}}}'
    fi
    ;;
  "pane list"*) echo '{"result":{"panes":[{"pane_id":"w1:p1","label":"answerer","cwd":"/repo/app","workspace_id":"w1"}]}}' ;;
  "pane read w1:p1"*) printf '%b' ${JSON.stringify(INSERTION_QUESTION)} ;;
  *) echo '{}' ;;
esac`;

test.describe("live keyed answers", () => {
  async function openKeyed(page: import("@playwright/test").Page, host: { url: string; port: number }) {
    await openApp(page, { demo: false });
    const token = await loginBridge(page, host.url);
    await pairBridge(page, host.url, token);
    await seedHosts(page, [{
      id: "e2e",
      label: "E2E",
      transport: "tailscale",
      user: "",
      hostname: "127.0.0.1",
      port: host.port,
      demo: false,
      tailnetUrl: host.url,
    }], "e2e");
    await expect(page.getByRole("button", { name: /keyed/ }).first()).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: /Inbox/ }).first().click();
  }

  // A keystroke is not a spent token: the pane can still be asking, so the row
  // has to come back once the key lands or a dialog needing "1" then Enter
  // strands the reader with every option disabled.
  test("a delivered Inbox keystroke releases the row for the next key", async ({ page, bridge }) => {
    const host = await bridge({ herdr: keyedHerdr });
    await openKeyed(page, host);

    const first = page.getByRole("button", { name: "1. Yes" });
    const second = page.getByRole("button", { name: "2. No, tell me what to do instead" });
    await expect(first).toBeVisible({ timeout: 20_000 });

    await first.click();
    await expect(first).toBeEnabled({ timeout: 10_000 });
    await expect(second).toBeEnabled();

    await second.click();
    await expect(second).toBeEnabled({ timeout: 10_000 });
  });

  test("a refused Inbox keystroke releases the row for a retry", async ({ page, bridge }) => {
    const host = await bridge({ herdr: keyedHerdr });
    await openKeyed(page, host);

    const first = page.getByRole("button", { name: "1. Yes" });
    await expect(first).toBeVisible({ timeout: 20_000 });

    let failed = true;
    await page.route(`${host.url}/api/action`, async (route) => {
      if (failed) {
        failed = false;
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { message: "keys refused" } }) });
        return;
      }
      await route.continue();
    });

    await first.click();
    await expect(first).toBeEnabled({ timeout: 10_000 });
  });
});

test.describe("live blocked insertions", () => {
  test("keeps Enter and Esc after the phone detail remounts", async ({ page, bridge }, testInfo) => {
    test.skip(!isPhone(testInfo), "phone navigation unmounts the detail pane");
    const host = await bridge({
      herdr: insertionHerdr,
      home: { ".codex/sessions/foo-session.jsonl": SESSION },
    });
    await connectAnswerer(page, host);

    const composer = page.getByPlaceholder("Message this agent…");
    await composer.fill("y");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByRole("group", { name: "Blocked reply controls" })).toBeVisible();

    await page.getByRole("button", { name: /Inbox/ }).first().click();
    const row = page.locator("article").filter({ hasText: INSERTION_QUESTION });
    await row.getByRole("button", { name: "Reply" }).click();

    await expect(page.getByRole("group", { name: "Blocked reply controls" })).toBeVisible();
  });

  test("drops Enter and Esc when the blocked pane starts a new session", async ({ page, bridge }) => {
    const host = await bridge({
      herdr: insertionHerdr,
      home: { ".codex/sessions/foo-session.jsonl": SESSION },
    });
    await connectAnswerer(page, host);

    await page.getByRole("button", { name: /Inbox/ }).first().click();
    const row = page.locator("article").filter({ hasText: INSERTION_QUESTION });
    await row.getByRole("button", { name: "Type yes without submitting" }).click();
    await row.getByRole("button", { name: "Reply" }).click();
    const controls = page.getByRole("group", { name: "Blocked reply controls" });
    await expect(controls).toBeVisible();

    await page.getByRole("button", { name: "Chat view" }).focus();
    await writeFile(path.join(host.dir, "state", "new-session"), "");

    await expect(controls).toBeHidden({ timeout: 10_000 });
  });
});

// A quick reply keeps the saved draft, which means it never goes through the
// draft store's settle -- the one thing that renders a receipt. A refusal has
// to reach the reader some other way or the tap looks like it did nothing.
test.describe("live quick replies", () => {
  test("disables quick replies when the session has no send mode", async ({ page, bridge }) => {
    const host = await bridge({ herdr });
    await page.route(`${host.url}/api/session?*`, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          kind: "available",
          agentId: "w1:p1",
          sessionId: "no-input",
          entries: [],
          cursor: "cursor",
          before: null,
          reset: false,
          capabilities: { inputModes: [], stop: false, fit: false },
        }),
      }),
    );
    await connectAnswerer(page, host);

    await page.locator("summary").filter({ hasText: "Quick replies" }).click();
    const quickReply = page.getByRole("region", { name: "Quick replies" }).getByRole("button", { name: "yes", exact: true });
    await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
    await expect(quickReply).toBeDisabled();
  });

  test("a refused quick reply says so", async ({ page, bridge }) => {
    const host = await bridge({ herdr });
    await connectAnswerer(page, host);
    await page.getByRole("button", { name: "Terminal view", exact: true }).click();
    await page.getByRole("application", { name: /^Pane / }).waitFor();

    await page.route(`${host.url}/api/submit`, (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { message: "quick reply refused" } }),
      }),
    );

    await page.getByRole("button", { name: "Quick replies" }).click();
    await page.getByRole("region", { name: "Quick replies" }).getByRole("button", { name: "yes", exact: true }).click();
    await expect(page.getByText("quick reply refused")).toBeVisible({ timeout: 10_000 });
  });
});
