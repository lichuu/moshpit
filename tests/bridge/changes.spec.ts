import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page, TestInfo } from "@playwright/test";
import { test, expect, openApp, seedHosts, loginBridge, pairBridge, isPhone } from "../fixtures";

// C3: the Changes sheet reads the agent's own checkout through the bridge. The
// checkouts here are real temporary repositories, and the fake herdr points
// each pane at one of them.

const made: string[] = [];
test.afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e", ...args], { cwd, stdio: "pipe" });

function scratch() {
  const dir = mkdtempSync(path.join(tmpdir(), "moshpit-changes-e2e-"));
  made.push(dir);
  return dir;
}

function write(root: string, file: string, text: string | Buffer) {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), text);
}

function repo(files: Record<string, string | Buffer>) {
  const root = path.join(scratch(), "checkout");
  mkdirSync(root);
  run(root, "init", "-q", "-b", "feature/login");
  for (const [file, text] of Object.entries(files)) write(root, file, text);
  run(root, "add", "-A");
  run(root, "commit", "-q", "-m", "base");
  return root;
}

const LONG = `export const banner = "${"wide text ".repeat(40)}";`;

/** A checkout in the middle of a piece of work: an edit, a rename, a deletion, a binary, a new file and an ignored one. */
function busyRepo() {
  const root = repo({
    ".gitignore": "build/\n",
    "src/session.ts": "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n",
    "src/old-name.ts": "one\ntwo\nthree\nfour\nfive\nsix\n",
    "gone.txt": "bye\n",
    "logo.png": Buffer.from([0, 1, 2, 3, 0, 9]),
  });
  write(root, "src/session.ts", `export const a = 1;\nexport const b = 20;\n${LONG}\nexport const c = 3;\n`);
  run(root, "mv", "src/old-name.ts", "src/new-name.ts");
  write(root, "src/new-name.ts", "one\ntwo\nthree\nfour\nfive\nsix\nseven\n");
  run(root, "rm", "-q", "gone.txt");
  write(root, "logo.png", Buffer.from([0, 7, 7, 7, 0, 9, 9]));
  write(root, "notes/new.md", "# Notes\n\nfresh\n");
  write(root, "build/out.js", "IGNORED_OUTPUT\n");
  return root;
}

