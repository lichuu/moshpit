// Live-bridge repro: does focusing the raw input field freeze the app?
// Spawns an isolated bridge, adds it as a real host, opens the terminal,
// focuses the raw input, and watches main-thread lag + /pty socket churn.
// usage: node check-raw-input-bridge.mjs [screenshot-dir]
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";

import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const state = await mkdtemp(path.join(tmpdir(), "moshpit-focus-"));
import net from "node:net";

// First free port in the scratch range; a failed run must not wedge the next.
const port = await new Promise((resolve, reject) => {
  const tryPort = (n) => {
    if (n > 8819) return reject(new Error("no free port"));
    const s = net.createServer();
    s.once("error", () => {
      s.close();
      tryPort(n + 1);
    });
    s.once("listening", () => {
      s.close(() => resolve(n));
    });
    s.listen(n, "127.0.0.1");
  };
  tryPort(8791);
});
const child = spawn(process.execPath, [path.join(root, "bridge/index.mjs")], {
  env: {
    ...process.env,
    MOSHPIT_PORT: String(port),
    MOSHPIT_TRUSTED_USER: "you",
    MOSHPIT_STATE_DIR: state,
    MOSHPIT_BIND: "127.0.0.1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stderr.on("data", (buf) => console.log("bridge:", String(buf).trim()));
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("bridge did not start")), 4000);
  child.stdout.on("data", (buf) => {
    if (String(buf).includes("moshpit-bridge")) {
      clearTimeout(t);
      resolve();
    }
  });
  child.on("exit", (code) => reject(new Error(`bridge exited ${code}`)));
});

process.on("exit", () => child.kill());

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
// Tailscale Serve injects the trusted-user header in production; do it here.
await ctx.route("**/*", (route) => {
  const headers = { ...route.request().headers() };
  if (String(route.request().url()).includes(`:${port}`))
    headers["tailscale-user-login"] = "you";
  return route.continue({ headers });
});
const p = await ctx.newPage();

// Main-thread lag probes.
await p.addInitScript(() => {
  const t0 = performance.now();
  let expected = 0;
  window.__ticks = 0;
  window.setInterval(() => {
    expected += 250;
    window.__ticks++;
    const drift = expected - (performance.now() - t0);
    if (drift > 200) console.log(`HANGPROBE:tick ${Math.round(drift)}ms`);
  }, 250);
  let last = performance.now();
  function raf() {
    const now = performance.now();
    if (now - last > 400) console.log(`HANGPROBE:raf ${Math.round(now - last)}ms`);
    last = now;
    requestAnimationFrame(raf);
  }
  requestAnimationFrame(raf);
  window.addEventListener("longanimationframe", (e) =>
    console.log(`HANGPROBE:laf ${Math.round(e.duration)}ms`),
  );
  // Count /pty WebSocket lifecycle directly.
  window.__ws = { open: 0, close: 0, live: 0 };
  const WS = globalThis.WebSocket;
  globalThis.WebSocket = class extends WS {
    constructor(...args) {
      super(...args);
      if (String(args[0]).includes("/pty")) window.__ws.open++;
      this.addEventListener("open", () => {
        if (String(args[0]).includes("/pty")) window.__ws.live++;
      });
      this.addEventListener("close", () => {
        if (String(args[0]).includes("/pty")) window.__ws.close++;
      });
    }
  };
});

// /pty socket churn.
let wsOpens = 0;
let wsCloses = 0;
const cdp = await ctx.newCDPSession(p);
await cdp.send("Network.enable");
cdp.on("Network.webSocketCreated", (e) => {
  if (String(e.url).includes("/pty")) wsOpens++;
});
cdp.on("Network.webSocketClosed", (e) => {
  if (String(e.url).includes("/pty")) wsCloses++;
});

const lags = [];
p.on("console", (m) => {
  if (m.text().startsWith("HANGPROBE:")) lags.push(m.text());
});

await p.goto(`http://127.0.0.1:8188/?demo=1`, { waitUntil: "networkidle" });
for (let i = 0; i < 2; i++)
  await p.getByRole("button", { name: "Next", exact: true }).click();
await p.getByRole("button", { name: "Open moshpit" }).click();

// Add the live bridge as a real host.
await p.locator('nav[aria-label="Primary"] > button').nth(2).click();
await p.getByRole("button", { name: "Add host" }).click();
const name = p.getByPlaceholder("My Mac mini");
await name.fill("focus-check");
const url = p.getByRole("textbox", { name: /Bridge URL/i });
await url.fill(`http://127.0.0.1:${port}`);
await p.getByRole("button", { name: "Save" }).click();
await p.getByRole("button", { name: "Connect", exact: true }).click();
await p.locator('nav[aria-label="Primary"] > button').nth(0).click(); // moshpit
await p.getByText("migrate", { exact: true }).first().click();
await p.getByRole("button", { name: "Terminal view" }).click();
const input = p.getByPlaceholder("Type or dictate terminal input");
await input.waitFor({ timeout: 15000 });
console.log("ok   live bridge host connected, terminal open");
await p.waitForTimeout(3000); // let the first dump paint
const ws0 = await p.evaluate(() => window.__ws);
console.log(`info pty ws after connect: ${JSON.stringify(ws0)}`);
const st = await p
  .evaluate(() => {
    try {
      const raw = localStorage.getItem("moshpit-v1");
      const s = JSON.parse(raw);
      return {
        deviceId: s?.state?.bridgeDeviceId ?? null,
        connected: s?.state?.connectedHostId ?? null,
        herdrRunning: s?.state?.herdrRunning ?? null,
      };
    } catch {
      return {};
    }
  })
  .catch(() => ({}));
console.log(`info store: ${JSON.stringify(st)}`);

// Baseline lag while unfocused.
await p.waitForTimeout(3000);

await input.click();
const focused = await p
  .locator('textarea[placeholder="Type or dictate terminal input"]')
  .evaluate((el) => document.activeElement === el);
console.log(focused ? "ok   raw input focused" : "FAIL focus did not land");
if (focused) await p.keyboard.type("hello");
await p.waitForTimeout(15000);

// Blur: tap the pane, let the reconnect + full-dump paint happen.
await p.getByText("esc", { exact: true }).first().click().catch(() => {});
await p.waitForTimeout(4000);

console.log(
  `info pty sockets: opens=${wsOpens} closes=${wsCloses} in-page=${JSON.stringify(await p.evaluate(() => window.__ws))}`,
);
console.log(
  `info ticks=${await p.evaluate(() => window.__ticks)} (expect ~60 over ~33s)`,
);
console.log(lags.length ? lags.join("\n") : "ok   no long tasks");
const ok = focused && lags.length === 0;
console.log(ok ? "PASS no hang on live bridge host" : "FAIL");
await b.close();
process.exit(ok ? 0 : 1);
