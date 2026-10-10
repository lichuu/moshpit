import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect, openApp, seedHosts, loginBridge, pairBridge, ROOT, type Bridge } from "../fixtures";

// C12: any file from the picker is copied to the host after a question, and
// its quoted path joins the draft. The bridge is real, with a fixture herdr
// that records every call, so "nothing is sent" is read off that log.

const made: string[] = [];
test.afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const agent = (id: string, cwd: string, session: string) => ({
  pane_id: id, agent: "codex", agent_status: "idle", cwd, workspace_id: "w1", terminal_title: "codex",
  agent_session: { kind: "id", value: session }, revision: 1,
});

function herdrFor(a: ReturnType<typeof agent>) {
  const snapshot = JSON.stringify({ result: { snapshot: { agents: [a] } } });
  const panes = JSON.stringify({ result: { panes: [{ pane_id: a.pane_id, label: "alpha", terminal_id: "term_0", cwd: a.cwd, workspace_id: "w1" }] } });
  return `
case "$*" in
  "api snapshot"*) echo '${snapshot}' ;;
  "pane list"*) echo '${panes}' ;;
  *) echo '{}' ;;
esac`;
}

async function connect(page: Page, host: Bridge) {
  await page.route(`${host.url}/api/session?**`, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      kind: "available", agentId: "w1:p1", sessionId: "stream-1", entries: [], cursor: "0", before: null, reset: false,
      capabilities: { inputModes: ["send"], stop: false, fit: false },
    }),
  }));
  await openApp(page, { demo: false });
  const token = await loginBridge(page, host.url);
  await pairBridge(page, host.url, token);
  await seedHosts(page, [{
    id: "e2e", label: "E2E", transport: "tailscale", user: "",
    hostname: "127.0.0.1", port: host.port, demo: false, tailnetUrl: host.url,
  }], "e2e");
  const card = page.getByRole("button", { name: /alpha/ }).first();
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.click();
  await expect(input(page)).toBeVisible();
}

async function start(page: Page, bridge: (options?: { herdr?: string }) => Promise<Bridge>) {
  const dir = mkdtempSync(path.join(tmpdir(), "moshpit-files-e2e-"));
  made.push(dir);
  const cwd = path.join(dir, "checkout");
  mkdirSync(cwd);
  const host = await bridge({ herdr: herdrFor(agent("w1:p1", cwd, "s1")) });
  await connect(page, host);
  return host;
}

// By label, not role: while the dialog is open the page behind it is hidden from the accessibility tree.
const input = (page: Page) => page.locator('textarea[aria-label="Message agent"]');
const dialog = (page: Page) => page.getByRole("dialog", { name: /Copy this file to the host\?|Copying to the host/ });
const stored = (host: Bridge) => {
  const root = path.join(host.dir, "state", "files");
  try { return readdirSync(root); } catch { return []; }
};
const pick = (page: Page, file: { name: string; mimeType: string; buffer: Buffer }) => page.locator('input[type="file"]').setInputFiles(file);

/** Requests to the bridge that would deliver text to the agent, and uploads. */
function watch(page: Page) {
  const seen = { uploads: 0, sends: 0 };
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    if (request.url().includes("/api/files")) seen.uploads += 1;
    if (request.url().endsWith("/api/submit") || request.url().endsWith("/api/action")) seen.sends += 1;
  });
  return seen;
}

async function noSideways(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
}

