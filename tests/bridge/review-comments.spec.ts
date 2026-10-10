import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { test, expect, openApp, seedHosts, loginBridge, pairBridge, isPhone } from "../fixtures";

// C4: comments on diff lines. They are staged with the agent's draft and go
// out as a block at the end of the next prompt. The checkouts are real
// temporary repositories, the transcript is stubbed, and what the page sends
// is read off the request to the bridge.

const made: string[] = [];
test.afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e", ...args], { cwd, stdio: "pipe" });

function write(root: string, file: string, text: string) {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), text);
}

const LONG = `export const banner = "${"wide text ".repeat(40)}";`;

/** One edited file, and one renamed and edited: a removed line there is counted in the old file. */
function workRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "moshpit-review-e2e-"));
  made.push(dir);
  const root = path.join(dir, "checkout");
  mkdirSync(root);
  run(root, "init", "-q", "-b", "feature/review");
  write(root, "src/app.ts", "export const a = 1;\nexport const b = 2;\nexport const c = 3;\nexport const d = 4;\n");
  write(root, "src/old-name.ts", "one\ntwo\nthree\nfour\nfive\nsix\n");
  run(root, "add", "-A");
  run(root, "commit", "-q", "-m", "base");
  write(root, "src/app.ts", `export const a = 1;\nexport const b = 20;\nexport const c = 3;\nexport const d = 4;\n${LONG}\n`);
  run(root, "mv", "src/old-name.ts", "src/new-name.ts");
  write(root, "src/new-name.ts", "one\nthree\nfour\nfive\nsix\nseven\n");
  return root;
}

const agent = (id: string, cwd: string, session: string) => ({
  pane_id: id, agent: "codex", agent_status: "idle", cwd, workspace_id: "w1", terminal_title: "codex",
  agent_session: { kind: "id", value: session }, revision: 1,
});

function herdrFor(...agents: Array<ReturnType<typeof agent>>) {
  const snapshot = JSON.stringify({ result: { snapshot: { agents } } });
  const panes = JSON.stringify({
    result: { panes: agents.map((a, index) => ({ pane_id: a.pane_id, label: ["alpha", "beta"][index], terminal_id: `term_${index}`, cwd: a.cwd, workspace_id: "w1" })) },
  });
  return `
case "$*" in
  "api snapshot"*) echo '${snapshot}' ;;
  "pane list"*) echo '${panes}' ;;
  *) echo '{}' ;;
esac`;
}

type Entry = Record<string, unknown> & { id: string };
type Host = { url: string; port: number };

/** The transcript the page reads. Tests add entries to it as messages "arrive". */
async function serveSessions(page: Page, url: string, sessions: Record<string, Entry[]>) {
  await page.route(`${url}/api/session?**`, (route) => {
    const target = new URL(route.request().url()).searchParams.get("target") ?? "";
    const entries = sessions[target] ?? [];
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        kind: "available", agentId: target, sessionId: `stream-${target}`,
        entries, cursor: String(entries.length), before: null, reset: false,
        capabilities: { inputModes: ["send"], stop: false, fit: false },
      }),
    });
  });
}

async function openAgent(page: Page, label: string) {
  const card = page.getByRole("button", { name: new RegExp(label) }).first();
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.click();
  await expect(page.getByRole("textbox", { name: "Message agent" })).toBeVisible();
}

async function connect(page: Page, host: Host, sessions: Record<string, Entry[]>) {
  await serveSessions(page, host.url, sessions);
  await openApp(page, { demo: false });
  const token = await loginBridge(page, host.url);
  await pairBridge(page, host.url, token);
  await seedHosts(page, [{
    id: "e2e", label: "E2E", transport: "tailscale", user: "",
    hostname: "127.0.0.1", port: host.port, demo: false, tailnetUrl: host.url,
  }], "e2e");
}

/** The prompts the page sent to the bridge, in order, and a way to refuse the next ones. */
function watchSends(page: Page) {
  const sent: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/submit")) sent.push(String((request.postDataJSON() as { text: string }).text));
  });
  return sent;
}

