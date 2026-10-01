import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "playwright";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const dist = path.join(root, "dist/spa");
const out = path.resolve(
  process.argv[2] ?? path.join(root, "screenshots/pwa-redesign"),
);
await mkdir(out, { recursive: true });
const worker = await readFile(path.join(dist, "sw.js"), "utf8");
assert.ok(!worker.includes("__BUILD_ID__"), "Build the production PWA first");
const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};
let deployment = "current";
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  if (pathname.startsWith("/api/") || pathname === "/missing-build-asset.js") {
    response.writeHead(404);
    response.end();
    return;
  }
  if (pathname === "/sw.js") {
    let source = worker;
    if (deployment !== "current")
      source = source.replace(
        /moshpit-([a-f0-9]+)/,
        `moshpit-${deployment}-$1`,
      );
    if (deployment === "broken")
      source = source.replace(
        "const PRECACHE = [",
        'const PRECACHE = ["/missing-build-asset.js",',
      );
    response.writeHead(200, {
      "content-type": "text/javascript",
      "cache-control": "no-store",
    });
    response.end(source);
    return;
  }
  const filename = path.resolve(
    dist,
    `.${pathname === "/" ? "/index.html" : pathname}`,
  );
  if (!filename.startsWith(`${dist}${path.sep}`)) {
    response.writeHead(403);
    response.end();
    return;
  }
  try {
    const contents = await readFile(filename);
    response.writeHead(200, {
      "content-type":
        mime[path.extname(filename)] ?? "application/octet-stream",
    });
    response.end(contents);
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address !== "string");
const origin = `http://127.0.0.1:${address.port}`;
const nav = (page) => page.locator('nav[aria-label="Primary"] > button');
const sizes = [
  [360, 780],
  [390, 844],
  [440, 956],
  [844, 390],
  [768, 1024],
  [1024, 768],
  [1440, 900],
  [1920, 1080],
];

