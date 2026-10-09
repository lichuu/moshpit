import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser, Page, Request, TestInfo } from "@playwright/test";
import jsQR from "jsqr";
import { test, expect, openApp, seedHosts, loginBridge, pairBridge, countPermissionPrompts, permissionPrompts, BRIDGE_PASSWORD, ROOT, type Bridge } from "../fixtures";

// S7b: a browser without a device asks for access, an approved browser (or
// the host's admin socket) decides, and the asking browser redeems once and
// reaches its herd. Two browser contexts share one isolated bridge.

const herdr = `
case "$*" in
  "api snapshot"*) echo '{"result":{"snapshot":{"agents":[]}}}' ;;
  *) echo '{}' ;;
esac`;

const profile = (bridge: Bridge) => ({
  id: "h", label: "Alpha", transport: "tailscale", user: "", hostname: "127.0.0.1", port: bridge.port, demo: false, tailnetUrl: bridge.url,
});

async function secondPage(browser: Browser, testInfo: TestInfo) {
  const { viewport, isMobile, hasTouch, userAgent, deviceScaleFactor } = testInfo.project.use;
  const context = await browser.newContext({ viewport, isMobile, hasTouch, userAgent, deviceScaleFactor, baseURL: testInfo.project.use.baseURL });
  return context.newPage();
}

async function openHosts(page: Page, bridge: Bridge) {
  await openApp(page, { demo: false });
  await seedHosts(page, [profile(bridge)]);
  await page.getByRole("button", { name: /hosts/i }).first().click();
}

/** A browser that is already approved, connected and looking at Hosts. */
async function approvedBrowser(page: Page, bridge: Bridge) {
  await openApp(page, { demo: false });
  await pairBridge(page, bridge.url, await loginBridge(page, bridge.url));
  await seedHosts(page, [profile(bridge)]);
  await page.getByRole("button", { name: /hosts/i }).first().click();
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByRole("button", { name: "Disconnect" })).toBeVisible();
}

/** The login and access-request sequence for a browser already at Hosts. */
async function askAccess(page: Page, bridge: Bridge, name = "Laptop") {
  await page.getByRole("button", { name: "Connect" }).click();
  await page.getByLabel("Bridge password").fill(BRIDGE_PASSWORD);
  await page.getByRole("button", { name: "Unlock" }).click();
  await page.getByLabel("Name for this device").fill(name);
  await page.getByRole("button", { name: "Request access", exact: true }).click();
  const phrase = page.getByLabel("Verification phrase");
  await expect(phrase).toHaveText(/^[a-z]+ [a-z]+ [a-z]+$/);
  return (await phrase.textContent()) ?? "";
}

/** A browser that signs in with the password but holds no device, then asks for access. */
async function askingBrowser(page: Page, bridge: Bridge, name = "Laptop") {
  await openHosts(page, bridge);
  return askAccess(page, bridge, name);
}

async function held(page: Page, bridge: Bridge) {
  return page.evaluate((origin) => JSON.parse(sessionStorage.getItem(`moshpit-enrollment:${origin}`) ?? "null"), bridge.url);
}

type AdminClient = { sendAdminRequest: (message: object, options: { stateDir: string }) => Promise<{ result?: unknown }> };
async function admin(bridge: Bridge, message: object) {
  const { sendAdminRequest } = (await import(pathToFileURL(path.join(ROOT, "bridge/admin.mjs")).href)) as AdminClient;
  return sendAdminRequest(message, { stateDir: path.join(bridge.dir, "state") });
}