async function openChanges(page: Page, testInfo: TestInfo) {
  if (isPhone(testInfo)) {
    const more = page.getByRole("button", { name: "More actions" });
    await more.click();
    await expect(more).toHaveAttribute("aria-expanded", "true");
  }
  await page.getByRole("button", { name: "Changes", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Changes" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText(/\d+ files? changed/)).toBeVisible();
  return sheet;
}

const press = (testInfo: TestInfo, target: Locator) => (isPhone(testInfo) ? target.tap() : target.click());
const diffOf = (sheet: Locator, file: string) => sheet.getByRole("group", { name: `Diff of ${file}`, exact: true });
const addedB = (sheet: Locator) => diffOf(sheet, "src/app.ts").getByRole("button", { name: /^Added line 2:/ });
const removedTwo = (sheet: Locator) => diffOf(sheet, "src/new-name.ts").getByRole("button", { name: /^Removed line 2: two/ });
const input = (page: Page) => page.getByRole("textbox", { name: "Message agent" });
const chip = (page: Page) => page.getByRole("button", { name: /^\d+ review comments?$/ });
const closeChanges = async (page: Page) => {
  await page.getByRole("button", { name: "Close changes" }).click();
  await expect(page.getByRole("dialog", { name: "Changes" })).toBeHidden();
};

/** Writes comments straight into the draft store's database, for states that take many taps to reach. */
async function seedComments(page: Page, comments: Array<{ id: string; path: string; line: number; side: string; text: string }>) {
  await page.evaluate(async ({ key, comments }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("moshpit-drafts", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("drafts");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("drafts", "readwrite");
      transaction.objectStore("drafts").put({ comments }, key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }, { key: JSON.stringify(["e2e", "s1", "comments"]), comments });
}

const BLOCK = "Review comments (2):\nsrc/app.ts:2: Why 20?\nsrc/old-name.ts:2 (old): Keep this line.";

/** Stages the two comments the prompt tests send: one on an added line, one on a removed line of the renamed file. */
async function stageBoth(page: Page, testInfo: TestInfo) {
  const sheet = await openChanges(page, testInfo);
  await press(testInfo, addedB(sheet));
  await sheet.getByRole("textbox", { name: /^Comment on src\/app\.ts:2$/ }).fill("Why 20?");
  await sheet.getByRole("button", { name: "Save", exact: true }).click();
  await press(testInfo, removedTwo(sheet));
  await sheet.getByRole("textbox", { name: /^Comment on src\/old-name\.ts:2 \(old\)$/ }).fill("Keep this line.");
  await sheet.getByRole("button", { name: "Save", exact: true }).click();
  await closeChanges(page);
  await expect(chip(page)).toHaveText("2 review comments");
}

test.describe("diff review comments", () => {
  test("add, edit and remove a comment under a diff line", async ({ page, bridge }, testInfo) => {
    const host = await bridge({ herdr: herdrFor(agent("w1:p1", workRepo(), "s1")) });
    await connect(page, host, { "w1:p1": [] });
    await openAgent(page, "alpha");
    const sheet = await openChanges(page, testInfo);

    // Context, added and removed lines are all commentable; each is a labelled button.
    await expect(diffOf(sheet, "src/app.ts").getByRole("button", { name: /^Unchanged line 3: / })).toBeVisible();
    await expect(diffOf(sheet, "src/app.ts").getByRole("button", { name: /^Removed line 2: export const b = 2;$/ })).toBeVisible();
    const line = addedB(sheet);
    await press(testInfo, line);
    const field = sheet.getByRole("textbox", { name: /^Comment on src\/app\.ts:2$/ });
    await expect(field).toBeFocused();
    await expect(field).toBeInViewport();
    await expect(sheet.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await field.fill("Why 20?");
    await sheet.getByRole("button", { name: "Save", exact: true }).click();

    const card = sheet.getByRole("group", { name: "Comment on src/app.ts:2" });
    await expect(card).toContainText("Why 20?");
    await expect(sheet.getByRole("textbox")).toHaveCount(0);
    await expect(line).toHaveAccessibleName(/, has a comment$/);
    await expect(line).toBeFocused();
    await expect(sheet.getByRole("button", { name: /^src\/app\.ts, Modified.*1 review comment$/ })).toBeVisible();

    await card.getByRole("button", { name: "Edit" }).click();
    await expect(field).toHaveValue("Why 20?");
    await field.fill("Why 20 and not 10?");
    await sheet.getByRole("button", { name: "Save", exact: true }).click();
    await expect(card).toContainText("Why 20 and not 10?");
    await expect(sheet.getByRole("group", { name: /^Comment on / })).toHaveCount(1);

    // Cancel leaves the saved text alone.
    await press(testInfo, line);
    await field.fill("scrapped");
    await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(card).toContainText("Why 20 and not 10?");

    await card.getByRole("button", { name: "Remove" }).click();
    await expect(sheet.getByRole("group", { name: /^Comment on / })).toHaveCount(0);
    await expect(line).toHaveAccessibleName(/^Added line 2: export const b = 20;$/);
    await closeChanges(page);
    await expect(chip(page)).toHaveCount(0);
  });

  test("a comment is limited to 500 characters and 30 comments are staged at most, and the sheet says so", async ({ page, bridge }, testInfo) => {
    const host = await bridge({ herdr: herdrFor(agent("w1:p1", workRepo(), "s1")) });
    await connect(page, host, { "w1:p1": [] });
    await openAgent(page, "alpha");
    let sheet = await openChanges(page, testInfo);
    await press(testInfo, addedB(sheet));
    const field = sheet.getByRole("textbox", { name: /^Comment on src\/app\.ts:2$/ });
    await field.fill("x".repeat(499));
    await expect(sheet.getByText("499 of 500 characters", { exact: true })).toBeVisible();
    await field.fill("y".repeat(520));
    await expect(field).toHaveValue("y".repeat(500));
    await expect(sheet.getByText("500 of 500 characters. That is the limit.")).toBeVisible();
    await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
    await closeChanges(page);

    // 30 are already staged (on lines this diff does not have): there is no room for a new one.
    await seedComments(page, Array.from({ length: 30 }, (_, n) => ({ id: `c${n}`, path: "gone.ts", line: n + 1, side: "new", text: `note ${n}` })));
    await page.reload();
    await openAgent(page, "alpha");
    await expect(chip(page)).toHaveText("30 review comments");
    sheet = await openChanges(page, testInfo);
    await press(testInfo, addedB(sheet));
    await expect(sheet.getByText("30 review comments are staged, which is the limit. Remove one to add another.")).toBeVisible();
    await expect(sheet.getByRole("textbox")).toHaveCount(0);
    await expect(sheet.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
    await sheet.getByRole("button", { name: "Close", exact: true }).click();
    // Removing one makes room.
    await sheet.getByRole("button", { name: "Remove comment on gone.ts:1", exact: true }).click();
    await press(testInfo, addedB(sheet));
    await expect(sheet.getByRole("textbox", { name: /^Comment on src\/app\.ts:2$/ })).toBeVisible();
  });

  test("comments survive a reload and belong to one agent only", async ({ page, bridge }, testInfo) => {
    const host = await bridge({ herdr: herdrFor(agent("w1:p1", workRepo(), "s1"), agent("w1:p2", workRepo(), "s2")) });
    await connect(page, host, { "w1:p1": [], "w1:p2": [] });
    await openAgent(page, "alpha");
    let sheet = await openChanges(page, testInfo);
    await press(testInfo, addedB(sheet));
    await sheet.getByRole("textbox", { name: /^Comment on src\/app\.ts:2$/ }).fill("Why 20?");
    await sheet.getByRole("button", { name: "Save", exact: true }).click();
    await closeChanges(page);
    await expect(chip(page)).toHaveText("1 review comment");

    // The other agent has its own draft, and its own sheet shows none of these.
    const back = page.getByRole("button", { name: "Back", exact: true });
    if (await back.isVisible()) await back.click();
    await openAgent(page, "beta");
    await expect(chip(page)).toHaveCount(0);
    sheet = await openChanges(page, testInfo);
    await expect(sheet.getByRole("group", { name: /^Comment on / })).toHaveCount(0);
    await closeChanges(page);

    await page.reload();
    await openAgent(page, "alpha");
    await expect(chip(page)).toHaveText("1 review comment");
    sheet = await openChanges(page, testInfo);
    await expect(sheet.getByRole("group", { name: "Comment on src/app.ts:2" })).toContainText("Why 20?");
  });

  test("the composer lists staged comments, removes one, clears all, and opens the sheet", async ({ page, bridge }, testInfo) => {
    const host = await bridge({ herdr: herdrFor(agent("w1:p1", workRepo(), "s1")) });
    await connect(page, host, { "w1:p1": [] });
    await openAgent(page, "alpha");
    await stageBoth(page, testInfo);

    await chip(page).click();
    const list = page.getByRole("region", { name: "Review comments" });
    await expect(list).toContainText("src/app.ts:2");
    await expect(list).toContainText("Why 20?");
    await expect(list).toContainText("src/old-name.ts:2 (old)");
    await expect(list).toContainText("Keep this line.");

    await list.getByRole("button", { name: "Remove comment on src/app.ts:2" }).click();
    await expect(chip(page)).toHaveText("1 review comment");
    await expect(list).not.toContainText("Why 20?");

    // The way back into the sheet, and back out to the same button.
    const open = list.getByRole("button", { name: "Open Changes" });
    await press(testInfo, open);
    const sheet = page.getByRole("dialog", { name: "Changes" });
    await expect(sheet.getByRole("group", { name: "Comment on src/old-name.ts:2 (old)" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(open).toBeFocused();

    // Clearing needs a second press.
    const clear = list.getByRole("button", { name: "Clear all" });
    await clear.click();
    await expect(list.getByRole("button", { name: /^Clear 1\? Tap again$/ })).toBeVisible();
    await expect(chip(page)).toHaveText("1 review comment");
    await list.getByRole("button", { name: /^Clear 1\? Tap again$/ }).click();
    await expect(chip(page)).toHaveCount(0);
  });

  test("the prompt carries the typed text and the block, once, and the comments leave when it is delivered", async ({ page, bridge }, testInfo) => {
    const host = await bridge({ herdr: herdrFor(agent("w1:p1", workRepo(), "s1")) });
    const sent = watchSends(page);
    await connect(page, host, { "w1:p1": [] });
    await openAgent(page, "alpha");
    await stageBoth(page, testInfo);

    await input(page).fill("Please look at these.");
    await page.getByRole("button", { name: "Send" }).click();
    await expect.poll(() => sent.length).toBe(1);
    // An old-side comment on a renamed file cites the pre-rename path.
    expect(sent[0]).toBe(`Please look at these.\n\n${BLOCK}`);
    await expect(chip(page)).toHaveCount(0);
    await expect(input(page)).toHaveValue("");

    // Comments alone are a message: no typed text is needed.
    await stageBoth(page, testInfo);
    await page.getByRole("button", { name: "Send" }).click();
    await expect.poll(() => sent.length).toBe(2);
    expect(sent[1]).toBe(BLOCK);
    await expect(chip(page)).toHaveCount(0);

    // Nothing staged and nothing typed sends nothing.
    await page.getByRole("button", { name: "Send" }).click();
    await page.waitForTimeout(300);
    expect(sent).toHaveLength(2);
  });

  test("a failed send keeps the comments and the retry sends them once; a command cannot carry them", async ({ page, bridge }, testInfo) => {
    const host = await bridge({ herdr: herdrFor(agent("w1:p1", workRepo(), "s1")) });
    const sent = watchSends(page);
    await connect(page, host, { "w1:p1": [] });
    await openAgent(page, "alpha");
    await stageBoth(page, testInfo);

    let refuse = true;
    await page.route(`${host.url}/api/submit`, (route) =>
      refuse
        ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { message: "bridge refused" } }) })
        : route.continue(),
    );
    await input(page).fill("Try this.");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("bridge refused")).toBeVisible();
    await expect(chip(page)).toHaveText("2 review comments");
    await expect(input(page)).toHaveValue("Try this.");

    refuse = false;
    await page.getByRole("button", { name: "Send" }).click();
    await expect.poll(() => sent.length).toBe(2);
    expect(sent[1]).toBe(`Try this.\n\n${BLOCK}`);
    expect(sent[0]).toBe(sent[1]);
    await expect(chip(page)).toHaveCount(0);

    // A message that opens with a command would take the block as its arguments.
    await stageBoth(page, testInfo);
    await input(page).fill("/model gpt-5");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("A command can't carry review comments")).toBeVisible();
    await page.waitForTimeout(300);
    expect(sent).toHaveLength(2);
    await expect(chip(page)).toHaveText("2 review comments");
  });

  test("a sent message ends in a pill that opens to the list, with the rest shown above it", async ({ page, bridge }, testInfo) => {
    const host = await bridge({ herdr: herdrFor(agent("w1:p1", workRepo(), "s1")) });
    const sent = watchSends(page);
    const transcript: Record<string, Entry[]> = { "w1:p1": [] };
    await connect(page, host, transcript);
    await openAgent(page, "alpha");
    await stageBoth(page, testInfo);
    const long = `Please go through these notes one by one. ${"It matters that every note is read. ".repeat(14)}`;
    await input(page).fill(long.trim());
    await page.getByRole("button", { name: "Send" }).click();
    await expect.poll(() => sent.length).toBe(1);
    // The agent's side echoes the prompt back as the user's message.
    transcript["w1:p1"].push({ id: "u1", turnId: "t1", kind: "message", role: "user", text: sent[0] });
    transcript["w1:p1"].push({ id: "u2", turnId: "t2", kind: "message", role: "user", text: `Short one.\n\n${BLOCK}` });
    transcript["w1:p1"].push({ id: "u3", turnId: "t3", kind: "message", role: "user", text: "Review comments (2):\nsrc/app.ts:2: Looks like the block, but the count is wrong" });

    const message = page.locator('[data-entry-id="u1"]');
    await expect(message).toBeVisible({ timeout: 20_000 });
    // The typed part is shown (and still collapses when long); the block is not printed as text.
    await expect(message).toContainText("Please go through these notes one by one.");
    await expect(message).not.toContainText("src/old-name.ts:2");
    await expect(message.getByRole("button", { name: "Show more" })).toBeVisible();
    const pill = message.getByRole("button", { name: "2 review comments" });
    await expect(pill).toHaveAttribute("aria-expanded", "false");
    await press(testInfo, pill);
    await expect(pill).toHaveAttribute("aria-expanded", "true");
    const items = message.getByRole("list", { name: "Review comments" });
    await expect(items).toContainText("src/app.ts:2");
    await expect(items).toContainText("Why 20?");
    await expect(items).toContainText("src/old-name.ts:2 (old)");
    await expect(items).toContainText("Keep this line.");
    await press(testInfo, pill);
    await expect(items).toHaveCount(0);

    // A short message works the same; the copy button still copies the whole text.
    const short = page.locator('[data-entry-id="u2"]');
    await expect(short).toContainText("Short one.");
    await expect(short.getByRole("button", { name: "2 review comments" })).toBeVisible();
    await expect(short.getByRole("button", { name: "Show more" })).toHaveCount(0);

    // Text that only resembles the block is shown exactly as before.
    const plain = page.locator('[data-entry-id="u3"]');
    await expect(plain).toContainText("Review comments (2):");
    await expect(plain).toContainText("the count is wrong");
    await expect(plain.getByRole("button", { name: /review comments?$/ })).toHaveCount(0);

    // Search matches what the comments say, shows the list open, and has nothing to toggle.
    await page.getByRole("textbox", { name: "Search conversation" }).fill("Keep this line");
    await expect(page.locator('[data-entry-id="u1"]')).toBeVisible();
    await expect(page.locator('[data-entry-id="u1"]').getByRole("list", { name: "Review comments" })).toContainText("Keep this line.");
    await expect(page.locator('[data-entry-id="u1"]').getByRole("button", { name: "2 review comments" })).toHaveCount(0);
    await expect(page.locator('[data-entry-id="u3"]')).toHaveCount(0);
    await page.getByRole("textbox", { name: "Search conversation" }).fill("");
    await expect(page.locator('[data-entry-id="u1"]').getByRole("button", { name: "2 review comments" })).toHaveAttribute("aria-expanded", "false");
  });

  test("a comment whose line left the diff is kept and listed apart, never hidden", async ({ page, bridge }, testInfo) => {
    const root = workRepo();
    const host = await bridge({ herdr: herdrFor(agent("w1:p1", root, "s1")) });
    await connect(page, host, { "w1:p1": [] });
    await openAgent(page, "alpha");
    await stageBoth(page, testInfo);

    // The agent undoes its edit of app.ts; the renamed file is untouched.
    run(root, "checkout", "--", "src/app.ts");
    const sheet = await openChanges(page, testInfo);
    await expect(sheet.getByText("1 file changed")).toBeVisible();
    const group = sheet.getByRole("region", { name: "Not in the current diff" });
    await expect(group).toContainText("Not in the current diff (1)");
    await expect(group).toContainText("src/app.ts:2");
    await expect(group).toContainText("Why 20?");
    await expect(sheet.getByRole("group", { name: "Comment on src/old-name.ts:2 (old)" })).toBeVisible();
    // Still staged: the composer counts it, and it would still be sent.
    await closeChanges(page);
    await expect(chip(page)).toHaveText("2 review comments");

    const again = await openChanges(page, testInfo);
    await again.getByRole("button", { name: "Remove comment on src/app.ts:2" }).click();
    await expect(again.getByRole("region", { name: "Not in the current diff" })).toHaveCount(0);
    await closeChanges(page);
    await expect(chip(page)).toHaveText("1 review comment");
  });

  test("a keyboard reaches the lines, Escape cancels the editor and not the sheet, and focus returns to the line", async ({ page, bridge }, testInfo) => {
    const host = await bridge({ herdr: herdrFor(agent("w1:p1", workRepo(), "s1")) });
    await connect(page, host, { "w1:p1": [] });
    await openAgent(page, "alpha");
    const sheet = await openChanges(page, testInfo);

    // Tab arrives at a line; the arrow keys move between lines; one line is a stop per diff.
    for (let step = 0; step < 20; step += 1) {
      if (await page.evaluate(() => document.activeElement instanceof HTMLElement && "line" in document.activeElement.dataset)) break;
      await page.keyboard.press("Tab");
    }
    const first = page.locator(":focus");
    await expect(first).toHaveAttribute("data-line", /.+/);
    const label = await first.getAttribute("aria-label");
    await page.keyboard.press("ArrowDown");
    expect(await page.locator(":focus").getAttribute("aria-label")).not.toBe(label);
    await page.keyboard.press("ArrowUp");
    await expect(page.locator(":focus")).toHaveAttribute("aria-label", label ?? "");

    await addedB(sheet).focus();
    await page.keyboard.press("Enter");
    const field = sheet.getByRole("textbox", { name: /^Comment on src\/app\.ts:2$/ });
    await expect(field).toBeFocused();
    await page.keyboard.type("Typed with the keyboard.");
    await page.keyboard.press("Escape");
    await expect(field).toHaveCount(0);
    await expect(sheet).toBeVisible();
    await expect(addedB(sheet)).toBeFocused();
    await expect(sheet.getByRole("group", { name: /^Comment on / })).toHaveCount(0);

    await page.keyboard.press("Enter");
    await page.keyboard.type("Saved with the keyboard.");
    await page.keyboard.press("Control+Enter");
    await expect(sheet.getByRole("group", { name: "Comment on src/app.ts:2" })).toContainText("Saved with the keyboard.");
    await expect(addedB(sheet)).toBeFocused();

    // With no editor open, Escape closes the sheet as before.
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
  });

  test("on a phone, comments never widen the page and the editor stays in view beside a long line", async ({ page, bridge }, testInfo) => {
    test.skip(!isPhone(testInfo), "the phone width is the constraint");
    const host = await bridge({ herdr: herdrFor(agent("w1:p1", workRepo(), "s1")) });
    await connect(page, host, { "w1:p1": [] });
    await openAgent(page, "alpha");
    const sheet = await openChanges(page, testInfo);
    const diff = diffOf(sheet, "src/app.ts");
    const wide = diff.getByRole("button", { name: /^Added line 5: export const banner/ });
    await expect(wide).toBeVisible();
    expect(await diff.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeGreaterThan(100);

    // A comfortable target.
    const box = await wide.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(36);

    // A swipe along the line pans the diff and opens nothing.
    const area = await diff.boundingBox();
    if (!area || !box) throw new Error("no boxes");
    const cdp = await page.context().newCDPSession(page);
    const y = box.y + box.height / 2;
    const from = area.x + area.width - 20;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from, y }] });
    for (let step = 1; step <= 12; step += 1) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from - step * 20, y }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(() => diff.evaluate((element) => element.scrollLeft)).toBeGreaterThan(50);
    await expect(sheet.getByRole("textbox")).toHaveCount(0);

    // A tap while panned opens an editor as wide as the window, not as the line.
    await wide.tap();
    const field = sheet.getByRole("textbox", { name: /^Comment on src\/app\.ts:5$/ });
    await expect(field).toBeVisible();
    await field.fill("A comment on a very long line.");
    await sheet.getByRole("button", { name: "Save", exact: true }).click();
    const card = sheet.getByRole("group", { name: "Comment on src/app.ts:5" });
    await expect(card).toBeVisible();
    await wide.tap();
    const editor = sheet.locator("[data-comment-editor]");
    await expect(editor).toBeInViewport();
    const sizes = await page.evaluate(() => {
      const group = document.querySelector<HTMLElement>('[role="group"][aria-label^="Diff of src/app.ts"]');
      const form = document.querySelector<HTMLElement>("[data-comment-editor]");
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
      return {
        page: [document.documentElement.scrollWidth, window.innerWidth],
        dialog: [dialog?.scrollWidth ?? 0, dialog?.clientWidth ?? 0],
        form: form?.getBoundingClientRect().width ?? 0,
        group: group?.clientWidth ?? 0,
      };
    });
    expect(sizes.page[0]).toBeLessThanOrEqual(sizes.page[1]);
    expect(sizes.dialog[0]).toBeLessThanOrEqual(sizes.dialog[1]);
    expect(Math.abs(sizes.form - sizes.group)).toBeLessThanOrEqual(2);
    expect(sizes.group).toBeLessThanOrEqual(390);

    // The composer chip fits too.
    await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
    await closeChanges(page);
    await chip(page).click();
    const width = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    expect(width[0]).toBeLessThanOrEqual(width[1]);
  });
});

