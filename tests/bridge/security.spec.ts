import { createServer } from "node:http";
import { test, expect, loginBridge, pairBridge } from "../fixtures";

test("browser origin boundary protects fetch and terminal upgrades", async ({ page, bridge }) => {
  const host = await bridge({
    herdr: `
case "$*" in
  "pane list"*) echo '{"result":{"panes":[{"pane_id":"w1:p1","label":"pane-a","terminal_id":"term_ab12","cwd":"/repo","workspace_id":"w1"}]}}' ;;
  *) echo '{}' ;;
esac`,
  });
  await page.goto("/");
  const token = await loginBridge(page, host.url);
  const device = await pairBridge(page, host.url, token);
  const allowed = await page.evaluate(async ({ url, token, device }) => {
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", "x-moshpit-device": `${device.deviceId}.${device.deviceSecret}` };
    const snapshot = await fetch(`${url}/api/snapshot`, { headers });
    return snapshot.status;
  }, { url: host.url, token, device });
  expect(allowed).toBe(200);

  const sameOriginPage = await page.goto(host.url);
  expect(sameOriginPage?.ok(), `isolated bridge SPA answered ${sameOriginPage?.status()}`).toBeTruthy();
  const sameOrigin = await page.evaluate(async () => {
    const vapid = await fetch("/api/vapid");
    const action = await fetch("/api/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "close", target: "pane-a" }),
    });
    return { vapid: vapid.status, action: action.status, actionBody: await action.json().catch(() => null) };
  });
  expect(sameOrigin.vapid).not.toBe(403);
  expect([401, 403]).toContain(sameOrigin.action);
  expect(JSON.stringify(sameOrigin.actionBody ?? {})).not.toMatch(/ok":true/);

  const terminal = () => page.evaluate(async ({ url, token, device }) => {
    let ticket: string | null = null;
    try {
      const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", "x-moshpit-device": `${device.deviceId}.${device.deviceSecret}` };
      const res = await fetch(`${url}/api/terminal-ticket`, { method: "POST", headers, body: JSON.stringify({ target: "pane-a" }) });
      if (res.ok) ticket = (await res.json() as { ticket: string }).ticket;
    } catch {
      /* a hostile origin's fetch is refused by CORS, not answered */
    }
    if (!ticket) return "denied";
    return await new Promise<string>((resolve) => {
      const ws = new WebSocket(`${url.replace("http:", "ws:")}/pty?ticket=${ticket}`);
      const timer = setTimeout(() => { ws.close(); resolve("timeout"); }, 5000);
      ws.onopen = () => { clearTimeout(timer); ws.close(); resolve("open"); };
      ws.onerror = () => { clearTimeout(timer); resolve("denied"); };
    });
  }, { url: host.url, token, device });
  expect(await terminal()).toBe("open");

  // A real second page origin, not a forged Origin header or a routed response.
  const hostile = createServer((_req, res) => res.end("<!doctype html><title>Hostile fixture</title>"));
  await new Promise<void>((resolve) => hostile.listen(0, "127.0.0.1", resolve));
  try {
    const address = hostile.address();
    if (!address || typeof address === "string") throw new Error("no hostile port");
    const origin = `http://127.0.0.1:${address.port}`;
    await page.goto(origin);
    const rejected = await page.evaluate(async ({ url, token, device }) => {
      try {
        await fetch(`${url}/api/action`, {
          method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-moshpit-device": `${device.deviceId}.${device.deviceSecret}` },
          body: JSON.stringify({ kind: "close", target: "pane-a" }),
        });
        return false;
      } catch { return true; }
    }, { url: host.url, token, device });
    expect(rejected).toBe(true);
    // The fetch alone has to reach the server: asserting this before the
    // upgrade keeps a browser local-network block from passing as a rejection.
    await expect.poll(() => host.stderr()).toContain(`moshpit refused "${origin}"`);
    expect(await terminal()).toBe("denied");
    expect((await host.calls()).filter((call) => /^(pane (close|send-text|send-keys)|agent send)/.test(call))).toEqual([]);
  } finally {
    await new Promise<void>((resolve, reject) => hostile.close((error) => error ? reject(error) : resolve()));
  }
});
