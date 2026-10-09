import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect, openApp, seedHosts, loginBridge, pairBridge } from "../fixtures";

// S9: the agent's live pane inside Chat. It is the Terminal surface with its
// own ticket; closing it sends nothing; its keys are bound to the session it
// was attached to; and toggling it costs neither the draft nor the reader's
// place. The fake herdr changes its answers when the test drops a file beside
// it: "switched" starts a new session in the pane, "gone" closes the pane.

type Entry = Record<string, unknown> & { id: string };
const para = "The quick brown fox jumps over the lazy dog, and then it does so again for good measure. ";
const message = (id: string): Entry => ({ id, turnId: `t-${id}`, kind: "message", role: "assistant", text: `${id}. ${para.repeat(4)}` });

const herdr = `
D="$(dirname "$0")/.."
S=s1; [ -f "$D/switched" ] && S=s2
BETA='{"pane_id":"w1:p2","agent":"codex","agent_status":"idle","cwd":"/repo/other","workspace_id":"w1","terminal_title":"codex","agent_session":{"kind":"id","value":"b1"},"revision":1}'
case "$*" in
  "api snapshot"*)
    if [ -f "$D/gone" ]; then echo '{"result":{"snapshot":{"agents":['"$BETA"']}}}'
    else echo '{"result":{"snapshot":{"agents":[{"pane_id":"w1:p1","agent":"codex","agent_status":"idle","cwd":"/repo/app","workspace_id":"w1","terminal_title":"codex","agent_session":{"kind":"id","value":"'"$S"'"},"revision":1},'"$BETA"']}}}'
    fi ;;
  "pane list"*) echo '{"result":{"panes":[{"pane_id":"w1:p1","label":"alpha","terminal_id":"term_a","cwd":"/repo/app","workspace_id":"w1"},{"pane_id":"w1:p2","label":"beta","terminal_id":"term_b","cwd":"/repo/other","workspace_id":"w1"}]}}' ;;
  "pane read w1:p1"*) printf 'ALPHA-MENU model\\n> gpt-5\\n  gpt-5-mini\\n' ;;
  "pane read w1:p2"*) printf 'BETA-ROW one\\n$ ' ;;
  *) echo '{}' ;;
esac`;

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

const transcript = { "w1:p1": Array.from({ length: 14 }, (_, i) => message(`m${i + 1}`)), "w1:p2": [message("b1")] };

async function openChat(page: Page, host: { url: string; port: number }, label = "alpha") {
  await serveSessions(page, host.url, transcript);
  await openApp(page, { demo: false });
  const token = await loginBridge(page, host.url);
  await pairBridge(page, host.url, token);
  await seedHosts(page, [{ id: "e2e", label: "E2E", transport: "tailscale", user: "", hostname: "127.0.0.1", port: host.port, demo: false, tailnetUrl: host.url }], "e2e");
  await openAgent(page, label);
}

async function openAgent(page: Page, label: string) {
  const card = page.getByRole("button", { name: new RegExp(label) }).first();
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.click();
}

async function back(page: Page) {
  const button = page.getByRole("button", { name: "Back", exact: true });
  if (await button.isVisible()) await button.click();
}

/** Counts pane sockets as the page opens and closes them. */
async function watchSockets(page: Page) {
  const live = new Set<unknown>();
  const sockets = { opened: 0, get open() { return live.size; } };
  await page.routeWebSocket(/\/pty/, (ws) => {
    sockets.opened += 1;
    live.add(ws);
    const server = ws.connectToServer();
    ws.onClose(() => { live.delete(ws); server.close(); });
    server.onClose(() => { live.delete(ws); void ws.close(); });
  });
  return sockets;
}

const panel = (page: Page) => page.getByRole("region", { name: "Native pane" });
const show = (page: Page) => page.getByRole("button", { name: "Show native pane" });
const writes = (calls: string[]) => calls.filter((line) => /^pane send-(keys|text) /.test(line));
const offsetOf = (page: Page, entryId: string) =>
  page.locator(".conversation").evaluate((el, id) => {
    const card = el.querySelector(`[data-entry-id="${CSS.escape(id)}"]`);
    return card ? card.getBoundingClientRect().top - el.getBoundingClientRect().top : null;
  }, entryId);

