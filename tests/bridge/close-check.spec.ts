import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect, openApp, seedHosts, loginBridge, pairBridge, agentAction } from "../fixtures";

// C11: Close asks the agent's checkout whether work would be left behind. The
// checkouts are real temporary repositories (with a bare repository on disk as
// their remote), and the fake herdr points the pane at one of them.

const made: string[] = [];
test.afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e", ...args], { cwd, stdio: "pipe" });

function scratch() {
  const dir = mkdtempSync(path.join(tmpdir(), "moshpit-close-e2e-"));
  made.push(dir);
  return dir;
}

function write(root: string, file: string, text: string) {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), text);
}

/** A checkout whose branch is pushed to a bare repository: nothing to lose. */
function pushedRepo(files: Record<string, string>) {
  const root = path.join(scratch(), "checkout");
  mkdirSync(root);
  run(root, "init", "-q", "-b", "main");
  for (const [file, text] of Object.entries(files)) write(root, file, text);
  run(root, "add", "-A");
  run(root, "commit", "-q", "-m", "base");
  const remote = path.join(scratch(), "origin.git");
  run(root, "init", "-q", "--bare", remote);
  run(root, "remote", "add", "origin", remote);
  run(root, "push", "-q", "-u", "origin", "main");
  return root;
}

/** Two edited files, one untracked file, one commit not pushed. */
function dirtyRepo() {
  const root = pushedRepo({ "a.txt": "1\n", "b.txt": "1\n" });
  write(root, "c.txt", "c\n");
  run(root, "add", "c.txt");
  run(root, "commit", "-q", "-m", "ahead");
  write(root, "a.txt", "2\n");
  write(root, "b.txt", "2\n");
  write(root, "notes.txt", "n\n");
  return root;
}

const FOUND = "This checkout has 2 uncommitted files, 1 untracked file, 1 commit not pushed.";

const agent = (id: string, cwd: string) => ({
  pane_id: id, agent: "codex", agent_status: "idle", cwd, workspace_id: "w1", terminal_title: "codex", revision: 1,
});

function herdrFor(cwd: string) {
  const snapshot = JSON.stringify({ result: { snapshot: { agents: [agent("w1:p1", cwd)] } } });
  const panes = JSON.stringify({
    result: { panes: [{ pane_id: "w1:p1", label: "alpha", terminal_id: "term_0", cwd, workspace_id: "w1" }] },
  });
  return `
case "$*" in
  "api snapshot"*) echo '${snapshot}' ;;
  "pane list"*) echo '${panes}' ;;
  *) echo '{}' ;;
esac`;
}

type Host = { url: string; port: number };

async function openDetail(page: Page, bridge: Host) {
  await openApp(page, { demo: false });
  const token = await loginBridge(page, bridge.url);
  await pairBridge(page, bridge.url, token);
  await seedHosts(page, [{
    id: "e2e", label: "E2E", transport: "tailscale", user: "",
    hostname: "127.0.0.1", port: bridge.port, demo: false, tailnetUrl: bridge.url,
  }], "e2e");
  await page.getByRole("button", { name: /alpha/ }).first().click({ timeout: 20_000 });
}

/** Counts the close actions that reach the bridge, and answers them without closing anything real. */
async function watchCloses(page: Page, host: Host) {
  const closes: string[] = [];
  await page.route(`${host.url}/api/action`, (route) => {
    const body = route.request().postData() ?? "";
    if (!body.includes('"close"')) return route.continue();
    closes.push(body);
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  return closes;
}

function watchSummaries(page: Page) {
  const urls: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/changes/summary")) urls.push(request.url());
  });
  return urls;
}

/** Holds each summary request until `release`, then lets it through to the bridge. */
async function holdSummaries(page: Page, host: Host) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`${host.url}/api/changes/summary*`, async (route) => {
    await held;
    await route.continue().catch(() => {});
  });
  return () => release();
}