test.describe("diff review comments in demo mode", () => {
  test("comment on the sample diff, see the chip, send, and the chip clears", async ({ demo }, testInfo) => {
    const requests: string[] = [];
    demo.on("request", (request) => {
      if (request.url().includes("/api/")) requests.push(request.url());
    });
    await demo.getByText("auth-rewrite", { exact: true }).first().click();
    await expect(demo.getByRole("heading", { name: "auth-rewrite" })).toBeVisible();
    if (isPhone(testInfo)) await demo.getByRole("button", { name: "More actions" }).click();
    await demo.getByRole("button", { name: "Changes", exact: true }).click();
    const sheet = demo.getByRole("dialog", { name: "Changes" });
    await sheet.getByRole("button", { name: /^src\/auth\/session\.ts, Modified/ }).click();

    await press(testInfo, sheet.getByRole("button", { name: /^Added line \d+: const SKEW_MS = 30_000;/ }));
    await sheet.getByRole("textbox", { name: /^Comment on src\/auth\/session\.ts:\d+$/ }).fill("Make this configurable.");
    await sheet.getByRole("button", { name: "Save", exact: true }).click();

    // The renamed file's removed line cites the path it had before.
    await sheet.getByRole("button", { name: /^src\/auth\/tokens\.ts, Renamed/ }).click();
    await press(testInfo, sheet.getByRole("button", { name: /^Removed line 1: export function parseToken\(raw: string\) \{/ }));
    await expect(sheet.getByRole("textbox", { name: "Comment on src/auth/token.ts:1 (old)" })).toBeVisible();
    await sheet.getByRole("textbox").fill("Keep the old signature too.");
    await sheet.getByRole("button", { name: "Save", exact: true }).click();
    await sheet.getByRole("button", { name: "Close changes" }).click();

    const chipButton = demo.locator(".composer-wrap").getByRole("button", { name: "2 review comments" });
    await expect(chipButton).toBeVisible();
    await demo.getByPlaceholder("Message this agent…").fill("Thanks.");
    await demo.getByRole("button", { name: "Send" }).click();
    await expect(chipButton).toHaveCount(0);
    // The sent message comes back in the transcript with its comments as a pill.
    const pill = demo.locator('[data-role="user"]').getByRole("button", { name: "2 review comments" });
    await expect(pill).toBeVisible();
    await pill.click();
    await expect(demo.getByRole("list", { name: "Review comments" })).toContainText("src/auth/token.ts:1 (old)");
    expect(requests).toEqual([]);
  });
});
