import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
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
    res.setHeader(
      "Content-Type",
      mime[path.extname(file)] ?? "application/octet-stream",
    );
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address !== "string");

const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
  });
  await page.addInitScript(() => {
    Object.defineProperty(window, "Notification", {
      value: undefined,
      configurable: true,
    });
  });
  await page.goto(`http://127.0.0.1:${address.port}/?demo=1`);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("button", { name: "Open moshpit", exact: true }).click();
  await page.locator('nav[aria-label="Primary"] > button').nth(2).click();
  const toggle = page.getByRole("checkbox", { name: "Notify when an agent blocks" });
  await toggle.click();
  await page.getByText(/Add moshpit to your Home Screen/).waitFor();
  assert.equal(
    await toggle.isChecked(),
    false,
    "must not be checked when the Notification API is unavailable",
  );
  assert.equal(await toggle.isDisabled(), true, "unavailable cannot be retried");
  const persisted = await page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem("moshpit-v1") ?? "{}");
    return raw.state?.settings?.notify;
  });
  assert.equal(persisted, false);
  console.log("ok   Notification undefined tap does not paint On");

  // Demo herdr has no tailnetUrl, so granting permission registers no
  // subscription. On here would be the same lie in a different place.
  const origin = `http://127.0.0.1:${address.port}`;
  const granted = await browser.newContext({
    viewport: { width: 390, height: 844 },
    permissions: ["notifications"],
  });
  const local = await granted.newPage();
  await local.goto(`${origin}/?demo=1`);
  await local.getByRole("button", { name: "Next", exact: true }).click();
  await local.getByRole("button", { name: "Next", exact: true }).click();
  await local.getByRole("button", { name: "Open moshpit", exact: true }).click();
  await local.locator('nav[aria-label="Primary"] > button').nth(2).click();
  const localToggle = local.getByRole("checkbox", { name: "Notify when an agent blocks" });
  await localToggle.click();
  await local.getByText(/This device only/).waitFor();
  assert.equal(await localToggle.isChecked(), true);
  await localToggle.click();
  await local.getByText(/This device only/).waitFor({ state: "detached" });
  assert.equal(await localToggle.isChecked(), false);
  console.log("ok   granted with no bridge says This device only, and taps back off");
  await granted.close();
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
