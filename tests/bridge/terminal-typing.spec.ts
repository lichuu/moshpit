import { test, expect, openApp, seedHosts, loginBridge, pairBridge } from "../fixtures";

const herdr = `
case "$*" in
  "api snapshot"*) echo '{"result":{"snapshot":{"agents":[{"pane_id":"w1:p1","agent":"codex","agent_status":"working","cwd":"/repo/app","workspace_id":"w1","terminal_title":"codex","revision":1}]}}}' ;;
  "pane list"*) echo '{"result":{"panes":[{"pane_id":"w1:p1","label":"typist","terminal_id":"term_ty1","cwd":"/repo/app","workspace_id":"w1"}]}}' ;;
  "pane read w1:p1"*) printf '$ ' ;;
  *) echo '{}' ;;
esac`;

// The socket only shows the pane; keys go over HTTP through one queue, so
// what reaches herdr is the text typed, in order, then Enter.
test("typing in a live terminal reaches the pane in order over HTTP", async ({ page, bridge }) => {
  const host = await bridge({ herdr });
  const socketFrames: string[] = [];
  page.on("websocket", (ws) => ws.on("framesent", (frame) => socketFrames.push(String(frame.payload))));

  await openApp(page, { demo: false });
  const token = await loginBridge(page, host.url);
  await pairBridge(page, host.url, token);
  await seedHosts(page, [{
    id: "e2e", label: "E2E", transport: "tailscale", user: "",
    hostname: "127.0.0.1", port: host.port, demo: false, tailnetUrl: host.url,
  }], "e2e");
  await page.getByRole("button", { name: /typist/ }).first().click({ timeout: 20_000 });
  await page.getByRole("button", { name: "Terminal view", exact: true }).click();
  await expect(page.getByRole("status", { name: "Live PTY" })).toBeVisible({ timeout: 20_000 });

  await page.getByRole("application", { name: "Pane w1:p1" }).focus();
  await page.keyboard.type("ls -a");
  await page.keyboard.press("Enter");

  const writes = async () =>
    (await host.calls()).filter((line) => /^pane send-(text|keys) /.test(line));
  await expect.poll(async () => (await writes()).at(-1)).toBe("pane send-keys w1:p1 enter");
  const typed = (await writes())
    .filter((line) => line.startsWith("pane send-text w1:p1 "))
    .map((line) => line.slice("pane send-text w1:p1 ".length))
    .join("");
  expect(typed).toBe("ls -a");
  expect(socketFrames, "nothing is typed over the socket").toEqual([]);
});
