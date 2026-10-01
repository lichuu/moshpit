import type { Page } from "@playwright/test";
import { test, expect, openApp, seedHosts, loginBridge, pairBridge, isPhone } from "../fixtures";

// S5: the pane says honestly whether it is connecting, live, retrying or
// disconnected; a switch never shows the old pane's rows; a layout change
// keeps the connection; offline drops unsent keys; and touch can let go of
// raw input.

const herdr = `
case "$*" in
  "api snapshot"*) echo '{"result":{"snapshot":{"agents":[{"pane_id":"w1:p1","agent":"codex","agent_status":"working","cwd":"/repo/app","workspace_id":"w1","terminal_title":"codex","revision":1},{"pane_id":"w1:p2","agent":"codex","agent_status":"idle","cwd":"/repo/other","workspace_id":"w1","terminal_title":"codex","revision":1}]}}}' ;;
  "pane list"*) echo '{"result":{"panes":[{"pane_id":"w1:p1","label":"alpha","terminal_id":"term_a","cwd":"/repo/app","workspace_id":"w1"},{"pane_id":"w1:p2","label":"beta","terminal_id":"term_b","cwd":"/repo/other","workspace_id":"w1"}]}}' ;;
  "pane read w1:p1"*) printf 'ALPHA-ROW one\\nALPHA-ROW two\\n$ ' ;;
  "pane read w1:p2"*) printf 'BETA-ROW one\\n$ ' ;;
  *) echo '{}' ;;
esac`;

async function openTerminal(page: Page, bridge: { url: string; port: number }, label = "alpha") {
  await openApp(page, { demo: false });
  const token = await loginBridge(page, bridge.url);
  await pairBridge(page, bridge.url, token);
  await seedHosts(page, [{
    id: "e2e", label: "E2E", transport: "tailscale", user: "",
    hostname: "127.0.0.1", port: bridge.port, demo: false, tailnetUrl: bridge.url,
  }], "e2e");
  await page.getByRole("button", { name: new RegExp(label) }).first().click({ timeout: 20_000 });
  await page.getByRole("button", { name: "Terminal view", exact: true }).click();
}

const status = (page: Page, name: string) => page.getByRole("status", { name });

