import { chromium } from "playwright";
const b = await chromium.launch();
let failed = false;
const log = (ok, msg) => { console.log(ok ? `ok   ${msg}` : `FAIL ${msg}`); if (!ok) failed = true; };
const json = (r, body, status = 200) => r.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
const p = await ctx.newPage();
// Same origin: no auto-bridge (manual onboarding). Other origins: bridge found,
// except the dead door used for the negative case.
await p.route("**/api/vapid", (r) => {
  const u = new URL(r.request().url());
  if (u.origin === "http://127.0.0.1:8188" || u.hostname === "dead-host.ts.net")
    return r.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  return json(r, { publicKey: "x" });
});
await p.route("**/api/pair", (r) => json(r, { deviceId: "d" }));
await p.route("**/api/snapshot", (r) => json(r, { hostId: "test", herdrRunning: true, agents: [], kinds: [] }));
await p.goto("http://127.0.0.1:8188/");
await p.waitForTimeout(1500);
await p.getByRole("button", { name: "Next", exact: true }).click();
await p.getByRole("button", { name: "Next", exact: true }).click();
await p.getByRole("button", { name: "Open moshpit" }).click();
await p.waitForTimeout(1500);
await p.evaluate(() => {
  const raw = JSON.parse(localStorage.getItem("moshpit-v1"));
  raw.state.hosts = [];
  raw.state.connectedHostId = null;
  localStorage.setItem("moshpit-v1", JSON.stringify(raw));
});
await p.reload({ waitUntil: "networkidle" });
await p.waitForTimeout(1500);
const hostsTab = p.getByRole("button", { name: /hosts/i }).first();
await hostsTab.click();
await p.waitForTimeout(500);
await p.getByRole("button", { name: "Add host" }).click();
await p.getByLabel("Bridge URL").fill("http://box.tail1.ts.net:8802");
await p.getByRole("button", { name: "Save host" }).click();
await p.waitForTimeout(1000);
const saved = p.getByRole("heading", { name: "box" });
await saved.waitFor({ state: "visible", timeout: 8000 }).then(
  () => log(true, "plain-HTTP .ts.net door passes the validator and saves"),
  () => log(false, "plain-HTTP .ts.net door saves"),
);
await p.getByRole("button", { name: "Add host" }).click();
await p.getByLabel("Bridge URL").fill("https://dead-host.ts.net:8802");
await p.getByRole("button", { name: "Save host" }).click();
await p.waitForTimeout(3000);
const noBridge = p.getByText("No moshpit bridge answered");
await noBridge.waitFor({ state: "visible", timeout: 8000 }).then(
  () => log(true, "a dead door is rejected before saving"),
  () => log(false, "dead door rejected before saving"),
);
const notSaved = await p.getByRole("heading", { name: "dead-host" }).count();
log(notSaved === 0, "rejected door does not enter the host list");
await b.close();
process.exit(failed ? 1 : 0);
