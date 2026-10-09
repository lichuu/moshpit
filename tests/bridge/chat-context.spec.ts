import type { Page } from "@playwright/test";
import { test, expect, openApp, seedHosts, loginBridge, pairBridge, isPhone } from "../fixtures";

// C1: the context meter under the composer, in the detail header, and on the
// agent card past amber. /api/session is stubbed so each case controls exactly
// what the bridge "measured"; everything else goes through a real bridge.

type Context = Record<string, unknown> | undefined;

const herdr = `
case "$*" in
  "api snapshot"*) echo '{"result":{"snapshot":{"agents":[{"pane_id":"w1:p1","agent":"codex","agent_status":"working","cwd":"/repo/app","workspace_id":"w1","terminal_title":"codex","agent_session":{"kind":"id","value":"s1"},"revision":1},{"pane_id":"w1:p2","agent":"opencode","agent_status":"idle","cwd":"/repo/other","workspace_id":"w1","terminal_title":"opencode","agent_session":{"kind":"id","value":"s2"},"revision":1}]}}}' ;;
  "pane list"*) echo '{"result":{"panes":[{"pane_id":"w1:p1","label":"reader","cwd":"/repo/app","workspace_id":"w1"},{"pane_id":"w1:p2","label":"elsewhere","cwd":"/repo/other","workspace_id":"w1"}]}}' ;;
  "pane read"*) printf 'codex' ;;
  *) echo '{}' ;;
esac`;

const entry = (target: string) => ({ id: `${target}:m1`, turnId: "t1", kind: "message", role: "assistant", text: "Hello from the fixture." });

async function serveSessions(page: Page, url: string, contexts: Record<string, Context>) {
  await page.route(`${url}/api/session?**`, (route) => {
    const target = new URL(route.request().url()).searchParams.get("target") ?? "";
    const context = contexts[target];
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        kind: "available", agentId: target, sessionId: `stream-${target}`,
        entries: [entry(target)], cursor: "1", before: null, reset: false,
        capabilities: { inputModes: ["send"], stop: false, fit: false },
        ...(context ? { context } : {}),
      }),
    });
  });
}

async function openReader(page: Page, url: string, port: number, label = "reader") {
  await openApp(page, { demo: false });
  const token = await loginBridge(page, url);
  await pairBridge(page, url, token);
  await seedHosts(page, [{ id: "e2e", label: "E2E", transport: "tailscale", user: "", hostname: "127.0.0.1", port, demo: false, tailnetUrl: url }], "e2e");
  const card = page.getByRole("button", { name: new RegExp(label) }).first();
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.click();
  await expect(page.locator(".conversation [data-entry-id]").first()).toBeVisible({ timeout: 20_000 });
}

const slot = (page: Page) => page.locator(".composer-meter");
const meter = (page: Page) => slot(page).getByRole("meter", { name: "Context use" });