async function openClose(page: Page) {
  await (await agentAction(page, "Close pane")).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

const closeButton = (dialog: ReturnType<Page["getByRole"]>) => dialog.getByRole("button", { name: "Close pane" });
const consentField = (dialog: ReturnType<Page["getByRole"]>) => dialog.getByRole("textbox", { name: "Type close to confirm" });

test.describe("Close checks the checkout", () => {
  test("a clean, pushed checkout closes with one tap, as before", async ({ page, bridge }) => {
    const host = await bridge({ herdr: herdrFor(pushedRepo({ "a.txt": "1\n" })) });
    const closes = await watchCloses(page, host);
    const summaries = watchSummaries(page);
    await openDetail(page, host);
    const dialog = await openClose(page);

    await expect(closeButton(dialog)).toBeEnabled();
    await expect(dialog).toContainText("Close ends the pane and the agent running in it. The files in its checkout stay as they are.");
    await expect(consentField(dialog)).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "View changes" })).toHaveCount(0);
    await expect(dialog.getByText("Checking the checkout…")).toHaveCount(0);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatch(/\/api\/changes\/summary\?target=w1%3Ap1$/);

    await closeButton(dialog).click();
    await expect(dialog).toBeHidden();
    expect(closes).toHaveLength(1);
  });

  test("a checkout with work lists it and blocks Close until close is typed", async ({ page, bridge }) => {
    const host = await bridge({ herdr: herdrFor(dirtyRepo()) });
    const closes = await watchCloses(page, host);
    await openDetail(page, host);
    const dialog = await openClose(page);

    await expect(dialog.getByRole("status")).toHaveText(FOUND);
    await expect(dialog).toContainText("Close ends the pane and the agent running in it. It does not delete or change any files in the checkout.");
    await expect(closeButton(dialog)).toBeDisabled();
    // The safe choice still holds focus; the keyboard does not open by itself.
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();

    const field = consentField(dialog);
    await expect(field).toBeVisible();
    await field.fill("clos");
    await expect(closeButton(dialog)).toBeDisabled();
    // Case and surrounding spaces do not matter.
    await field.fill("  CLOSE ");
    await expect(closeButton(dialog)).toBeEnabled();
    await field.fill("Close");
    await expect(closeButton(dialog)).toBeEnabled();
    await closeButton(dialog).click();
    await expect(dialog).toBeHidden();
    expect(closes).toHaveLength(1);
  });

  test("wrong text keeps it blocked, and Enter confirms only when the text matches", async ({ page, bridge }) => {
    const host = await bridge({ herdr: herdrFor(dirtyRepo()) });
    const closes = await watchCloses(page, host);
    await openDetail(page, host);
    const dialog = await openClose(page);
    const field = consentField(dialog);

    for (const wrong of ["", "closed", "close pane", "c lose", "yes"]) {
      await field.fill(wrong);
      await expect(closeButton(dialog)).toBeDisabled();
      await field.press("Enter");
    }
    await page.waitForTimeout(300);
    expect(closes).toHaveLength(0);
    await expect(dialog).toBeVisible();

    await field.fill("close");
    await field.press("Enter");
    await expect(dialog).toBeHidden();
    expect(closes).toHaveLength(1);
  });

  test("the typed word is gone when the dialog opens again", async ({ page, bridge }) => {
    const host = await bridge({ herdr: herdrFor(dirtyRepo()) });
    const closes = await watchCloses(page, host);
    await openDetail(page, host);
    let dialog = await openClose(page);
    await consentField(dialog).fill("close");
    await expect(closeButton(dialog)).toBeEnabled();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();

    dialog = await openClose(page);
    await expect(consentField(dialog)).toHaveValue("");
    await expect(closeButton(dialog)).toBeDisabled();
    expect(closes).toHaveLength(0);
  });

  test("a check that fails asks for the same typed consent", async ({ page, bridge }) => {
    const host = await bridge({ herdr: herdrFor(pushedRepo({ "a.txt": "1\n" })) });
    const closes = await watchCloses(page, host);
    let mode: "timeout" | "offline" = "timeout";
    await page.route(`${host.url}/api/changes/summary*`, (route) =>
      mode === "offline"
        ? route.abort("connectionrefused")
        : route.fulfill({ status: 504, contentType: "application/json", body: JSON.stringify({ error: { code: "changes_timeout", message: "Git took too long to answer." } }) }),
    );
    await openDetail(page, host);

    let dialog = await openClose(page);
    await expect(dialog.getByRole("status")).toContainText("Could not check this checkout for work that would be left behind. Git took too long to answer.");
    await expect(dialog).toContainText("It does not delete or change any files in the checkout.");
    await expect(closeButton(dialog)).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "View changes" })).toHaveCount(0);
    await consentField(dialog).fill("close");
    await expect(closeButton(dialog)).toBeEnabled();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();

    mode = "offline";
    dialog = await openClose(page);
    await expect(dialog.getByRole("status")).toContainText("The bridge could not be reached.");
    await expect(closeButton(dialog)).toBeDisabled();
    await consentField(dialog).fill("close");
    await consentField(dialog).press("Enter");
    await expect(dialog).toBeHidden();
    expect(closes).toHaveLength(1);
  });

  test("an answer the client cannot read is treated as a failed check", async ({ page, bridge }) => {
    const host = await bridge({ herdr: herdrFor(pushedRepo({ "a.txt": "1\n" })) });
    await page.route(`${host.url}/api/changes/summary*`, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ kind: "checkout", counts: "none" }) }),
    );
    await openDetail(page, host);
    const dialog = await openClose(page);
    await expect(dialog.getByRole("status")).toContainText("The bridge returned an unusable changes summary.");
    await expect(closeButton(dialog)).toBeDisabled();
    await expect(consentField(dialog)).toBeVisible();
  });

  test("a directory that is not a checkout closes as before", async ({ page, bridge }) => {
    const plain = scratch();
    write(plain, "note.txt", "not tracked by anything\n");
    const host = await bridge({ herdr: herdrFor(plain) });
    const closes = await watchCloses(page, host);
    await openDetail(page, host);
    const dialog = await openClose(page);

    await expect(closeButton(dialog)).toBeEnabled();
    await expect(consentField(dialog)).toHaveCount(0);
    await closeButton(dialog).click();
    await expect(dialog).toBeHidden();
    expect(closes).toHaveLength(1);
  });

  test("a repository with no remote has nothing unpushed, and committed work is not a warning", async ({ page, bridge }) => {
    const root = path.join(scratch(), "local");
    mkdirSync(root);
    run(root, "init", "-q", "-b", "main");
    write(root, "a.txt", "1\n");
    run(root, "add", "-A");
    run(root, "commit", "-q", "-m", "only here");
    const host = await bridge({ herdr: herdrFor(root) });
    await openDetail(page, host);
    const dialog = await openClose(page);
    await expect(closeButton(dialog)).toBeEnabled();
    await expect(consentField(dialog)).toHaveCount(0);
  });

  test("the dialog appears before the check answers, and Close waits for it", async ({ page, bridge }) => {
    const host = await bridge({ herdr: herdrFor(pushedRepo({ "a.txt": "1\n" })) });
    const closes = await watchCloses(page, host);
    const release = await holdSummaries(page, host);
    await openDetail(page, host);
    const dialog = await openClose(page);

    await expect(dialog.getByText("Checking the checkout…")).toBeVisible();
    await expect(closeButton(dialog)).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.waitForTimeout(600);
    await expect(closeButton(dialog)).toBeDisabled();
    expect(closes).toHaveLength(0);

    release();
    await expect(dialog.getByText("Checking the checkout…")).toHaveCount(0);
    await expect(closeButton(dialog)).toBeEnabled();
  });

  test("View changes closes the dialog and opens the Changes sheet", async ({ page, bridge }) => {
    const host = await bridge({ herdr: herdrFor(dirtyRepo()) });
    const closes = await watchCloses(page, host);
    await openDetail(page, host);
    const dialog = await openClose(page);

    await dialog.getByRole("button", { name: "View changes" }).click();
    await expect(dialog).toBeHidden();
    const sheet = page.getByRole("dialog", { name: "Changes" });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText("3 files changed")).toBeVisible();
    await expect(sheet.getByRole("button", { name: /^notes\.txt, Added, untracked/ })).toBeVisible();
    expect(closes).toHaveLength(0);

    // Back out of the sheet and the pane is still there to close.
    await page.getByRole("button", { name: "Close changes" }).click();
    await expect(sheet).toBeHidden();
    const again = await openClose(page);
    await expect(again.getByRole("status")).toHaveText(FOUND);
  });

  test("closing the dialog mid-check abandons the answer, and reopening checks afresh", async ({ page, bridge }) => {
    const host = await bridge({ herdr: herdrFor(pushedRepo({ "a.txt": "1\n" })) });
    const requests: string[] = [];
    let first: (() => Promise<void>) | undefined;
    await page.route(`${host.url}/api/changes/summary*`, async (route) => {
      requests.push(route.request().url());
      if (requests.length > 1) return route.continue();
      // The first answer is held, and is a dirty one, so a late arrival would show.
      first = async () => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            kind: "checkout", branch: "main", detached: false, unpushedBasis: "upstream", truncated: false,
            counts: { staged: 0, unstaged: 5, uncommitted: 5, untracked: 0, unpushed: 0 },
          }),
        }).catch(() => {});
      };
    });
    await openDetail(page, host);

    let dialog = await openClose(page);
    await expect(dialog.getByText("Checking the checkout…")).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();

    dialog = await openClose(page);
    // The second opening asked again and got the real answer: clean.
    await expect(closeButton(dialog)).toBeEnabled();
    expect(requests).toHaveLength(2);

    // The first answer turns up late and changes nothing.
    await first?.();
    await page.waitForTimeout(400);
    await expect(closeButton(dialog)).toBeEnabled();
    await expect(consentField(dialog)).toHaveCount(0);
    await expect(dialog.getByRole("status")).toBeEmpty();

    // Nothing is cached across openings.
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await openClose(page);
    await expect.poll(() => requests.length).toBe(3);
  });

  test("a stale clean answer is not reused when the checkout got dirty in between", async ({ page, bridge }) => {
    const root = pushedRepo({ "a.txt": "1\n" });
    const host = await bridge({ herdr: herdrFor(root) });
    await openDetail(page, host);
    let dialog = await openClose(page);
    await expect(closeButton(dialog)).toBeEnabled();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();

    write(root, "a.txt", "2\n");
    dialog = await openClose(page);
    await expect(dialog.getByRole("status")).toHaveText("This checkout has 1 uncommitted file.");
    await expect(closeButton(dialog)).toBeDisabled();
  });

  test("the dialog fits the screen, the field is at least 16px, and Close stays reachable with the keyboard up", async ({ page, bridge }) => {
    const host = await bridge({ herdr: herdrFor(dirtyRepo()) });
    await openDetail(page, host);
    const dialog = await openClose(page);
    await expect(dialog.getByRole("status")).toHaveText(FOUND);

    const overflow = () =>
      page.evaluate(() => ({ page: document.documentElement.scrollWidth - window.innerWidth, dialog: (() => {
        const element = document.querySelector('[role="alertdialog"]') as HTMLElement;
        return element.scrollWidth - element.clientWidth;
      })() }));
    expect(await overflow()).toEqual({ page: 0, dialog: 0 });

    const field = consentField(dialog);
    expect(await field.evaluate((element) => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
    expect(await field.evaluate((element) => element.getAttribute("autocapitalize"))).toBe("none");
    await expect(field.locator("xpath=preceding-sibling::label")).toHaveText("Type close to confirm");

    // The soft keyboard takes most of a phone's height; the layout viewport shrinks with it.
    const width = page.viewportSize()?.width ?? 390;
    await page.setViewportSize({ width, height: 300 });
    await field.focus();
    await field.fill("close");
    for (const locator of [closeButton(dialog), field, dialog.getByRole("button", { name: "Cancel" })]) {
      const box = await locator.boundingBox();
      expect(box, "visible").not.toBeNull();
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.y + box!.height).toBeLessThanOrEqual(300);
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    }
    const dialogBox = await dialog.boundingBox();
    expect(dialogBox!.y).toBeGreaterThanOrEqual(0);
    expect(dialogBox!.y + dialogBox!.height).toBeLessThanOrEqual(300);
    await expect(closeButton(dialog)).toBeEnabled();
    expect(await overflow()).toEqual({ page: 0, dialog: 0 });
  });
});

test.describe("Close in demo mode", () => {
  test("asks nothing of any bridge and behaves as it always did", async ({ demo }) => {
    const summaries = watchSummaries(demo);
    await demo.getByText("migrate", { exact: true }).first().click();
    const dialog = await openClose(demo);
    await expect(closeButton(dialog)).toBeEnabled();
    await expect(consentField(dialog)).toHaveCount(0);
    await expect(dialog.getByText("Checking the checkout…")).toHaveCount(0);
    await closeButton(dialog).click();
    await expect(dialog).toBeHidden();
    expect(summaries).toHaveLength(0);
  });
});
