// Focus-under-load: seed a connected real-host state that streams a busy
// pane, then check that focusing the raw input (and typing) does not
// starve the main thread. This exercises the WS client path, which the
// demo host never reaches.
// usage: node check-raw-input-stream.mjs
import { createServer } from "node:http";
import crypto from "node:crypto";
import { chromium } from "playwright";

const PORT = 8851;

function sendFrame(socket, payload) {
  const p = Buffer.from(payload);
  const len = p.length;
  const header = Buffer.alloc(2);
  header[0] = 0x81;
  let extra;
  if (len < 126) {
    header[1] = len;
    extra = [];
  } else if (len < 65536) {
    header[1] = 126;
    extra = [Buffer.from([len >> 8, len & 0xff])];
  } else {
    const big = Buffer.alloc(8);
    big.writeBigUInt64BE(BigInt(len));
    header[1] = 127;
    extra = [big];
  }
  socket.write(Buffer.concat([header, ...extra, p]));
}

const agent = {
  id: "migrate",
  name: "migrate",
  kind: "pi",
  sessionId: "w1:p2",
  status: "working",
  workspace: "w",
  tab: "t",
  paneId: "w1:p2",
  cwd: ".",
  branch: "main",
  lastOutput: "running",
  lines: [],
  attention: false,
  statusChangedAt: 0,
  workTicks: 0,
  ticks: 0,
  nextStatus: null,
  blockedPrompt: null,
};

const sockets = new Set();
const srv = createServer((req, res) => {
  if (req.url?.startsWith("/api/snapshot")) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(
      JSON.stringify({
        hostId: "stream",
        at: Date.now(),
        agents: [agent],
        panes: [{ id: "w1:p2", agentId: "migrate" }],
      }),
    );
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
});
srv.on("upgrade", (req, socket) => {
  socket.on("error", () => {});
  const key = req.headers["sec-websocket-key"];
  const accept = crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  sockets.add(socket);
  // Busy pane: 40 rows x ~196 styled cols, one row changing every 100ms.
  const rows = Array.from({ length: 40 }, (_, r) =>
    `\x1b[7m\x1b[1m ${String(r).padStart(4)} | ${"#".repeat(180)} \x1b[0m`,
  );
  sendFrame(socket, JSON.stringify({ dump: rows.join("\n") }));
  let tick = 0;
  const iv = setInterval(() => {
    if (socket.destroyed) return clearInterval(iv);
    tick++;
    const text = `\x1b[7m${String(tick).padStart(4)} tick ${"=".repeat(180)}\x1b[0m`;
    sendFrame(socket, JSON.stringify({ lines: [[tick % 40, text]] }));
  }, 100);
  socket.on("close", () => sockets.delete(socket));
});
srv.on("clientError", (err, socket) => {
  if (err.code !== "ERR_HTTP_INVALID_METHOD") socket.destroy();
});
await new Promise((r) => srv.listen(PORT, "127.0.0.1", r));

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
const p = await ctx.newPage();

await p.addInitScript((port) => {
  // Lag probes.
  const t0 = performance.now();
  let expected = 0;
  window.setInterval(() => {
    expected += 250;
    const drift = expected - (performance.now() - t0);
    if (drift > 200) console.log(`HANGPROBE:tick ${Math.round(drift)}ms`);
  }, 250);
  let last = performance.now();
  (function raf() {
    const now = performance.now();
    if (now - last > 400) console.log(`HANGPROBE:raf ${Math.round(now - last)}ms`);
    last = now;
    requestAnimationFrame(raf);
  })();
  window.addEventListener("longanimationframe", (e) =>
    console.log(`HANGPROBE:laf ${Math.round(e.duration)}ms`),
  );
  // Seed the persisted store: connected real host, paired, herdr running.
  try {
    const host = {
      id: "stream",
      label: "stream",
      transport: "tailscale",
      user: "x",
      hostname: "127.0.0.1",
      port: port,
      demo: false,
      tailnetUrl: `http://127.0.0.1:${port}`,
    };
    const existing = JSON.parse(localStorage.getItem("moshpit-v1") ?? "{}");
    const state = {
      ...(existing.state ?? {}),
      onboarded: true,
      hydrated: true,
      tab: "moshpit",
      hosts: [host],
      connectedHostId: "stream",
      connecting: false,
      connectError: null,
      herdrRunning: true,
      demoFailure: null,
      agents: [
        {
          id: "migrate",
          name: "migrate",
          kind: "pi",
          sessionId: "w1:p2",
          status: "working",
          workspace: "w",
          tab: "t",
          paneId: "w1:p2",
          cwd: ".",
          branch: "main",
          lastOutput: "running",
          lines: [],
          attention: false,
          statusChangedAt: 0,
          workTicks: 0,
          ticks: 0,
          nextStatus: null,
          blockedPrompt: null,
        },
      ],
      events: [],
      selectedAgentId: null,
      focusedPaneId: "w1:p2",
      jumpOpen: false,
      bridgeDeviceId: "test-device",
    };
    localStorage.setItem(
      "moshpit-v1",
      JSON.stringify({ version: existing.version ?? 0, state }),
    );
  } catch {
    /* first paint: app writes its own state */
  }
}, PORT);

const lags = [];
p.on("console", (m) => {
  if (m.text().startsWith("HANGPROBE:")) lags.push(m.text());
});

await p.goto(`http://127.0.0.1:8188/`, { waitUntil: "networkidle" });
await p.getByText("migrate", { exact: true }).first().click();
await p.getByRole("button", { name: "Terminal view" }).click();
const input = p.getByPlaceholder("Type or dictate terminal input");
await input.waitFor({ timeout: 15000 });
await p.waitForTimeout(5000); // streaming settles
const preFocus = lags.length;
console.log(`info baseline lags=${preFocus}`);
if (preFocus > 0) {
  console.log("FAIL streaming baseline already laggy (before focus)");
  console.log(lags.join("\n"));
  await b.close();
  srv.close();
  process.exit(1);
}

// Focus + type: the reported trigger.
await input.click();
await p.keyboard.type("hello from the phone");
await p.waitForTimeout(15000);
const focusLags = lags.slice(preFocus);
console.log(
  focusLags.length ? focusLags.join("\n") : "ok   no long tasks while focused",
);
// Send through the WS path and watch the post-send repaint.
await p.getByRole("button", { name: "Send" }).click();
await p.waitForTimeout(3000);
const sendLags = lags.slice(preFocus);
console.log(
  sendLags.length === focusLags.length
    ? "ok   no long tasks after send"
    : sendLags.slice(focusLags.length).join("\n") || "ok   no new long tasks after send",
);
const ok = lags.length === 0;
console.log(ok ? "PASS streaming + focus is smooth" : "FAIL hang under focus");
await b.close();
srv.close();
process.exit(ok ? 0 : 1);