test.describe("context meter", () => {
  test("shows a percentage and the meter role when the capacity is known", async ({ page, bridge }) => {
    const host = await bridge({ herdr });
    await serveSessions(page, host.url, { "w1:p1": { used: 168_640, capacity: 272_000 } });
    await openReader(page, host.url, host.port);

    await expect(meter(page)).toBeVisible();
    await expect(meter(page)).toHaveText("62% of context");
    await expect(meter(page)).toHaveAttribute("aria-valuenow", "62");
    await expect(meter(page)).toHaveAttribute("aria-valuemin", "0");
    await expect(meter(page)).toHaveAttribute("aria-valuemax", "100");
    await expect(meter(page)).toHaveAttribute("aria-valuetext", "62% of context");
    await expect(meter(page)).toHaveAttribute("data-level", "ok");
  });

  test("shows tokens only, as plain text, when the capacity is unknown", async ({ page, bridge }) => {
    const host = await bridge({ herdr });
    await serveSessions(page, host.url, { "w1:p1": { used: 84_200 } });
    await openReader(page, host.url, host.port);

    await expect(slot(page)).toContainText("84k tokens in context");
    await expect(slot(page)).not.toContainText("%");
    await expect(slot(page).getByRole("meter")).toHaveCount(0);
    await expect(slot(page).getByTestId("context-meter")).toHaveAttribute("data-level", "unknown");
  });

  test("turns amber at 75% and red at 90%, and says the number either way", async ({ page, bridge }) => {
    const host = await bridge({ herdr });
    const contexts: Record<string, Context> = { "w1:p1": { used: 74_000, capacity: 100_000 } };
    await serveSessions(page, host.url, contexts);
    await openReader(page, host.url, host.port);

    await expect(meter(page)).toHaveAttribute("data-level", "ok");
    contexts["w1:p1"] = { used: 75_000, capacity: 100_000 };
    await expect(meter(page)).toHaveAttribute("data-level", "warn");
    await expect(meter(page)).toHaveText("75% of context");
    contexts["w1:p1"] = { used: 89_000, capacity: 100_000 };
    await expect(meter(page)).toHaveAttribute("data-level", "warn");
    contexts["w1:p1"] = { used: 90_000, capacity: 100_000 };
    await expect(meter(page)).toHaveAttribute("data-level", "high");
    await expect(meter(page)).toHaveText("90% of context");
    // A compaction clears the measurement: nothing is left behind.
    contexts["w1:p1"] = undefined;
    await expect(slot(page).getByRole("meter")).toHaveCount(0);
    await expect(slot(page)).toHaveText("");
  });

  test("renders nothing without the field, and reserves no line for harnesses without usage", async ({ page, bridge }, testInfo) => {
    // Phones open an agent over the list; wider layouts show both.
    const host = await bridge({ herdr });
    await serveSessions(page, host.url, {});
    await openReader(page, host.url, host.port);

    await expect(slot(page)).toHaveText("");
    await expect(slot(page).getByRole("meter")).toHaveCount(0);
    await expect(page.getByText(/of context|tokens in context/)).toHaveCount(0);

    // A harness that never reports usage gets no line at all.
    if (isPhone(testInfo)) await page.getByRole("button", { name: "Back", exact: true }).click();
    await page.getByRole("button", { name: /elsewhere/ }).first().click();
    await expect(page.locator(".conversation [data-entry-id]").first()).toBeVisible();
    await expect(slot(page)).toHaveCount(0);
  });

  test("the input does not move when the meter appears, changes or goes", async ({ page, bridge }) => {
    const host = await bridge({ herdr });
    const contexts: Record<string, Context> = {};
    await serveSessions(page, host.url, contexts);
    await openReader(page, host.url, host.port);

    const input = page.getByRole("textbox", { name: "Message agent" });
    const before = await input.boundingBox();
    expect(before).not.toBeNull();
    const sameBox = async () => {
      const now = await input.boundingBox();
      for (const key of ["x", "y", "width", "height"] as const) expect(Math.abs((now?.[key] ?? NaN) - (before?.[key] ?? 0)), key).toBeLessThanOrEqual(1);
    };

    contexts["w1:p1"] = { used: 50_000, capacity: 100_000, limits: { primary: { usedPercent: 62, windowMinutes: 300, resetsAt: Math.floor(Date.now() / 1000) + 10_800 } } };
    await expect(meter(page)).toBeVisible();
    await expect(page.getByTestId("context-limits")).toBeVisible();
    await sameBox();
    contexts["w1:p1"] = { used: 95_000 };
    await expect(slot(page)).toContainText("95k tokens in context");
    await sameBox();
    contexts["w1:p1"] = undefined;
    await expect(slot(page).getByRole("meter")).toHaveCount(0);
    await expect(slot(page)).toHaveText("");
    await sameBox();
  });

  test("shows the plan window and its reset in the viewer's own clock when present", async ({ page, bridge }) => {
    const host = await bridge({ herdr });
    const resetsAt = Math.floor(Date.now() / 1000) + 3 * 3600;
    const contexts: Record<string, Context> = {
      "w1:p1": {
        used: 30_000, capacity: 100_000,
        limits: { primary: { usedPercent: 62, windowMinutes: 300, resetsAt }, secondary: { usedPercent: 18, windowMinutes: 10080, resetsAt: resetsAt + 86_400 * 3 } },
      },
    };
    await serveSessions(page, host.url, contexts);
    await openReader(page, host.url, host.port);

    const limits = page.getByTestId("context-limits");
    await expect(limits).toContainText("5h window 62% · resets ");
    const expected = new Date(resetsAt * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    await expect(limits).toContainText(expected);
    // A window whose reset has already passed describes nothing current.
    contexts["w1:p1"] = { used: 30_000, capacity: 100_000, limits: { primary: { usedPercent: 99, windowMinutes: 300, resetsAt: Math.floor(Date.now() / 1000) - 60 } } };
    await expect(limits).toHaveCount(0);
  });

  test("the detail header and the agent card carry it only past amber", async ({ page, bridge }, testInfo) => {
    const host = await bridge({ herdr });
    const contexts: Record<string, Context> = { "w1:p1": { used: 40_000, capacity: 100_000 } };
    await serveSessions(page, host.url, contexts);
    await openReader(page, host.url, host.port);

    const header = page.locator("section > header");
    const card = page.locator(".agent-card", { hasText: "reader" });
    // The composer shows the everyday figure; the header and card stay quiet.
    await expect(page.locator(".composer-meter")).toContainText("40%");
    await expect(header.getByRole("meter")).toHaveCount(0);
    if (!isPhone(testInfo)) await expect(card.getByRole("meter")).toHaveCount(0);

    contexts["w1:p1"] = { used: 80_000, capacity: 100_000 };
    await expect(header.getByRole("meter", { name: "Context use" })).toHaveAttribute("data-level", "warn");
    await expect(header.getByRole("meter", { name: "Context use" })).toHaveAttribute("aria-valuenow", "80");
    if (!isPhone(testInfo)) await expect(card.getByRole("meter", { name: "Context use" })).toHaveAttribute("data-level", "warn");

    // Tokens alone have no threshold to be past.
    contexts["w1:p1"] = { used: 95_000 };
    await expect(page.locator(".composer-meter")).toContainText("95k tokens");
    await expect(header.getByRole("meter")).toHaveCount(0);
    await expect(header).not.toContainText("tokens");
    if (!isPhone(testInfo)) await expect(card).not.toContainText("tokens");
  });
});
