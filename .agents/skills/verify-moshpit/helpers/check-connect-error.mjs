import { chromium } from "playwright";
const b = await chromium.launch();
let failed = false;
const log = (ok, msg) => { console.log(ok ? `ok   ${msg}` : `FAIL ${msg}`); if (!ok) failed = true; };
const json = (r, body, status = 200) => r.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function attempt(door, doorBehavior, expectTitle) {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  await p.route(`**${door}**`, (r) => {
    const path = new URL(r.request().url()).pathname;
    if (doorBehavior === "dead") return r.abort();
    if (path === "/api/vapid") return json(r, {}, doorBehavior === "not-bridge" ? 404 : 200);
    return json(r, { error: "down" }, 502);
  });
  await p.goto("http://127.0.0.1:8188/");
  await p.waitForTimeout(1500);
  await p.getByRole("button", { name: "Next", exact: true }).click();
  await p.getByRole("button", { name: "Next", exact: true }).click();
  await p.getByRole("button", { name: "Open moshpit" }).click();
  await p.waitForTimeout(1000);
  await p.evaluate((host) => {
    const raw = JSON.parse(localStorage.getItem("moshpit-v1"));
    raw.state.hosts = [{ id: "t", label: "T", transport: "tailscale", user: "", hostname: "x", port: 80, demo: false, tailnetUrl: host }];
    raw.state.connectedHostId = null;
    localStorage.setItem("moshpit-v1", JSON.stringify(raw));
  }, door);
  await p.reload({ waitUntil: "networkidle" });
  await p.waitForTimeout(1500);
  await p.getByRole("button", { name: /hosts/i }).first().click();
  await p.waitForTimeout(500);
  await p.getByRole("button", { name: "Connect" }).click();
  await p.waitForTimeout(15000);
  const seen = await p.getByText(expectTitle).count();
  log(seen > 0, `${expectTitle} for the ${doorBehavior} door`);
  await ctx.close();
}
await attempt("http://dead-door.ts.net:8802", "dead", "Can’t reach the bridge");
await attempt("http://not-a-bridge.ts.net:8802", "not-bridge", "Not a moshpit bridge");
await attempt("http://bridge-down.ts.net:8802", "live", "Bridge unreachable");
await b.close();
process.exit(failed ? 1 : 0);
