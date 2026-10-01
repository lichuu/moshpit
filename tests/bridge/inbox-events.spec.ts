import path from "node:path";
import { writeFile } from "node:fs/promises";
import { test, expect, openApp, seedHosts, loginBridge, pairBridge } from "../fixtures";

// Working until the test drops a "blocked" file into the state dir.
const herdr = `
case "$*" in
  "api snapshot"*)
    if [ -f "$MOSHPIT_STATE_DIR/blocked" ]; then status=blocked; else status=working; fi
    echo '{"result":{"snapshot":{"agents":[{"pane_id":"w1:p1","agent":"codex","agent_status":"'$status'","cwd":"/repo/app","workspace_id":"w1","terminal_title":"codex","revision":1}]}}}'
    ;;
  "pane list"*) echo '{"result":{"panes":[{"pane_id":"w1:p1","label":"flipper","terminal_id":"term_f1","cwd":"/repo/app","workspace_id":"w1"}]}}' ;;
  "pane read w1:p1"*) printf 'Proceed with the deploy? y/n' ;;
  *) echo '{}' ;;
esac`;

test("an agent that turns blocked gets one Inbox row, not two", async ({ page, bridge }) => {
  const host = await bridge({ herdr });
  await openApp(page, { demo: false });
  const token = await loginBridge(page, host.url);
  await pairBridge(page, host.url, token);
  await seedHosts(page, [{
    id: "e2e", label: "E2E", transport: "tailscale", user: "",
    hostname: "127.0.0.1", port: host.port, demo: false, tailnetUrl: host.url,
  }], "e2e");
  await expect(page.getByRole("button", { name: /flipper/ }).first()).toBeVisible({ timeout: 20_000 });

  // The live poll sees the transition. It used to add a row for the
  // transition and another for "blocked with no open row" in the same tick.
  await writeFile(path.join(host.dir, "state", "blocked"), "");
  await page.getByRole("button", { name: /Inbox/ }).first().click();
  const rows = page.locator("article").filter({ hasText: "flipper" });
  await expect(rows.first()).toBeVisible({ timeout: 20_000 });
  // Let a few more polls land: a later tick must not add one either.
  await page.waitForTimeout(3_000);
  await expect(rows).toHaveCount(1);
});