test.describe("send any file", () => {
  test("a text file asks first, then its quoted path joins the draft and nothing is sent", async ({ page, bridge }) => {
    const host = await start(page, bridge);
    const seen = watch(page);
    const body = Buffer.from("line one\nline two\n");
    await input(page).fill("look at ");

    await pick(page, { name: "my notes.txt", mimeType: "text/plain", buffer: body });
    const ask = dialog(page);
    await expect(ask).toBeVisible();
    await expect(ask).toContainText("my notes.txt");
    await expect(ask).toContainText("18 B");
    await expect(ask).toContainText("copied to the host");
    await expect(ask).toContainText("stay there after this session");
    await expect(ask).toContainText("path will be added to your message");
    await expect(ask.getByRole("button", { name: "Cancel" })).toBeFocused();
    expect(seen.uploads, "nothing is uploaded before Upload").toBe(0);
    expect(stored(host)).toEqual([]);

    await ask.getByRole("button", { name: "Upload" }).click();
    await expect(ask).toBeHidden();
    await expect(input(page)).toBeFocused();
    const text = await input(page).inputValue();
    const match = /^look at '(.+)'$/.exec(text);
    expect(match, text).not.toBeNull();
    const hostPath = match![1];
    expect(hostPath).toMatch(/\/state\/files\/[0-9a-f]{24}\/my notes\.txt$/);
    expect(readFileSync(hostPath).equals(body)).toBe(true);
    expect(statSync(hostPath).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(hostPath)).mode & 0o777).toBe(0o700);

    // Where it went stays on screen, and the message was not sent.
    await expect(page.locator(".composer-file-note")).toContainText("my notes.txt");
    await expect(page.locator(".composer-file-note")).toContainText("stays there after this session");
    await expect(page.locator(".composer-file-note")).toContainText(hostPath);
    expect(seen.uploads).toBe(1);
    expect(seen.sends).toBe(0);
    expect((await host.calls()).filter((call) => /send-text|send-keys|prompt/.test(call))).toEqual([]);
    await page.getByRole("button", { name: "Dismiss file note" }).click();
    await expect(page.locator(".composer-file-note")).toHaveCount(0);
  });

  test("the path goes in at the caret, and a quote in the name is escaped", async ({ page, bridge }) => {
    const host = await start(page, bridge);
    await input(page).fill("before after");
    await input(page).evaluate((el: HTMLTextAreaElement) => { el.focus(); el.setSelectionRange(7, 7); });

    await pick(page, { name: "it's $HOME.txt", mimeType: "text/plain", buffer: Buffer.from("x") });
    await dialog(page).getByRole("button", { name: "Upload" }).click();
    await expect(dialog(page)).toBeHidden();

    const [folder] = stored(host);
    const hostPath = path.join(host.dir, "state", "files", folder, "it's $HOME.txt");
    expect(readFileSync(hostPath, "utf8")).toBe("x");
    await expect(input(page)).toHaveValue(`before '${hostPath.replaceAll("'", "'\\''")}' after`);
  });

  test("cancelling the question uploads nothing and leaves the draft", async ({ page, bridge }) => {
    const host = await start(page, bridge);
    const seen = watch(page);
    await input(page).fill("keep this");
    await pick(page, { name: "a.log", mimeType: "text/plain", buffer: Buffer.from("log") });
    await dialog(page).getByRole("button", { name: "Cancel" }).click();
    await expect(dialog(page)).toBeHidden();
    await expect(page.getByRole("button", { name: "Attach file" })).toBeFocused();
    await expect(input(page)).toHaveValue("keep this");
    expect(seen.uploads).toBe(0);
    expect(stored(host)).toEqual([]);

    // Escape cancels the same way.
    await pick(page, { name: "b.log", mimeType: "text/plain", buffer: Buffer.from("log") });
    await expect(dialog(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toBeHidden();
    expect(seen.uploads).toBe(0);
  });

  test("cancelling during the upload aborts the request and inserts nothing", async ({ page, bridge }) => {
    const host = await start(page, bridge);
    await page.route("**/api/files?**", () => {});
    let failed = false;
    page.on("requestfailed", (request) => { if (request.url().includes("/api/files")) failed = true; });
    await input(page).fill("draft");
    await pick(page, { name: "slow.bin", mimeType: "application/octet-stream", buffer: Buffer.from("slow") });
    await dialog(page).getByRole("button", { name: "Upload" }).click();
    await expect(dialog(page)).toContainText("Uploading…");
    await expect(dialog(page).getByRole("button", { name: "Upload" })).toHaveCount(0);
    await dialog(page).getByRole("button", { name: "Cancel" }).click();
    await expect(dialog(page)).toBeHidden();
    await expect.poll(() => failed).toBe(true);
    await expect(input(page)).toHaveValue("draft");
    await expect(page.locator(".composer-file-note")).toHaveCount(0);
    expect(stored(host)).toEqual([]);
  });

  test("a file the client can refuse is refused without a request", async ({ page, bridge }) => {
    const host = await start(page, bridge);
    const seen = watch(page);
    await pick(page, { name: "big.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(10 * 1024 * 1024 + 1) });
    await expect(page.getByText("Files must be 10 MB or smaller.")).toBeVisible();
    await pick(page, { name: ".env", mimeType: "text/plain", buffer: Buffer.from("SECRET=1") });
    await expect(page.getByText("A file name may not start with a dot, so nothing lands hidden.")).toBeVisible();
    await pick(page, { name: "empty.txt", mimeType: "text/plain", buffer: Buffer.alloc(0) });
    await expect(page.getByText("That file is empty.")).toBeVisible();
    await pick(page, { name: "con.txt", mimeType: "text/plain", buffer: Buffer.from("x") });
    await expect(page.getByText("That file name is reserved.")).toBeVisible();
    await expect(dialog(page)).toHaveCount(0);
    expect(seen.uploads).toBe(0);
    expect(stored(host)).toEqual([]);
    await expect(input(page)).toHaveValue("");
  });

  test("a bridge refusal shows its reason, inserts nothing, and can be tried again", async ({ page, bridge }) => {
    const host = await start(page, bridge);
    const reason = "File storage on this host is full. Remove old folders from the files directory in the bridge's state directory.";
    await page.route("**/api/files?**", (route) => route.fulfill({
      status: 507, contentType: "application/json",
      body: JSON.stringify({ error: { code: "file_storage_full", message: reason } }),
    }));
    await input(page).fill("draft");
    await pick(page, { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("notes") });
    await dialog(page).getByRole("button", { name: "Upload" }).click();
    const alert = dialog(page).getByRole("alert");
    await expect(alert).toContainText(reason);
    await expect(alert).toContainText("Nothing was added to your message.");
    await expect(input(page)).toHaveValue("draft");
    await expect(page.locator(".composer-file-note")).toHaveCount(0);
    expect(stored(host)).toEqual([]);

    // The host recovers, and the same dialog uploads on the second try.
    await page.unroute("**/api/files?**");
    await dialog(page).getByRole("button", { name: "Try again" }).click();
    await expect(dialog(page)).toBeHidden();
    await expect(input(page)).toHaveValue(/^draft '.*\/notes\.txt'$/);
    expect(stored(host)).toHaveLength(1);
  });

  test("a real refusal from the bridge reads the same", async ({ page, bridge }) => {
    const host = await start(page, bridge);
    // The pane is gone by the time the file arrives.
    await page.route("**/api/files?**", (route) => route.continue({ url: route.request().url().replace(/target=[^&]*/, "target=gone") }));
    await pick(page, { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("notes") });
    await dialog(page).getByRole("button", { name: "Upload" }).click();
    await expect(dialog(page).getByRole("alert")).toContainText("That pane is not running.");
    await expect(input(page)).toHaveValue("");
    expect(stored(host)).toEqual([]);
  });

  test("an image still stages as the attachment and is sent with the prompt", async ({ page, bridge }) => {
    const host = await start(page, bridge);
    const seen = watch(page);
    const submits: Array<{ attachment?: { name: string; type: string } }> = [];
    page.on("request", (request) => { if (request.url().endsWith("/api/submit")) submits.push(request.postDataJSON()); });
    await pick(page, { name: "tiny.png", mimeType: "image/png", buffer: readFileSync(path.join(ROOT, "tests/fixtures/tiny.png")) });
    await expect(page.getByRole("img", { name: "Attachment preview: tiny.png" })).toBeVisible();
    await expect(dialog(page)).toHaveCount(0);
    expect(seen.uploads).toBe(0);
    await input(page).fill("what is this");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => submits.length).toBe(1);
    expect(submits[0].attachment).toMatchObject({ name: "tiny.png", type: "image/png" });
    expect(seen.uploads).toBe(0);
    expect(stored(host), "an image is not stored as a file").toEqual([]);
  });

  test("offline, a picked file explains itself instead of failing silently", async ({ page, bridge, context }) => {
    const host = await start(page, bridge);
    const seen = watch(page);
    await context.setOffline(true);
    // The page learns of it from the browser's offline event, a moment later.
    await page.waitForFunction(() => !navigator.onLine);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
    await pick(page, { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("notes") });
    await expect(page.getByText("Reconnect to send a file")).toBeVisible();
    await expect(dialog(page)).toHaveCount(0);
    expect(seen.uploads).toBe(0);
    expect(stored(host)).toEqual([]);
    await context.setOffline(false);
  });

  test("the dialog and the note never widen the page", async ({ page, bridge }) => {
    const host = await start(page, bridge);
    const name = `${"a-very-long-file-name-".repeat(6)}end.txt`;
    await pick(page, { name, mimeType: "text/plain", buffer: Buffer.from("x") });
    await expect(dialog(page)).toBeVisible();
    await noSideways(page);
    const box = await dialog(page).boundingBox();
    const viewport = page.viewportSize()!;
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
    await dialog(page).getByRole("button", { name: "Upload" }).click();
    await expect(page.locator(".composer-file-note")).toContainText(name);
    await noSideways(page);
    const note = await page.locator(".composer-file-note").boundingBox();
    expect(note!.x + note!.width).toBeLessThanOrEqual(viewport.width);
    expect(stored(host)).toHaveLength(1);
  });

  test("the paperclip, the question and the dialog buttons are all reachable by keyboard", async ({ page, bridge }) => {
    await start(page, bridge);
    const attach = page.getByRole("button", { name: "Attach file" });
    await attach.focus();
    const chooser = page.waitForEvent("filechooser");
    await page.keyboard.press("Enter");
    await (await chooser).setFiles({ name: "k.txt", mimeType: "text/plain", buffer: Buffer.from("k") });
    await expect(dialog(page).getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(dialog(page).getByRole("button", { name: "Upload" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(dialog(page)).toBeHidden();
    await expect(input(page)).toHaveValue(/^'.*\/k\.txt'$/);
  });
});