test("an approved browser approves a new one, which redeems once and reaches its herd", async ({ page, bridge, browser }, testInfo) => {
  const host = await bridge({ herdr });
  const asker = await secondPage(browser, testInfo);
  await countPermissionPrompts(asker.context());
  // Audit boundary: bootstrap (navigation, onboarding, seedHosts reload)
  // completes and the page idles before the collector is installed. The
  // enrollment secret is created by the access request below, so no
  // earlier request could carry it, and no collected request is a load
  // cancelled by the reload — every one reaches the network, so its
  // headers can be audited.
  await openHosts(asker, host);
  await asker.waitForLoadState("networkidle");
  const sent: Request[] = [];
  asker.on("request", (request) => sent.push(request));

  await approvedBrowser(page, host);
  const phrase = await askAccess(asker, host);
  await expect(asker.getByText("Approve this browser from a device that already has access, or run moshpit devices approve on the host.")).toBeVisible();
  const { secret } = await held(asker, host);
  expect(secret).toMatch(/^[A-Za-z0-9_-]{22}$/);

  const requests = page.getByRole("region", { name: "Access requests" });
  await expect(requests.getByText(phrase)).toBeVisible({ timeout: 10_000 });
  await expect(requests.getByText("Laptop")).toBeVisible();
  await requests.getByRole("button", { name: "Approve" }).click();
  await expect(requests.getByText(`Approve only if the new device shows ${phrase}.`)).toBeVisible();
  await requests.getByRole("button", { name: "Confirm approval" }).click();

  await expect(asker.locator("[data-sonner-toast]").filter({ hasText: "Connected to Alpha" })).toBeVisible({ timeout: 15_000 });
  await expect(asker.getByRole("button", { name: "Disconnect" })).toBeVisible();
  expect(await held(asker, host)).toBeNull();
  const stored = await asker.evaluate((origin) => JSON.parse(localStorage.getItem(origin) ?? "{}"), host.url);
  expect(stored.deviceId).toBeTruthy();
  await expect(requests).toHaveCount(0, { timeout: 10_000 });
  await asker.waitForLoadState("networkidle");
  expect(await permissionPrompts(asker), "enrolling asks for no notification permission").toEqual({ requestPermission: 0, subscribe: 0 });

  const carriers = new Set<string>();
  for (const request of sent) {
    const { pathname } = new URL(request.url());
    expect(request.url()).not.toContain(secret);
    for (const value of Object.values(await request.allHeaders())) expect(value).not.toContain(secret);
    if (request.postData()?.includes(secret)) carriers.add(pathname);
  }
  expect([...carriers].sort()).toEqual(["/api/enrollment/redeem", "/api/enrollment/status"]);
  const redeems = sent.filter((request) => new URL(request.url()).pathname === "/api/enrollment/redeem");
  expect(redeems).toHaveLength(1);
  await asker.context().close();
});

/** The text a QR image on the page encodes. */
async function decodeQr(page: Page, alt: string) {
  const pixels = await page.getByAltText(alt).evaluate(async (img: HTMLImageElement) => {
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const context = canvas.getContext("2d")!;
    context.drawImage(img, 0, 0);
    const data = context.getImageData(0, 0, canvas.width, canvas.height);
    return { width: data.width, height: data.height, data: Array.from(data.data) };
  });
  return jsQR(Uint8ClampedArray.from(pixels.data), pixels.width, pixels.height)?.data;
}

test("an approved browser shares the connected host's address only, and an unapproved one cannot", async ({ page, bridge, browser }, testInfo) => {
  const host = await bridge({ herdr });
  const asker = await secondPage(browser, testInfo);
  await askingBrowser(asker, host);
  await expect(asker.getByRole("button", { name: "Share address" })).toHaveCount(0);

  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await approvedBrowser(page, host);
  await page.getByRole("button", { name: "Share address" }).click();
  const dialog = page.getByRole("dialog", { name: "Share address" });
  await expect(dialog.getByText("On a phone: install Tailscale, sign in as this host's owner, then scan the code or open the address.")).toBeVisible();
  await expect(dialog.getByText(host.url, { exact: true })).toBeVisible();
  expect(await decodeQr(page, `QR code for ${host.url}`)).toBe(host.url);
  await dialog.getByRole("button", { name: "Copy address" }).click();
  await expect(page.getByText("Address copied")).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(host.url);
  await asker.context().close();
});

test("a rejected request shows the rejected state", async ({ page, bridge, browser }, testInfo) => {
  const host = await bridge({ herdr });
  const asker = await secondPage(browser, testInfo);
  await approvedBrowser(page, host);
  const phrase = await askingBrowser(asker, host, "Stranger");

  const requests = page.getByRole("region", { name: "Access requests" });
  await expect(requests.getByText(phrase)).toBeVisible({ timeout: 10_000 });
  await requests.getByRole("button", { name: "Reject" }).click();

  await expect(asker.getByText("This request was rejected")).toBeVisible({ timeout: 10_000 });
  await expect(asker.getByRole("button", { name: "Request access again" })).toBeVisible();
  expect(await held(asker, host)).toBeNull();
  await asker.context().close();
});

test("an unapproved request shows the expired state", async ({ page, bridge }) => {
  const host = await bridge({ herdr, env: { MOSHPIT_TEST_ENROLLMENT_REQUEST_MS: "3000" } });
  await askingBrowser(page, host);
  await expect(page.getByText("This request expired")).toBeVisible({ timeout: 10_000 });
  expect(await held(page, host)).toBeNull();
});

test("a same-tab reload resumes a pending request, and a host approval completes it", async ({ page, bridge }) => {
  const host = await bridge({ herdr });
  const phrase = await askingBrowser(page, host);
  const before = await held(page, host);

  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("button", { name: /hosts/i }).first().click();
  const connect = page.getByRole("button", { name: "Connect" });
  if (await connect.isVisible()) await connect.click();
  await expect(page.getByLabel("Verification phrase")).toHaveText(phrase);
  expect(await held(page, host)).toEqual(before);

  await admin(host, { action: "approve", requestId: before.id });
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Connected to Alpha" })).toBeVisible({ timeout: 15_000 });
});
