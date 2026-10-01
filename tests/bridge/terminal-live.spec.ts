import { test, expect, openApp, seedHosts, loginBridge, pairBridge } from "../fixtures";

const herdr = `
case "$*" in
  "api snapshot"*) echo '{"result":{"snapshot":{"agents":[{"pane_id":"w1:p1","agent":"codex","agent_status":"working","cwd":"/repo/app","workspace_id":"w1","terminal_title":"codex","revision":1}]}}}' ;;
  "pane list"*) echo '{"result":{"panes":[{"pane_id":"w1:p1","label":"livewire","terminal_id":"term_lw1","cwd":"/repo/app","workspace_id":"w1"}]}}' ;;
  "pane read w1:p1"*) printf 'line one\\nline two\\n$ ' ;;
  *) echo '{}' ;;
esac`;

test("the pane dot says when the socket is down, not just live", async ({ page, bridge }) => {
  const host = await bridge({ herdr });
  // Pass sockets through until the test cuts them, then refuse new ones so
  // the pane stays down long enough to look at.
  const open: import("@playwright/test").WebSocketRoute[] = [];
  let cut = false;
  await page.routeWebSocket(/\/pty/, (ws) => {
    if (cut) {
      void ws.close();
      return;
    }
    open.push(ws);
    ws.connectToServer();
  });

  await openApp(page, { demo: false });
  const token = await loginBridge(page, host.url);
  await pairBridge(page, host.url, token);
  await seedHosts(page, [{
    id: "e2e", label: "E2E", transport: "tailscale", user: "",
    hostname: "127.0.0.1", port: host.port, demo: false, tailnetUrl: host.url,
  }], "e2e");
  await page.getByRole("button", { name: /livewire/ }).first().click({ timeout: 20_000 });
  await page.getByRole("button", { name: "Terminal view", exact: true }).click();

  await expect(page.getByRole("status", { name: "Live PTY" })).toBeVisible({ timeout: 20_000 });
  cut = true;
  await Promise.all(open.map((ws) => ws.close()));
  await expect(page.getByRole("status", { name: "Reconnecting to the pane" })).toBeVisible();
});
