import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const dist = path.join(root, "dist/spa");
const USER = "notify-sub";
const scratch = await mkdtemp(path.join(tmpdir(), "moshpit-notify-sub-"));
const child = spawn(process.execPath, [path.join(root, "bridge/index.mjs")], {
  env: {
    ...process.env,
    MOSHPIT_PORT: "0",
    MOSHPIT_BIND: "127.0.0.1",
    MOSHPIT_STATE_DIR: scratch,
    MOSHPIT_HERDR_BIN: "",
    MOSHPIT_TRUSTED_USER: USER,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
await once(child.stdout, "data");
const sockets = execFileSync("ss", ["-ltnp"], { encoding: "utf8" });
const bport = sockets
  .split("\n")
  .find((row) => row.includes(`pid=${child.pid},`))
  ?.match(/127\.0\.0\.1:(\d+)/)?.[1];
assert.ok(bport);
const bridgeOrigin = `http://127.0.0.1:${bport}`;
const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
};
const spa = createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://127.0.0.1").pathname;
  try {
    const file = path.join(dist, pathname === "/" ? "index.html" : pathname);
    res.setHeader("Content-Type", mime[path.extname(file)] ?? "application/octet-stream");
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => spa.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${spa.address().port}`;
const pairs = [];
const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const attachApi = () => page.route("**/api/**", async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const body = req.postData() ?? undefined;
    if (u.pathname === "/api/pair" && body) {
      try {
        pairs.push(JSON.parse(body));
      } catch {
        /* ignore */
      }
    }
    const r = await fetch(`${bridgeOrigin}${u.pathname}${u.search}`, {
      method: req.method(),
      headers: {
        "content-type": "application/json",
        "tailscale-user-login": USER,
      },
      body: req.method() === "GET" || req.method() === "HEAD" ? undefined : body,
    });
    await route.fulfill({
      status: r.status,
      headers: { "content-type": r.headers.get("content-type") ?? "application/json" },
      body: Buffer.from(await r.arrayBuffer()),
    });
  });
  await page.addInitScript(() => {
    const sub = {
      endpoint: "https://push.example/play",
      toJSON() {
        return { endpoint: "https://push.example/play", keys: { p256dh: "p", auth: "a" } };
      },
    };
    const registration = {
      pushManager: {
        subscribe: async () => sub,
        getSubscription: async () => ({
          ...sub,
          unsubscribe: async () => {
            if (window.__failUnsubscribe) throw new Error("unsubscribe refused");
            return true;
          },
        }),
      },
    };
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        register: async () => registration,
        ready: Promise.resolve(registration),
        getRegistration: async () => registration,
      },
    });
    Notification.requestPermission = async () => "granted";
    Object.defineProperty(Notification, "permission", {
      configurable: true,
      get: () => "granted",
    });
  });
  await page.goto(`${origin}/?demo=1`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("button", { name: "Open moshpit", exact: true }).click();
  await page.locator('nav[aria-label="Primary"] > button').nth(2).click();
  await attachApi();
  await page.getByRole("button", { name: "Add host" }).click();
  await page.getByPlaceholder("My Mac mini").fill("push-host");
  await page.getByPlaceholder("https://my-machine.tailnet.ts.net").fill(origin);
  await page.getByRole("button", { name: "Save host" }).click();
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByText("Attached to push-host").waitFor({ timeout: 8000 });
  // Off paints optimistically, so the bridge write lands after the label.
  const waitForClearedPush = async () => {
    for (let i = 0; i < 80; i += 1) {
      const list = JSON.parse(await readFile(path.join(scratch, "devices.json"), "utf8"));
      if ((list[0]?.pushSubscription ?? null) === null) return;
      await page.waitForTimeout(100);
    }
    throw new Error("bridge kept a live endpoint after clearPush");
  };
  const notifyName = "Notify when an agent blocks";
  // pending is checked but disabled, so settling matters: a bare checked poll
  // would race ahead of the registration it is meant to be waiting for.
  const waitChecked = async (loc, want) => {
    for (let i = 0; i < 80; i += 1) {
      if ((await loc.isChecked()) === want && !(await loc.isDisabled())) return;
      await page.waitForTimeout(100);
    }
    throw new Error(`notify checkbox never settled at ${want}`);
  };
  const toggle = page.getByRole("checkbox", { name: notifyName });
  await toggle.click();
  await waitChecked(toggle, true);
  const setPairs = pairs.filter((p) => p.pushSubscription?.endpoint);
  assert.equal(setPairs.length, 1, JSON.stringify(pairs));
  const deviceId = setPairs[0].deviceId;
  await toggle.click();
  await waitChecked(toggle, false);
  assert.ok(pairs.some((p) => p.clearPush === true), JSON.stringify(pairs));
  await waitForClearedPush();
  await toggle.click();
  await waitChecked(toggle, true);
  const sets = pairs.filter((p) => p.pushSubscription?.endpoint);
  assert.ok(sets.length >= 2);
  assert.equal(sets.at(-1).deviceId, deviceId);
  const beforeReload = pairs.filter((p) => p.clearPush === true).length;
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator('nav[aria-label="Primary"] > button').nth(2).click();
  const afterReload = page.getByRole("checkbox", { name: notifyName });
  await waitChecked(afterReload, true);
  await afterReload.click();
  await waitChecked(afterReload, false);
  const afterReloadClears = pairs.filter((p) => p.clearPush === true).length;
  assert.equal(afterReloadClears, beforeReload + 1, JSON.stringify(pairs));
  console.log("ok   grant set, disable clearPush, re-enable same deviceId");

  // A local unsubscribe that fails must not strand a live endpoint on the
  // bridge: clearPush goes first, so delivery stops either way.
  await afterReload.click();
  await waitChecked(afterReload, true);
  await page.evaluate(() => {
    window.__failUnsubscribe = true;
  });
  const beforeFail = pairs.filter((p) => p.clearPush === true).length;
  await afterReload.click();
  await waitChecked(afterReload, false);
  assert.equal(
    pairs.filter((p) => p.clearPush === true).length,
    beforeFail + 1,
    JSON.stringify(pairs),
  );
  await waitForClearedPush();
  console.log("ok   failed local unsubscribe still clears the bridge");
} finally {
  await browser.close();
  child.kill("SIGTERM");
  await once(child, "exit").catch(() => undefined);
  await new Promise((r) => spa.close(r));
  await rm(scratch, { recursive: true, force: true });
}