test.describe("terminal surface", () => {
  test("says connecting, live, reconnecting and disconnected in turn", async ({ page, bridge, context }) => {
    const host = await bridge({ herdr });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route(`${host.url}/api/terminal-ticket`, async (route) => {
      await held;
      await route.continue();
    });
    const open: import("@playwright/test").WebSocketRoute[] = [];
    let refuse = false;
    await page.routeWebSocket(/\/pty/, (ws) => {
      if (refuse) { void ws.close(); return; }
      open.push(ws);
      ws.connectToServer();
    });

    await openTerminal(page, host);
    await expect(status(page, "Connecting to the pane")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Connecting…")).toBeVisible();
    release();
    await expect(status(page, "Live PTY")).toBeVisible({ timeout: 20_000 });

    refuse = true;
    await Promise.all(open.map((ws) => ws.close()));
    await expect(status(page, "Reconnecting to the pane")).toBeVisible();
    await expect(page.getByText(/^Reconnecting/)).toBeVisible();

    await context.setOffline(true);
    await expect(status(page, "Pane disconnected")).toBeVisible();
    await expect(page.getByText("Offline", { exact: true })).toBeVisible();

    refuse = false;
    await context.setOffline(false);
    await expect(status(page, "Live PTY")).toBeVisible({ timeout: 20_000 });
  });

  test("a revoked device stops reconnecting and says the pane is disconnected", async ({ page, bridge }) => {
    const host = await bridge({ herdr });
    let revoked = false;
    let refusals = 0;
    await page.route(`${host.url}/api/terminal-ticket`, async (route) => {
      if (!revoked) return route.continue();
      refusals += 1;
      await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: { code: "device_revoked", message: "This device was revoked" } }) });
    });
    const open: import("@playwright/test").WebSocketRoute[] = [];
    await page.routeWebSocket(/\/pty/, (ws) => {
      if (revoked) { void ws.close(); return; }
      open.push(ws);
      ws.connectToServer();
    });

    await openTerminal(page, host);
    await expect(status(page, "Live PTY")).toBeVisible({ timeout: 20_000 });
    revoked = true;
    await Promise.all(open.map((ws) => ws.close()));
    await expect(status(page, "Pane disconnected")).toBeVisible({ timeout: 10_000 });
    const spent = refusals;
    await page.waitForTimeout(3000);
    expect(refusals, "no further tickets once revoked").toBe(spent);
  });

  test("a pane switch starts empty and never shows the old pane's rows", async ({ page, bridge }, testInfo) => {
    const host = await bridge({ herdr });
    await openTerminal(page, host);
    const pane = page.locator(".terminal-pane");
    await expect(pane).toContainText("ALPHA-ROW two", { timeout: 20_000 });

    // Beta's ticket is held, so for a while its surface has no stream at all:
    // whatever it shows then can only have come from alpha.
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route(`${host.url}/api/terminal-ticket`, async (route) => {
      if (route.request().postDataJSON()?.target === "w1:p2") await held;
      await route.continue();
    });
    const seen: string[] = [];
    await page.exposeFunction("__rows", (text: string) => { seen.push(text); });
    await page.evaluate(() => {
      const observer = new MutationObserver(() => {
        const el = document.querySelector(".terminal-pane");
        if (el) (window as unknown as { __rows: (t: string) => void }).__rows(el.textContent ?? "");
      });
      observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    });

    if (isPhone(testInfo)) await page.getByRole("button", { name: "Back", exact: true }).click();
    await page.getByRole("button", { name: /beta/ }).first().click();
    if (isPhone(testInfo)) await page.getByRole("button", { name: "Terminal view", exact: true }).click();
    await expect(page.getByRole("application", { name: "Pane w1:p2" })).toBeVisible();
    await page.waitForTimeout(800);
    expect(await pane.textContent()).not.toContain("ALPHA-ROW");
    release();
    await expect(pane).toContainText("BETA-ROW one", { timeout: 20_000 });
    await page.waitForTimeout(300);
    const afterSwitch = seen.slice(seen.findIndex((t) => t.includes("BETA-ROW") || !t.includes("ALPHA-ROW")));
    expect(afterSwitch.some((t) => t.includes("ALPHA-ROW")), "no alpha rows after the switch").toBe(false);
  });

  test("a layout change keeps the pane's connection", async ({ page, bridge }, testInfo) => {
    test.skip(!isPhone(testInfo), "rotation and the phone-to-wide change start from a phone");
    const host = await bridge({ herdr });
    let tickets = 0;
    await page.route(`${host.url}/api/terminal-ticket`, async (route) => {
      tickets += 1;
      await route.continue();
    });
    await openTerminal(page, host);
    await expect(status(page, "Live PTY")).toBeVisible({ timeout: 20_000 });
    const before = tickets;

    // Rotation and a soft-keyboard-sized shrink. Crossing into the wide
    // layout is not covered: AppShell renders a different tree there, which
    // remounts the whole detail view, Chat included.
    for (const size of [{ width: 844, height: 390 }, { width: 390, height: 500 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(size);
      await page.waitForTimeout(500);
    }
    await expect(status(page, "Live PTY")).toBeVisible();
    expect(tickets, "a layout change does not reconnect").toBe(before);
  });

  test("going offline drops keys not yet sent, and never sends them later", async ({ page, bridge, context }) => {
    const host = await bridge({ herdr });
    await openTerminal(page, host);
    await expect(status(page, "Live PTY")).toBeVisible({ timeout: 20_000 });

    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let first = true;
    await page.route(`${host.url}/api/action`, async (route) => {
      if (first) {
        first = false;
        await held;
      }
      await route.continue().catch(() => {});
    });

    const pane = page.getByRole("application", { name: "Pane w1:p1" });
    await pane.focus();
    await page.keyboard.type("x");
    await page.keyboard.press("Tab");
    await page.keyboard.type("yz");
    await context.setOffline(true);
    await expect(page.getByText(/unsent keys? (was|were) dropped/)).toBeVisible();
    await context.setOffline(false);
    release();
    await page.waitForTimeout(1500);

    const writes = (await host.calls()).filter((line) => /^pane send-(text|keys) w1:p1/.test(line));
    expect(writes.join("\n")).not.toMatch(/tab|yz/);
  });

  test("a one-line paste is typed once with no Enter; a multi-line one is held for the composer", async ({ page, bridge }) => {
    const host = await bridge({ herdr });
    await openTerminal(page, host);
    await expect(status(page, "Live PTY")).toBeVisible({ timeout: 20_000 });
    const pane = page.getByRole("application", { name: "Pane w1:p1" });
    // A real copy, then a trusted Ctrl+V on the pane: Firefox hands a
    // synthetic ClipboardEvent an empty clipboardData, so only this path
    // proves the same thing in every engine.
    const paste = async (text: string) => {
      await page.evaluate((value) => {
        const field = document.createElement("textarea");
        field.id = "__clip";
        field.value = value;
        document.body.appendChild(field);
        field.select();
      }, text);
      await page.keyboard.press("ControlOrMeta+C");
      await page.evaluate(() => document.getElementById("__clip")?.remove());
      await pane.focus();
      await page.keyboard.press("ControlOrMeta+V");
    };
    const writes = async () => (await host.calls()).filter((line) => /^pane send-(text|keys) w1:p1/.test(line));

    // Control: does this engine's headless build carry a keyboard copy and
    // paste at all? If an ordinary textarea receives nothing, the pane's
    // result would say nothing about moshpit, so the case is skipped with
    // that reason instead of failing or passing on it.
    await page.evaluate((value) => {
      const source = document.createElement("textarea");
      source.id = "__src";
      source.value = value;
      const target = document.createElement("textarea");
      target.id = "__dst";
      document.body.append(source, target);
      source.select();
    }, "clipboard-check");
    await page.keyboard.press("ControlOrMeta+C");
    await page.locator("#__dst").focus();
    await page.keyboard.press("ControlOrMeta+V");
    const clipboardWorks = (await page.locator("#__dst").inputValue()) === "clipboard-check";
    await page.evaluate(() => { document.getElementById("__src")?.remove(); document.getElementById("__dst")?.remove(); });
    test.skip(!clipboardWorks, "this engine's headless build does not carry a keyboard copy/paste even into a textarea");

    await pane.focus();
    await paste("git status --short");
    await expect.poll(async () => (await writes()).map((l) => l.replace("pane send-text w1:p1 ", "")).join("")).toBe("git status --short");
    expect((await writes()).some((l) => l.startsWith("pane send-keys")), "no key, Enter included, follows the paste").toBe(false);

    // A shell would run the first line the moment its newline arrived.
    const sent = (await writes()).length;
    await paste("rm -rf build\nmake all");
    const alert = page.getByRole("alert").filter({ hasText: "Pasted 2 lines" });
    await expect(alert).toBeVisible();
    await page.waitForTimeout(500);
    expect((await writes()).length, "nothing from the multi-line paste reached the pane").toBe(sent);

    await alert.getByRole("button", { name: "Move to composer" }).click();
    await expect(page.getByRole("textbox", { name: "Terminal input" })).toHaveValue("rm -rf build\nmake all");
    await expect(alert).toHaveCount(0);
    await page.waitForTimeout(500);
    expect((await writes()).length, "moving it does not submit it").toBe(sent);

    await paste("one\ntwo");
    await page.getByRole("alert").getByRole("button", { name: "Discard" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Pasted" })).toHaveCount(0);
    expect((await writes()).length).toBe(sent);
  });

  test("touch can leave raw terminal input", async ({ page, bridge }, testInfo) => {
    test.skip(!isPhone(testInfo), "wide layouts keep focus on the pane and have a hardware keyboard");
    const host = await bridge({ herdr });
    await openTerminal(page, host);
    const pane = page.getByRole("application", { name: "Pane w1:p1" });
    await expect(pane).toContainText("ALPHA-ROW", { timeout: 20_000 });

    await page.getByRole("button", { name: "esc", exact: true }).click();
    await expect(pane).toBeFocused();
    const leave = page.getByRole("button", { name: "Leave terminal input" });
    await leave.click();
    await expect(pane).not.toBeFocused();
    await expect(leave).toHaveCount(0);
  });
});