async function enter(page, search = "?demo=1") {
  await page.goto(`${origin}/${search}`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Skip", exact: true }).click();
  await nav(page).first().waitFor();
}

async function fits(page, locator, label) {
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  assert.ok(box && box.width > 0 && box.height > 0, `${label} is visible`);
  assert.ok(
    box.x >= -1 && box.x + box.width <= viewport.width + 1,
    `${label} fits horizontally`,
  );
  assert.ok(
    box.y >= -1 && box.y + box.height <= viewport.height + 1,
    `${label} fits vertically: ${JSON.stringify(box)} in ${viewport.height}px`,
  );
}

try {
  for (const [name, engine] of Object.entries(
    process.env.MOSHPIT_PWA_ONLY ? {} : { chromium, firefox, webkit },
  )) {
    const webkitLibs = process.env.MOSHPIT_WEBKIT_LIBS;
    const webkitDir = path.join(
      path.dirname(webkit.executablePath()),
      "minibrowser-wpe",
    );
    const browser = await engine.launch(
      name === "webkit" && webkitLibs
        ? {
            executablePath: path.join(webkitDir, "bin/MiniBrowser"),
            env: {
              ...process.env,
              LD_LIBRARY_PATH: `${webkitDir}/lib:${webkitDir}/sys/lib:${webkitLibs}`,
              WEBKIT_EXEC_PATH: `${webkitDir}/bin`,
              WEBKIT_INJECTED_BUNDLE_PATH: `${webkitDir}/lib`,
              WEBKIT_INSPECTOR_RESOURCES_PATH: `${webkitDir}/share`,
            },
          }
        : {},
    );
    try {
      for (const [width, height] of sizes) {
        const context = await browser.newContext({
          viewport: { width, height },
          // Keep the fictional-host route interceptable; lifecycle checks below use service workers.
          serviceWorkers: "block",
          colorScheme: "light",
          reducedMotion: "reduce",
        });
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await enter(page);
        if (width === 440) {
          const frame = page.locator(".app-viewport");
          const normal = await frame.boundingBox();
          assert.ok(normal);
          // Replay WebKit's shortened, offset visual viewport without a keyboard.
          await page.evaluate(() => {
            Object.defineProperty(visualViewport, "height", {
              configurable: true,
              value: 894,
            });
            Object.defineProperty(visualViewport, "offsetTop", {
              configurable: true,
              value: 62,
            });
            visualViewport.dispatchEvent(new Event("resize"));
          });
          await page.waitForTimeout(50);
          const resting = await frame.boundingBox();
          assert.equal(
            resting.y,
            normal.y,
            "Resting app does not inherit the visual viewport offset",
          );
          assert.equal(
            resting.height,
            normal.height,
            "Resting app fills the CSS viewport",
          );
          await page.evaluate(() => {
            delete visualViewport.height;
            delete visualViewport.offsetTop;
            visualViewport.dispatchEvent(new Event("resize"));
          });
        }

        await fits(
          page,
          page.locator('nav[aria-label="Primary"]'),
          `${name} ${width} navigation`,
        );
        if (width === 768) {
          const list = await page.locator(".agent-list").boundingBox();
          assert.ok(list.width >= 700, "Tablet uses the available screen");
        }
        if (name === "chromium" && [390, 1440].includes(width))
          await page.screenshot({
            path: path.join(
              out,
              `${width === 390 ? "phone" : "desktop"}-agents.png`,
            ),
          });
        await page.getByRole("button", { name: /^migrate/ }).click();
        if (width === 440) {
          const input = page.getByRole("textbox", { name: "Message agent" });
          await input.focus();
          await page.evaluate(() => {
            Object.defineProperty(visualViewport, "height", {
              configurable: true,
              value: 420,
            });
            Object.defineProperty(visualViewport, "offsetTop", {
              configurable: true,
              value: 96,
            });
            visualViewport.dispatchEvent(new Event("resize"));
          });
          const keyboardFrame = await page
            .locator(".app-viewport")
            .boundingBox();
          assert.equal(keyboardFrame.y, 96);
          assert.equal(keyboardFrame.height, 420);
          const composer = await input.boundingBox();
          assert.ok(composer.y >= 96 && composer.y + composer.height <= 516);
          assert.equal(await page.locator(".workspace-nav").isVisible(), false);
          await page.evaluate(() => {
            delete visualViewport.height;
            delete visualViewport.offsetTop;
            window.dispatchEvent(new Event("pageshow"));
          });
          await input.blur();
          assert.equal(
            (await page.locator(".app-viewport").boundingBox()).height,
            height,
          );
          assert.equal(await page.locator(".workspace-nav").isVisible(), true);
          if (name === "chromium") {
            const cdp = await context.newCDPSession(page);
            await cdp.send("Emulation.setSafeAreaInsetsOverride", {
              insets: { top: 62, bottom: 34, left: 0, right: 0 },
            });
            await context.setOffline(true);
            const banner = page
              .getByRole("status")
              .filter({ hasText: "You're offline" });
            await banner.waitFor();
            const box = await banner.boundingBox();
            assert.ok(
              box.y >= 62,
              "Status and update banners clear the iOS status bar",
            );
            assert.equal(
              await page
                .locator('[aria-label="Agent detail"] header')
                .evaluate((el) => getComputedStyle(el).paddingTop),
              "16px",
              "Header does not apply a second safe-area inset",
            );
            await page.screenshot({
              path: path.join(out, "iphone-safe-area.png"),
            });
            await context.setOffline(false);
            await cdp.send("Emulation.setSafeAreaInsetsOverride", {
              insets: { top: 0, bottom: 0, left: 0, right: 0 },
            });
            await cdp.detach();
          }
        }

        await fits(
          page,
          page.getByRole("button", { name: "Send", exact: true }),
          `${name} ${width} send`,
        );
        await fits(
          page,
          page.getByRole("textbox", { name: "Message agent" }),
          `${name} ${width} composer`,
        );
        await page
          .locator('input[type="file"]')
          .setInputFiles(
            new URL("./fixtures/tiny.png", import.meta.url).pathname,
          );
        await page
          .getByRole("img", {
            name: "Attachment preview: tiny.png",
            exact: true,
          })
          .waitFor();
        await fits(
          page,
          page.getByRole("button", { name: "Send", exact: true }),
          `${name} ${width} image send`,
        );
        await page
          .getByRole("button", { name: "Remove image", exact: true })
          .click();
        if (width === 390) {
          await page.getByRole("textbox", { name: "Message agent" }).fill("y");
          await page.getByRole("button", { name: "Send", exact: true }).click();
          const replyControls = page.getByRole("group", { name: "Blocked reply controls" });
          await replyControls.waitFor();
          assert.equal(await page.getByText("running prisma migrate deploy").count(), 0, "Send inserts without submitting");
          await replyControls.getByRole("button", { name: "Enter", exact: true }).click();
          await page
            .locator('[data-role="agent"]')
            .filter({ hasText: "running prisma migrate deploy" })
            .waitFor();
          await page.setViewportSize({ width, height: 480 });
          await page.waitForFunction(
            () => document.querySelector(".app-viewport").clientHeight <= 480,
          );
          await fits(
            page,
            page.getByRole("button", { name: "Send", exact: true }),
            `${name} reduced-height composer`,
          );
          await page.setViewportSize({ width, height });
          await page.waitForFunction(
            () => document.querySelector(".app-viewport").clientHeight > 480,
          );
          if (name === "chromium")
            await page.screenshot({ path: path.join(out, "phone-chat.png") });
        }
        await page
          .getByRole("button", { name: "Terminal view", exact: true })
          .click();
        await page.getByRole("application", { name: /^Pane / }).waitFor();
        await fits(
          page,
          page.getByRole("textbox", { name: "Terminal input", exact: true }),
          `${name} ${width} terminal input`,
        );
        await page
          .getByRole("button", { name: "Chat view", exact: true })
          .click();
        await nav(page).nth(2).click();
        await page.route("https://my-machine.tailnet.ts.net/**", (route) => {
          const request = route.request();
          const authInfo = new URL(request.url()).pathname === "/api/auth-info";
          const probe = request.method() === "GET" && authInfo;
          const preflight = request.method() === "OPTIONS" && authInfo;
          return route.fulfill({
            status: preflight ? 204 : probe ? 200 : 404,
            headers: {
              "access-control-allow-origin": origin,
              "access-control-allow-methods": "GET, OPTIONS",
              "access-control-allow-headers": request.headers()["access-control-request-headers"] ?? "content-type",
              "access-control-allow-credentials": "true",
            },
            ...(preflight ? {} : { json: probe ? { protocol: 2, requiredFactors: [] } : { error: "Unexpected fixture request" } }),
          });
        });
        await page
          .getByRole("button", { name: "Add host", exact: true })
          .click();
        const dialog = page.getByRole("dialog");
        await dialog
          .getByLabel("Bridge URL", { exact: true })
          .fill("https://my-machine.tailnet.ts.net");
        await dialog
          .getByLabel("Host name", { exact: false })
          .fill("Test workstation");
        await dialog
          .getByRole("button", { name: "Save host", exact: true })
          .click();
        await page
          .getByRole("heading", { name: "Test workstation", exact: true })
          .waitFor();
        await page.reload({ waitUntil: "networkidle" });
        await nav(page).nth(2).click();
        await page
          .getByRole("heading", { name: "Test workstation", exact: true })
          .waitFor();
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          true,
          "No page overflow",
        );
        assert.deepEqual(errors, [], `${name} ${width} has no browser errors`);
        await context.close();
        console.log(
          `ok   ${name} ${width}×${height}: navigation, chat, terminal, host setup, persistence`,
        );
      }
    } finally {
      await browser.close();
    }
  }

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      colorScheme: "dark",
    });
    const page = await context.newPage();
    await page.goto(`${origin}/?demo=1`, { waitUntil: "networkidle" });
    await page.screenshot({ path: path.join(out, "onboarding-dark.png") });
    await page.getByRole("button", { name: "Skip", exact: true }).click();
    await nav(page).first().waitFor();
    await page.screenshot({ path: path.join(out, "desktop-dark.png") });
    await nav(page).nth(2).click();
    await page
      .getByLabel("Appearance", { exact: true })
      .selectOption("catppuccin");
    await page.reload({ waitUntil: "networkidle" });
    assert.equal(
      await page.locator("html").getAttribute("data-theme"),
      "catppuccin",
      "Existing herdr palettes persist",
    );
    console.log("ok   dark appearance and persisted herdr theme");
    await context.close();

    const offline = await browser.newContext({
      viewport: { width: 390, height: 844 },
      colorScheme: "light",
    });
    const app = await offline.newPage();
    const network = await offline.newCDPSession(app);
    const networkState = (value) =>
      network.send("Network.overrideNetworkState", {
        offline: value,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      });
    app.on("pageerror", (error) =>
      console.error("PWA browser error:", error.message),
    );
    await enter(app, "");
    await app
      .getByRole("button", { name: "Connect a host", exact: true })
      .waitFor();
    assert.equal(
      await app.getByText("migrate", { exact: true }).count(),
      0,
      "Real startup never seeds fake agents",
    );
    await app.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await app.waitForFunction(
      () => navigator.serviceWorker.controller !== null,
    );
    const manifest = await app.evaluate(async () =>
      (await fetch("/manifest.webmanifest")).json(),
    );
    assert.equal(manifest.display, "standalone");
    assert.ok(manifest.icons.some((icon) => icon.purpose === "maskable"));
    const cacheBefore = await app.evaluate(() => caches.keys());
    assert.equal(cacheBefore.length, 1);
    const cached = await app.evaluate(async () =>
      (await (await caches.open((await caches.keys())[0])).keys()).map(
        (request) => new URL(request.url).pathname,
      ),
    );
    assert.ok(
      cached.includes("/index.html") &&
        cached.includes("/apple-touch-icon.png"),
    );
    assert.ok(
      cached.some((url) => url.endsWith(".woff2")),
      "Fonts are available offline",
    );
    assert.ok(
      !cached.some((url) => url.startsWith("/api/")),
      "No live API data in shell cache",
    );
    await offline.setOffline(true);
    await app.reload({ waitUntil: "domcontentloaded" });
    // Chromium's navigator state needs separate emulation after navigation:
    // https://github.com/microsoft/playwright/issues/42174
    await networkState(true);
    assert.equal(
      await app.evaluate(() =>
        fetch("/api/snapshot").then(
          () => false,
          () => true,
        ),
      ),
      true,
      "Network requests fail offline",
    );
    await app
      .getByText("You're offline. Reconnect to reach your agents.", {
        exact: true,
      })
      .waitFor();
    await nav(app).nth(2).click();
    await app.getByText("Make yourself at home", { exact: true }).waitFor();
    await app.screenshot({ path: path.join(out, "offline-phone.png") });
    console.log(
      "ok   production offline reload, navigation, local fonts, icons, and honest empty state",
    );
    await offline.setOffline(false);
    await networkState(false);
    await app.reload({ waitUntil: "networkidle" });

    deployment = "broken";
    const failedUpdate = await app.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      const result = new Promise((resolve) =>
        registration.addEventListener(
          "updatefound",
          () => {
            const candidate = registration.installing;
            candidate.addEventListener("statechange", () => {
              if (candidate.state === "redundant") resolve(true);
            });
          },
          { once: true },
        ),
      );
      await registration.update();
      return result;
    });
    assert.equal(failedUpdate, true, "Incomplete update is rejected");
    assert.ok(
      (await app.evaluate(() => caches.keys())).includes(cacheBefore[0]),
      "Previous complete cache survives",
    );
    await offline.setOffline(true);
    await app.reload({ waitUntil: "domcontentloaded" });
    await nav(app).first().waitFor();
    console.log("ok   failed deployment preserves an offline-usable app");
    await offline.setOffline(false);
    await networkState(false);
    deployment = "updated";
    await app.evaluate(async () =>
      (await navigator.serviceWorker.ready).update(),
    );
    await app
      .getByRole("button", { name: "Refresh to update", exact: true })
      .waitFor();
    await app
      .getByRole("button", { name: "Refresh to update", exact: true })
      .click();
    await app.waitForFunction(async () => {
      const names = await caches.keys();
      return names.length === 1 && names[0].startsWith("moshpit-updated-");
    });
    await nav(app).first().waitFor();
    console.log(
      "ok   complete update waits for refresh and removes old caches after activation",
    );
    await offline.close();
  } finally {
    await browser.close();
  }
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