test.describe("native pane in Chat", () => {
  test("shows the live pane on one socket, and closing it sends nothing", async ({ page, bridge }) => {
    const host = await bridge({ herdr });
    const sockets = await watchSockets(page);
    await openChat(page, host);
    await expect(show(page)).toHaveAttribute("aria-pressed", "false");
    expect(sockets.opened).toBe(0);

    await show(page).click();
    await expect(panel(page).getByRole("status", { name: "Live PTY" })).toBeVisible({ timeout: 20_000 });
    await expect(panel(page).getByText("ALPHA-MENU model")).toBeVisible();
    // On a screen this short the pane takes the transcript's place.
    await expect(page.locator(".conversation")).toHaveCount(0);
    expect(sockets.open).toBe(1);

    await page.getByRole("button", { name: "Close native pane" }).click();
    await expect(panel(page)).toHaveCount(0);
    await expect.poll(() => sockets.open).toBe(0);
    // Closing is not cancelling: no Escape, no key, no text reached the pane.
    expect(writes(await host.calls())).toEqual([]);

    // Reopening attaches again with a ticket of its own.
    await show(page).click();
    await expect(panel(page).getByRole("status", { name: "Live PTY" })).toBeVisible({ timeout: 20_000 });
    expect(sockets.opened).toBe(2);
    expect(sockets.open).toBe(1);
  });

  test("a tall screen shows the transcript above the pane", async ({ page, bridge }) => {
    const host = await bridge({ herdr });
    await watchSockets(page);
    const size = page.viewportSize();
    await page.setViewportSize({ width: size?.width ?? 390, height: 1100 });
    await openChat(page, host);
    await show(page).click();
    await expect(panel(page).getByRole("status", { name: "Live PTY" })).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.conversation [data-entry-id="m14"]')).toBeVisible();
    const hide = page.getByRole("button", { name: "Hide native pane" });
    await expect(hide).toHaveAttribute("aria-pressed", "true");
    await hide.click();
    await expect(panel(page)).toHaveCount(0);
    expect(writes(await host.calls())).toEqual([]);
  });

  test("a delivered command offers the pane, and its keys reach this pane only", async ({ page, bridge }) => {
    const host = await bridge({ herdr });
    await watchSockets(page);
    await openChat(page, host);

    // Spacing inside the command survives, the line break around it does not,
    // and the draft clears on delivery.
    const input = page.getByRole("textbox", { name: "Message agent" });
    await input.fill("/model  gpt-5   high\n");
    await page.getByRole("button", { name: "Send" }).click();
    await expect.poll(async () => writes(await host.calls())).toEqual(["pane send-text w1:p1 /model  gpt-5   high", "pane send-keys w1:p1 enter"]);
    await expect(input).toHaveValue("");

    // Delivered is not done. The pane is offered beside the receipt, and
    // nothing opens it but the tap.
    await expect(panel(page)).toHaveCount(0);
    await page.getByRole("button", { name: "Show pane", exact: true }).click();
    await expect(panel(page).getByRole("status", { name: "Live PTY" })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: "Show pane", exact: true })).toHaveCount(0);

    const keys = panel(page).getByRole("group", { name: "Pane keys" });
    await keys.getByRole("button", { name: "Down" }).click();
    await keys.getByRole("button", { name: "enter" }).click();
    await expect.poll(async () => writes(await host.calls()).slice(2)).toEqual(["pane send-keys w1:p1 down", "pane send-keys w1:p1 enter"]);
  });

  test("toggling the pane keeps the draft and the reader's place", async ({ page, bridge }) => {
    const host = await bridge({ herdr });
    await watchSockets(page);
    await openChat(page, host);
    const reader = page.locator(".conversation");
    await expect(reader.locator('[data-entry-id="m14"]')).toBeVisible({ timeout: 20_000 });
    // Read from the middle, with a real gesture so the reader counts it.
    const box = await reader.boundingBox();
    if (!box) throw new Error("conversation has no box");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -900);
    await expect.poll(async () => (await offsetOf(page, "m9")) !== null).toBe(true);
    await page.waitForTimeout(400);
    const before = await reader.evaluate((el) => {
      const top = el.getBoundingClientRect().top;
      const first = [...el.querySelectorAll<HTMLElement>("[data-entry-id]")].find((card) => card.getBoundingClientRect().bottom > top + 1);
      return first ? { id: first.dataset.entryId!, offset: first.getBoundingClientRect().top - top } : null;
    });
    if (!before) throw new Error("no visible entry to anchor on");
    // Not the bottom: a reader pinned there would come back there anyway.
    expect(await reader.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeGreaterThan(200);

    const input = page.getByRole("textbox", { name: "Message agent" });
    await input.fill("half a thought");

    await show(page).click();
    await expect(panel(page).getByRole("status", { name: "Live PTY" })).toBeVisible({ timeout: 20_000 });
    await expect(input).toHaveValue("half a thought");
    await page.getByRole("button", { name: "Close native pane" }).click();
    await expect(panel(page)).toHaveCount(0);

    await expect(input).toHaveValue("half a thought");
    await expect.poll(async () => Math.abs(((await offsetOf(page, before.id)) ?? Infinity) - before.offset)).toBeLessThanOrEqual(2);
    expect(writes(await host.calls())).toEqual([]);
  });

  test("a new session in the pane lets go of it until the user reattaches", async ({ page, bridge }) => {
    const host = await bridge({ herdr });
    const sockets = await watchSockets(page);
    await openChat(page, host);
    await show(page).click();
    await expect(panel(page).getByRole("status", { name: "Live PTY" })).toBeVisible({ timeout: 20_000 });

    await writeFile(path.join(host.dir, "switched"), "");
    await expect(panel(page).getByText(/started a different session/)).toBeVisible({ timeout: 20_000 });
    await expect(panel(page).getByRole("group", { name: "Pane keys" })).toHaveCount(0);
    await expect(panel(page).getByRole("application")).toHaveCount(0);
    await expect.poll(() => sockets.open).toBe(0);

    // A key still aimed at the old session is refused by the bridge itself.
    const refused = await page.evaluate(async (url) => {
      const origin = new URL(url).origin;
      const saved = JSON.parse(localStorage.getItem(origin) ?? "{}") as { deviceId?: string; deviceSecret?: string; sessionToken?: string };
      const response = await fetch(`${url}/api/action`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${saved.sessionToken}`, "x-moshpit-device": `${saved.deviceId}.${saved.deviceSecret}` },
        body: JSON.stringify({ kind: "keys", target: "w1:p1", keys: ["enter"], sessionId: "s1" }),
      });
      return { status: response.status, body: await response.json() as { error?: { code?: string } } };
    }, host.url);
    expect(refused.status).toBe(409);
    expect(refused.body.error?.code).toBe("session_changed");
    expect(writes(await host.calls())).toEqual([]);

    await panel(page).getByRole("button", { name: "Reattach" }).click();
    await expect(panel(page).getByRole("status", { name: "Live PTY" })).toBeVisible({ timeout: 20_000 });
    await panel(page).getByRole("group", { name: "Pane keys" }).getByRole("button", { name: "esc" }).click();
    await expect.poll(async () => writes(await host.calls())).toEqual(["pane send-keys w1:p1 esc"]);
  });

  test("another agent shows no pane from the first, and a closed pane takes its panel with it", async ({ page, bridge }) => {
    const host = await bridge({ herdr });
    const sockets = await watchSockets(page);
    await openChat(page, host);
    await show(page).click();
    await expect(panel(page).getByText("ALPHA-MENU model")).toBeVisible({ timeout: 20_000 });

    await back(page);
    await openAgent(page, "beta");
    await expect(page.getByRole("textbox", { name: "Message agent" })).toBeVisible();
    await expect(panel(page)).toHaveCount(0);
    await expect(page.getByText("ALPHA-MENU model")).toHaveCount(0);
    await expect.poll(() => sockets.open).toBe(0);

    // Coming back finds the panel where it was left, on a new ticket.
    await back(page);
    await openAgent(page, "alpha");
    await expect(panel(page).getByText("ALPHA-MENU model")).toBeVisible({ timeout: 20_000 });
    expect(sockets.opened).toBe(2);

    await writeFile(path.join(host.dir, "gone"), "");
    await expect(page.getByText("ALPHA-MENU model")).toHaveCount(0, { timeout: 20_000 });
    await expect(panel(page)).toHaveCount(0);
    expect(writes(await host.calls())).toEqual([]);
  });
});