const agent = (id: string, cwd: string) => ({
  pane_id: id, agent: "codex", agent_status: "idle", cwd, workspace_id: "w1", terminal_title: "codex", revision: 1,
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

type Host = { url: string; port: number };

async function openDetail(page: Page, bridge: Host, label = "alpha") {
  await openApp(page, { demo: false });
  const token = await loginBridge(page, bridge.url);
  const device = await pairBridge(page, bridge.url, token);
  await seedHosts(page, [{
    id: "e2e", label: "E2E", transport: "tailscale", user: "",
    hostname: "127.0.0.1", port: bridge.port, demo: false, tailnetUrl: bridge.url,
  }], "e2e");
  await page.getByRole("button", { name: new RegExp(label) }).first().click({ timeout: 20_000 });
  return { token, device };
}

/** The wide header has a Changes button; a phone keeps it in the actions disclosure. */
async function openChanges(page: Page, testInfo: TestInfo) {
  if (isPhone(testInfo)) {
    const more = page.getByRole("button", { name: "More actions" });
    await more.click();
    await expect(more).toHaveAttribute("aria-expanded", "true");
  }
  await page.getByRole("button", { name: "Changes", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Changes" });
  await expect(sheet).toBeVisible();
  return sheet;
}

const row = (sheet: ReturnType<Page["getByRole"]>, name: RegExp | string) => sheet.getByRole("button", { name });

test.describe("Changes sheet", () => {
  test("lists what the agent changed, with an expandable diff for each file", async ({ page, bridge }, testInfo) => {
    const root = busyRepo();
    const host = await bridge({ herdr: herdrFor(agent("w1:p1", root)) });
    await openDetail(page, host);
    const sheet = await openChanges(page, testInfo);

    await expect(sheet.getByText("5 files changed")).toBeVisible();
    await expect(sheet.getByText(/checkout on feature\/login/)).toBeVisible();
    // Ignored output is neither listed nor in the patch.
    await expect(sheet.getByText("out.js")).toHaveCount(0);

    const edited = row(sheet, /^src\/session\.ts, Modified/);
    const renamed = row(sheet, /^src\/new-name\.ts, Renamed, from src\/old-name\.ts/);
    const removed = row(sheet, /^gone\.txt, Deleted/);
    const binary = row(sheet, /^logo\.png, Modified, binary/);
    const fresh = row(sheet, /^notes\/new\.md, Added, untracked/);
    for (const entry of [edited, renamed, removed, binary, fresh]) await expect(entry).toHaveAttribute("aria-expanded", "false");
    await expect(sheet.getByText("from src/old-name.ts")).toBeVisible();
    await expect(sheet.getByText("untracked", { exact: true })).toBeVisible();

    // More than four files, so every diff starts closed and draws nothing.
    await expect(sheet.getByRole("group", { name: /^Diff of/ })).toHaveCount(0);
    await edited.click();
    await expect(edited).toHaveAttribute("aria-expanded", "true");
    const diff = sheet.getByRole("group", { name: "Diff of src/session.ts" });
    await expect(diff).toBeVisible();
    await expect(diff.getByText(/^@@ -1,3 \+1,4 @@/)).toBeVisible();
    // Added and removed lines carry a +/- sign as text, not only a colour.
    const gutter = await diff.locator("[data-line]").evaluateAll((lines) => lines.map((line) => line.children[1]?.textContent ?? ""));
    expect(gutter.filter((sign) => sign === "+").length).toBe(2);
    expect(gutter.filter((sign) => sign === "-").length).toBe(1);
    await expect(diff).toContainText("export const b = 20;");

    await binary.click();
    await expect(sheet.getByText("Binary file: its content is not shown.")).toBeVisible();
    await renamed.click();
    await expect(sheet.getByRole("group", { name: "Diff of src/new-name.ts" })).toContainText("seven");
    await fresh.click();
    await expect(sheet.getByRole("group", { name: "Diff of notes/new.md" })).toContainText("# Notes");
    await removed.click();
    await expect(sheet.getByRole("group", { name: "Diff of gone.txt" })).toContainText("bye");
    await edited.click();
    await expect(edited).toHaveAttribute("aria-expanded", "false");
    await expect(sheet.getByRole("group", { name: "Diff of src/session.ts" })).toHaveCount(0);
  });

  test("a long line scrolls inside the diff and never widens the page", async ({ page, bridge }, testInfo) => {
    const root = repo({ "wide.ts": "short\n" });
    write(root, "wide.ts", `short\n${LONG.repeat(3)}\n`);
    const host = await bridge({ herdr: herdrFor(agent("w1:p1", root)) });
    await openDetail(page, host);
    const sheet = await openChanges(page, testInfo);
    // One small file opens by itself.
    const diff = sheet.getByRole("group", { name: "Diff of wide.ts" });
    await expect(diff).toBeVisible();
    const measure = await diff.evaluate((element) => ({ scroll: element.scrollWidth, client: element.clientWidth }));
    expect(measure.scroll).toBeGreaterThan(measure.client + 100);
    const page_ = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
    expect(page_.scroll).toBeLessThanOrEqual(page_.width);
    const dialog = await sheet.evaluate((element) => ({ scroll: element.scrollWidth, client: element.clientWidth }));
    expect(dialog.scroll).toBeLessThanOrEqual(dialog.client);
    await diff.focus();
    for (let step = 0; step < 6; step += 1) await page.keyboard.press("ArrowRight");
    await expect.poll(() => diff.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  });

  test("the sheet is a labelled dialog: focus moves in, Escape closes it, focus returns", async ({ page, bridge }, testInfo) => {
    const root = busyRepo();
    const host = await bridge({ herdr: herdrFor(agent("w1:p1", root)) });
    await openDetail(page, host);
    const phone = isPhone(testInfo);
    const trigger = phone ? page.getByRole("button", { name: "More actions" }) : page.getByRole("button", { name: "Changes", exact: true });
    const sheet = await openChanges(page, testInfo);
    await expect(sheet).toHaveAccessibleDescription(/checkout on feature\/login|Compared with the last commit/);
    await expect.poll(() => page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null)).toBe(true);
    // Tab stays inside while the sheet is open.
    for (let step = 0; step < 12; step += 1) {
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null)).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(trigger).toBeFocused();

    // The close button does the same.
    await openChanges(page, testInfo);
    await page.getByRole("button", { name: "Close changes" }).click();
    await expect(page.getByRole("dialog", { name: "Changes" })).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test("reads once on open and again only when Refresh is pressed", async ({ page, bridge }, testInfo) => {
    const root = repo({ "a.txt": "one\n" });
    write(root, "a.txt", "two\n");
    const host = await bridge({ herdr: herdrFor(agent("w1:p1", root)) });
    const requests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/changes")) requests.push(request.url());
    });
    await openDetail(page, host);
    const sheet = await openChanges(page, testInfo);
    await expect(sheet.getByText("1 file changed")).toBeVisible();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatch(/\/api\/changes\?target=w1%3Ap1$/);

    // The agent keeps working; nothing re-reads on its own.
    write(root, "b.txt", "new file\n");
    await page.waitForTimeout(3500);
    expect(requests).toHaveLength(1);
    await expect(sheet.getByText("1 file changed")).toBeVisible();

    await sheet.getByRole("button", { name: "Refresh changes" }).click();
    await expect(sheet.getByText("2 files changed")).toBeVisible();
    expect(requests).toHaveLength(2);
    await expect(row(sheet, /^b\.txt, Added, untracked/)).toBeVisible();

    // Closing and opening again is a fresh read.
    await page.keyboard.press("Escape");
    await openChanges(page, testInfo);
    await expect.poll(() => requests.length).toBe(3);
  });

  test("says so when nothing has changed", async ({ page, bridge }, testInfo) => {
    const root = repo({ "a.txt": "one\n" });
    const host = await bridge({ herdr: herdrFor(agent("w1:p1", root)) });
    await openDetail(page, host);
    const sheet = await openChanges(page, testInfo);
    await expect(sheet.getByText("No changes", { exact: true })).toBeVisible();
    await expect(sheet.getByText("This checkout matches its last commit.")).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Refresh changes" })).toBeEnabled();
  });

  test("a directory that is not a git checkout gets its own message", async ({ page, bridge }, testInfo) => {
    const plain = scratch();
    write(plain, "note.txt", "not tracked by anything\n");
    const host = await bridge({ herdr: herdrFor(agent("w1:p1", plain)) });
    await openDetail(page, host);
    const sheet = await openChanges(page, testInfo);
    await expect(sheet.getByText("Not a git checkout", { exact: true })).toBeVisible();
    await expect(sheet.getByText(/not inside a git repository/)).toBeVisible();
    await expect(sheet.getByText("note.txt")).toHaveCount(0);
  });

  test("a failed read shows the reason and Retry reads again", async ({ page, bridge }, testInfo) => {
    const root = repo({ "a.txt": "one\n" });
    write(root, "a.txt", "two\n");
    const host = await bridge({ herdr: herdrFor(agent("w1:p1", root)) });
    let failures = 1;
    await page.route(`${host.url}/api/changes*`, (route) => {
      if (failures-- > 0) {
        return route.fulfill({
          status: 504, contentType: "application/json",
          body: JSON.stringify({ error: { code: "changes_timeout", message: "Git took too long to answer." } }),
        });
      }
      return route.continue();
    });
    await openDetail(page, host);
    const sheet = await openChanges(page, testInfo);
    await expect(sheet.getByRole("alert")).toContainText("Could not read the changes");
    await expect(sheet.getByRole("alert")).toContainText("Git took too long to answer.");
    await sheet.getByRole("button", { name: "Retry" }).click();
    await expect(sheet.getByText("1 file changed")).toBeVisible();
    await expect(sheet.getByRole("alert")).toHaveCount(0);
  });

  test("a directory that is gone is an error with Retry, not a crash", async ({ page, bridge }, testInfo) => {
    const root = repo({ "a.txt": "one\n" });
    const host = await bridge({ herdr: herdrFor(agent("w1:p1", root)) });
    rmSync(root, { recursive: true, force: true });
    await openDetail(page, host);
    const sheet = await openChanges(page, testInfo);
    await expect(sheet.getByRole("alert")).toContainText("This pane's directory no longer exists.");
    await expect(sheet.getByRole("button", { name: "Retry" })).toBeVisible();
    // The bridge is still answering.
    await sheet.getByRole("button", { name: "Retry" }).click();
    await expect(sheet.getByRole("alert")).toContainText("no longer exists");
  });

  test("shows the loading state while git is working", async ({ page, bridge }, testInfo) => {
    const root = repo({ "a.txt": "one\n" });
    write(root, "a.txt", "two\n");
    const host = await bridge({ herdr: herdrFor(agent("w1:p1", root)) });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route(`${host.url}/api/changes*`, async (route) => {
      await held;
      await route.continue();
    });
    await openDetail(page, host);
    const sheet = await openChanges(page, testInfo);
    await expect(sheet.getByText("Reading changes…")).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Refreshing changes" })).toBeDisabled();
    release();
    await expect(sheet.getByText("1 file changed")).toBeVisible();
    await expect(sheet.getByText("Reading changes…")).toHaveCount(0);
  });

  test("a diff past the size limit says what was cut, and a long file offers the rest on request", async ({ page, bridge }, testInfo) => {
    const files: Record<string, string> = {};
    for (let n = 0; n < 30; n += 1) files[`big/f${String(n).padStart(2, "0")}.txt`] = "base\n";
    const root = repo(files);
    const body = (tag: string) => Array.from({ length: 2500 }, (_, line) => `${tag} ${line} ${"x".repeat(60)}\n`).join("");
    for (const name of Object.keys(files)) write(root, name, body(name));
    const host = await bridge({ herdr: herdrFor(agent("w1:p1", root)) });
    await openDetail(page, host);
    const sheet = await openChanges(page, testInfo);

    await expect(sheet.getByText("30 files changed")).toBeVisible();
    const note = sheet.getByRole("note");
    await expect(note).toContainText("This diff was cut.");
    await expect(note).toContainText("Not shown: big/f");
    await expect(note).toContainText(/and \d+ more/);

    // The first file made it into the patch and shows its lines, 2,000 at a time.
    await row(sheet, /^big\/f00\.txt, Added|^big\/f00\.txt, Modified/).click();
    const diff = sheet.getByRole("group", { name: "Diff of big/f00.txt" });
    await expect(diff).toContainText("big/f00.txt 0 ");
    await expect(diff).not.toContainText("big/f00.txt 2499 ");
    const more = sheet.getByRole("button", { name: /^Show 501 more lines/ });
    await more.click();
    await expect(diff).toContainText("big/f00.txt 2499 ");
    await expect(more).toHaveCount(0);

    // A file that was left out says why instead of showing nothing.
    const omitted = row(sheet, /^big\/f29\.txt, .*left out: the diff reached its size limit/);
    await expect(omitted).toBeVisible();
    await expect(omitted.getByText("not shown")).toBeVisible();
    await omitted.click();
    await expect(sheet.getByText("Left out: the diff reached its size limit.")).toBeVisible();
  });

  test("a small change opens its diff by itself", async ({ page, bridge }, testInfo) => {
    const root = repo({ "a.txt": "one\ntwo\n" });
    write(root, "a.txt", "one\n2\n");
    const host = await bridge({ herdr: herdrFor(agent("w1:p1", root)) });
    await openDetail(page, host);
    const sheet = await openChanges(page, testInfo);
    await expect(row(sheet, /^a\.txt, Modified/)).toHaveAttribute("aria-expanded", "true");
    await expect(sheet.getByRole("group", { name: "Diff of a.txt" })).toContainText("2");
  });

  test("a symbolic link out of the checkout is shown as a link and its target is not read", async ({ page, bridge }, testInfo) => {
    const root = repo({ "a.txt": "one\n" });
    const outside = scratch();
    write(outside, "secret.txt", "OUTSIDE_SECRET_VALUE\n");
    symlinkSync(path.join(outside, "secret.txt"), path.join(root, "link-out"));
    const host = await bridge({ herdr: herdrFor(agent("w1:p1", root)) });
    await openDetail(page, host);
    const sheet = await openChanges(page, testInfo);
    await expect(row(sheet, /^link-out, Added, untracked/)).toBeVisible();
    await expect(sheet.getByText("OUTSIDE_SECRET_VALUE")).toHaveCount(0);
  });

  test("the header keeps room for the agent's name", async ({ page, bridge }, testInfo) => {
    const root = busyRepo();
    const host = await bridge({ herdr: herdrFor(agent("w1:p1", root)) });
    await openDetail(page, host);
    const heading = page.getByRole("heading", { name: "alpha" });
    await expect(heading).toBeVisible();
    const width = (await heading.boundingBox())?.width ?? 0;
    // On a phone the entry point lives in the disclosure, so the title block keeps its width.
    if (isPhone(testInfo)) {
      await expect(page.getByRole("button", { name: "Changes", exact: true })).toHaveCount(0);
      expect(width).toBeGreaterThan(120);
    } else {
      await expect(page.getByRole("button", { name: "Changes", exact: true })).toBeVisible();
    }
  });
});

test.describe("GET /api/changes", () => {
  async function call(page: Page, host: Host, creds: { token: string; device: { deviceId: string; deviceSecret: string } } | null, query: string) {
    return page.evaluate(
      async ({ url, query, creds }) => {
        const response = await fetch(`${url}/api/changes${query}`, {
          headers: creds ? { authorization: `Bearer ${creds.token}`, "x-moshpit-device": `${creds.device.deviceId}.${creds.device.deviceSecret}` } : {},
        });
        return { status: response.status, cache: response.headers.get("cache-control"), text: await response.text() };
      },
      { url: host.url, query, creds },
    );
  }

  test("answers for the pane's own checkout, never caches, and refuses everything but the pane", async ({ page, bridge }) => {
    const root = busyRepo();
    const nowhere = agent("w1:p3", "");
    const host = await bridge({ herdr: herdrFor(agent("w1:p1", root), nowhere) });
    await page.goto("/");
    const token = await loginBridge(page, host.url);
    const device = await pairBridge(page, host.url, token);
    const creds = { token, device };

    const ok = await call(page, host, creds, "?target=w1%3Ap1");
    expect(ok.status).toBe(200);
    expect(ok.cache).toBe("no-store");
    const body = JSON.parse(ok.text);
    expect(body).toMatchObject({ kind: "checkout", repo: "checkout", branch: "feature/login", detached: false, truncated: false, fileCount: 5 });
    expect(body.files.map((file: { path: string }) => file.path).sort()).toEqual(["gone.txt", "logo.png", "notes/new.md", "src/new-name.ts", "src/session.ts"]);
    // No absolute host path leaves the bridge.
    expect(ok.text).not.toContain(path.dirname(root));
    expect(ok.text).not.toContain("IGNORED_OUTPUT");

    for (const query of ["?target=w1%3Ap1&path=%2Fetc", "?target=w1%3Ap1&cwd=%2Ftmp", "?target=w1%3Ap1&ref=HEAD~1", "?target=w1%3Ap1&target=w1%3Ap3", "?path=%2Fetc", "", "?target=-p"]) {
      const refused = await call(page, host, creds, query);
      expect(refused.status, query).toBe(400);
      expect(JSON.parse(refused.text).error.code).toBe("changes_request_invalid");
      expect(refused.cache).toBe("no-store");
    }
    const unknown = await call(page, host, creds, "?target=w9%3Ap9");
    expect(unknown.status).toBe(404);
    expect(JSON.parse(unknown.text).error).toMatchObject({ code: "changes_target_unknown" });
    const none = await call(page, host, creds, "?target=w1%3Ap3");
    expect(none.status).toBe(409);
    expect(JSON.parse(none.text).error).toMatchObject({ code: "changes_no_directory", message: "This pane has no known directory." });

    const anonymous = await call(page, host, null, "?target=w1%3Ap1");
    expect(anonymous.status).toBeGreaterThanOrEqual(401);
    expect(anonymous.status).toBeLessThan(500);
    expect(anonymous.text).not.toContain("src/session.ts");
  });
});
