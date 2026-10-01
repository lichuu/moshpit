import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer as createVite } from "vite";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

const vite = await createVite({
  server: { middlewareMode: true },
  appType: "custom",
});
const bridge = await vite.ssrLoadModule("/src/lib/moshpit/bridge.ts");
{
  const start = Date.now();
  globalThis.Notification = { permission: "granted" };
  globalThis.window = { PushManager: function PushManager() {} };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { serviceWorker: { ready: new Promise(() => {}) } },
  });
  const setup = await bridge.registerPush("http://127.0.0.1:9");
  const elapsed = Date.now() - start;
  assert.ok(elapsed <= bridge.BRIDGE_PROBE_MS + 1500, `ready hang ${elapsed}`);
  assert.equal(setup.status, "failed");
  assert.match(setup.message, /service worker not ready/);
  console.log("ok   registerPush bounded ready, timeout is failed not unavailable");
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const href = String(input);
    if (href.includes("/api/vapid")) {
      return new Response(JSON.stringify({ publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error("pair down");
  };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      serviceWorker: {
        ready: Promise.resolve({
          pushManager: {
            subscribe: async () => ({ toJSON: () => ({ endpoint: "https://push.example/x", keys: { p256dh: "p", auth: "a" } }) }),
            getSubscription: async () => ({ toJSON: () => ({ endpoint: "https://push.example/x", keys: { p256dh: "p", auth: "a" } }) }),
          },
        }),
      },
    },
  });
  const failed = await bridge.registerPush("http://127.0.0.1:9");
  assert.equal(failed.status, "failed");
  console.log("ok   registerPush pair failure is failed, not thrown");

  // Two hosts in flight together must not share one result.
  let releaseA;
  const seen = [];
  globalThis.fetch = async (input) => {
    const href = String(input);
    seen.push(href);
    if (href.includes("/api/vapid")) {
      if (href.startsWith("http://127.0.0.1:9/")) await new Promise((r) => (releaseA = r));
      return new Response(JSON.stringify({ publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ deviceId: "d" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const a = bridge.registerPush("http://127.0.0.1:9");
  const b = bridge.registerPush("http://127.0.0.1:10");
  assert.notEqual(a, b, "per-url coalescing");
  assert.equal((await b).status, "on");
  releaseA();
  assert.equal((await a).status, "on");
  assert.ok(
    seen.some((h) => h.startsWith("http://127.0.0.1:10/api/pair")),
    "second host pairs its own bridge",
  );
  globalThis.fetch = origFetch;
  console.log("ok   registerPush coalesces per url, not globally");
}
await vite.close();

const dist = path.join(root, "dist/spa");
const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
};
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  if (pathname.startsWith("/api/")) {
    res.writeHead(404).end();
    return;
  }
  try {
    const file = path.join(dist, pathname === "/" ? "index.html" : pathname);
    res.setHeader("Content-Type", mime[path.extname(file)] ?? "application/octet-stream");
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.addInitScript(() => {
    window.__permCalls = 0;
    const orig = Notification.requestPermission.bind(Notification);
    Notification.requestPermission = async () => {
      window.__permCalls += 1;
      return orig();
    };
  });
  await page.goto(`${origin}/?demo=1`);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("button", { name: "Open moshpit", exact: true }).click();
  const calls = await page.evaluate(() => window.__permCalls);
  assert.equal(calls, 0);
  console.log("ok   no permission prompt on load");
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
