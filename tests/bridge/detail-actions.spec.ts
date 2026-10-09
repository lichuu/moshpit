import type { Page, Route } from "@playwright/test";
import { test, expect, openApp, seedHosts, loginBridge, pairBridge, isPhone } from "../fixtures";

// S11: the Shell button is busy until the open-shell request actually settles
// and shows a failure; and a shell that finishes opening after the user moved
// to another pane does not drag them into it.

const herdr = `
case "$*" in
  "api snapshot"*) echo '{"result":{"snapshot":{"agents":[{"pane_id":"w1:p1","agent":"codex","agent_status":"working","cwd":"/repo/app","workspace_id":"w1","terminal_title":"codex","revision":1},{"pane_id":"w1:p2","agent":"codex","agent_status":"idle","cwd":"/repo/other","workspace_id":"w1","terminal_title":"codex","revision":1}]}}}' ;;
  "pane list"*) echo '{"result":{"panes":[{"pane_id":"w1:p1","label":"alpha","terminal_id":"term_a","cwd":"/repo/app","workspace_id":"w1"},{"pane_id":"w1:p2","label":"beta","terminal_id":"term_b","cwd":"/repo/other","workspace_id":"w1"}]}}' ;;
  *) echo '{}' ;;
esac`;

async function openDetail(page: Page, bridge: { url: string; port: number }, label = "alpha") {
  await openApp(page, { demo: false });
  const token = await loginBridge(page, bridge.url);
  await pairBridge(page, bridge.url, token);
  await seedHosts(page, [{
    id: "e2e", label: "E2E", transport: "tailscale", user: "",
    hostname: "127.0.0.1", port: bridge.port, demo: false, tailnetUrl: bridge.url,
  }], "e2e");
  await page.getByRole("button", { name: new RegExp(label) }).first().click({ timeout: 20_000 });
}

/** Holds every open-shell request until `release` is called, then answers with `reply`. */
async function holdOpenShell(page: Page, url: string, reply: (route: Route) => Promise<void>) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let requests = 0;
  await page.route(`${url}/api/action`, async (route) => {
    if (!route.request().postData()?.includes('"open-shell"')) return route.continue();
    requests += 1;
    await held;
    await reply(route);
  });
  return { release: () => release(), requests: () => requests };
}

const refuse = (route: Route) =>
  route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: { code: "herdr_failed", message: "herdr refused the shell" } }) });

test.describe("detail header actions", () => {
  test("Shell stays busy until the request settles, then shows the failure", async ({ page, bridge }) => {
    const host = await bridge({ herdr });
    const gate = await holdOpenShell(page, host.url, refuse);
    await openDetail(page, host);

    const shell = page.getByRole("button", { name: "Open shell here" });
    await shell.click();
    const busy = page.getByRole("button", { name: "Opening shell…" });
    await expect(busy).toBeDisabled();
    // Well past the old ten-second timer's first seconds, still busy: it is
    // the request, not a clock, that decides.
    await page.waitForTimeout(1500);
    await expect(busy).toBeDisabled();
    expect(gate.requests()).toBe(1);

    gate.release();
    await expect(page.getByText("Shell wasn't opened")).toBeVisible();
    await expect(page.getByText("herdr refused the shell")).toBeVisible();
    const again = page.getByRole("button", { name: "Open shell here" });
    await expect(again).toBeEnabled();
    await expect(again).toHaveAttribute("title", /did not open/);
    expect(gate.requests()).toBe(1);
  });

  test("a shell that opens after the user moved on does not take them over", async ({ page, bridge }, testInfo) => {
    const host = await bridge({ herdr });
    const gate = await holdOpenShell(page, host.url, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ paneId: "w1:p9" }) }),
    );
    await openDetail(page, host, "alpha");
    await page.getByRole("button", { name: "Open shell here" }).click();
    await expect(page.getByRole("button", { name: "Opening shell…" })).toBeDisabled();

    // Move to the other agent while the shell is still opening.
    if (isPhone(testInfo)) await page.getByRole("button", { name: "Back", exact: true }).click();
    await page.getByRole("button", { name: /beta/ }).first().click();
    await expect(page.getByRole("heading", { name: "beta" })).toBeVisible();
    // The new pane's Shell is not stuck on the other pane's request.
    await expect(page.getByRole("button", { name: "Open shell here" })).toBeEnabled();

    gate.release();
    await page.waitForTimeout(800);
    await expect(page.getByRole("heading", { name: "beta" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Chat view" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByText("companion shell")).toHaveCount(0);
  });
});
