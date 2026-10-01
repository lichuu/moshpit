import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, openApp, seedHosts, loginBridge, pairBridge } from "../fixtures";

// Pi registers most commands from extensions, in code, so only a running pi
// can list them. The bridge asks one over RPC for the pane's directory; this
// fake answers get_commands with an extension command no disk scan could see.
const FAKE_PI = `#!${process.execPath}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  if (!input.includes("\\n")) return;
  const { id } = JSON.parse(input.slice(0, input.indexOf("\\n")));
  // Slow on purpose: the disk catalog must be usable before this lands.
  setTimeout(() => process.stdout.write(JSON.stringify({ id, type: "response", command: "get_commands", success: true,
    data: { commands: [{ name: "ship-it", description: "Extension: deploy", source: "extension" }] } }) + "\\n"), 800);
});
process.stdin.on("end", () => process.exit(0));
`;

test("a pi pane's extension commands arrive from pi itself, after the disk list", async ({ page, bridge }) => {
  const dir = await mkdtemp(path.join(tmpdir(), "moshpit-pi-e2e-"));
  const pi = path.join(dir, "pi");
  await writeFile(pi, FAKE_PI);
  await chmod(pi, 0o755);
  const host = await bridge({
    env: { MOSHPIT_PI_BIN: pi },
    // The pane's cwd must exist on the bridge host: pi runs there.
    herdr: `
case "$*" in
  "api snapshot"*) echo '{"result":{"snapshot":{"agents":[{"pane_id":"w1:p1","agent":"pi","agent_status":"idle","cwd":"${dir}","workspace_id":"w1","terminal_title":"pi"}]}}}' ;;
  "pane list"*) echo '{"result":{"panes":[{"pane_id":"w1:p1","label":"pi-pane","terminal_id":"term_pi1","cwd":"${dir}","workspace_id":"w1"}]}}' ;;
  *) echo '{}' ;;
esac`,
  });
  await openApp(page, { demo: false });
  const token = await loginBridge(page, host.url);
  await pairBridge(page, host.url, token);
  await seedHosts(page, [{
    id: "e2e", label: "E2E", transport: "tailscale", user: "",
    hostname: "127.0.0.1", port: host.port, demo: false, tailnetUrl: host.url,
  }], "e2e");
  await page.getByRole("button", { name: /pi-pane/ }).first().click({ timeout: 20_000 });
  await page.getByRole("button", { name: "Terminal view", exact: true }).click();

  const input = page.getByRole("textbox", { name: "Terminal input" });
  await input.fill("/");
  const list = page.getByRole("listbox", { name: "Command suggestions" });
  // Built-ins are there at once, before pi has answered.
  await expect(list.getByRole("option", { name: /^\/model/ })).toBeVisible();
  // Then pi's own list lands, extension command included.
  await expect(list.getByRole("option", { name: /^\/ship-it/ })).toBeVisible({ timeout: 15_000 });
});
