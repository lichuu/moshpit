import { test, expect, openApp, seedHosts } from "../fixtures";

// Local protocol-2 door; shared fixtures remain owned by the bridge test cutover.
async function stubDoor(page: import("@playwright/test").Page, origin: string, behavior: "live" | "not-bridge" | "dead" | "down" = "live") {
  await page.route(`${origin}/**`, (route) => {
    if (behavior === "dead") return route.abort();
    const pathname = new URL(route.request().url()).pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (pathname === "/api/auth-info") return behavior === "not-bridge" ? json({}, 404) : json({ protocol: 2, requiredFactors: [] });
    if (behavior !== "live") return json({ error: { code: "unavailable", message: "down" } }, 502);
    if (pathname === "/api/snapshot") return json({ hostId: "test", agents: [], panes: [], kinds: [] });
    return json({});
  });
}

// Adding a host is the one flow that decides which machine the app will talk
// to, so the validator's accept and reject paths both matter.
test.describe("add host", () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page, { demo: false });
    await seedHosts(page, []);
  });

  async function openHosts(page: import("@playwright/test").Page) {
    await page.getByRole("button", { name: /hosts/i }).first().click();
    await expect(page.getByRole("button", { name: "Add host" })).toBeVisible();
  }

  test("saves a bridge that answers", async ({ page }) => {
    await stubDoor(page, "http://box.tail1.ts.net:8802", "live");
    await openHosts(page);

    await page.getByRole("button", { name: "Add host" }).click();
    await page.getByLabel("Bridge URL").fill("http://box.tail1.ts.net:8802");
    await page.getByRole("button", { name: "Save host" }).click();

    // Plain HTTP on a .ts.net name is legitimate: Tailscale Serve terminates
    // TLS, so the validator must not insist on https here.
    await expect(page.getByRole("heading", { name: "box" })).toBeVisible();
  });

  test("refuses a door that does not answer, and does not save it", async ({ page }) => {
    await stubDoor(page, "https://dead-host.ts.net:8802", "not-bridge");
    await openHosts(page);

    await page.getByRole("button", { name: "Add host" }).click();
    await page.getByLabel("Bridge URL").fill("https://dead-host.ts.net:8802");
    await page.getByRole("button", { name: "Save host" }).click();

    await expect(page.getByText("No moshpit bridge answered")).toBeVisible();
    await expect(page.getByRole("heading", { name: "dead-host" })).toHaveCount(0);
  });
});

test("an older same-origin device refresh cannot replace the current host's list", async ({ page }) => {
  const origin = "http://shared-host.ts.net:8802";
  let releaseOldRefresh: () => void = () => {};
  let oldRefreshStarted: () => void = () => {};
  let oldRefreshSettled: () => void = () => {};
  const delayedOldRefresh = new Promise<void>((resolve) => {
    releaseOldRefresh = resolve;
  });
  const oldRefreshPending = new Promise<void>((resolve) => {
    oldRefreshStarted = resolve;
  });
  const oldRefreshDone = new Promise<void>((resolve) => {
    oldRefreshSettled = resolve;
  });
  let lists = 0;
  const device = (id: string, name: string) => ({
    id,
    name,
    owner: "owner",
    createdAt: Date.now(),
    expiresAt: null,
    revokedAt: null,
    active: true,
  });

  await page.route(`${origin}/**`, async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/api/auth-info")
      return route.fulfill({ json: { protocol: 2, requiredFactors: [] } });
    if (pathname === "/api/snapshot")
      return route.fulfill({ json: { hostId: "shared", agents: [], panes: [], kinds: [] } });
    if (pathname === "/api/devices" && request.method() === "GET") {
      const list = ++lists;
      if (list === 2) {
        oldRefreshStarted();
        await delayedOldRefresh;
        await route.fulfill({
          json: [device("self", "A phone"), device("other", "A laptop")],
        }).catch(() => {});
        oldRefreshSettled();
        return;
      }
      return route.fulfill({
        json:
          list === 1
            ? [device("self", "A phone"), device("other", "A laptop")]
            : [device("self", "B phone")],
      });
    }
    return route.fulfill({ json: device("other", "A laptop") });
  });

  await openApp(page, { demo: false });
  await seedHosts(page, [
    { id: "a", label: "A", transport: "tailscale", user: "", hostname: "a", port: 80, demo: false, tailnetUrl: origin },
    { id: "b", label: "B", transport: "tailscale", user: "", hostname: "b", port: 80, demo: false, tailnetUrl: origin },
  ]);
  await page.evaluate((url) => {
    localStorage.setItem(url, JSON.stringify({ deviceId: "self", deviceSecret: "a".repeat(43) }));
  }, origin);
  await page.getByRole("button", { name: /hosts/i }).first().click();

  await page.getByRole("heading", { name: "A", exact: true }).locator("xpath=ancestor::article").getByRole("button", { name: "Connect" }).click();
  await expect(page.getByText("A laptop", { exact: true })).toBeVisible();
  await page.getByLabel("Expiry for A laptop").selectOption("30");
  await oldRefreshPending;

  await page.getByRole("heading", { name: "A", exact: true }).locator("xpath=ancestor::article").getByRole("button", { name: "Disconnect" }).click();
  await page.getByRole("heading", { name: "B", exact: true }).locator("xpath=ancestor::article").getByRole("button", { name: "Connect" }).click();
  await expect(page.getByLabel("Expiry for B phone")).toBeVisible();

  releaseOldRefresh();
  await oldRefreshDone;
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(page.getByLabel("Expiry for B phone")).toBeVisible();
  await expect(page.getByText("A laptop", { exact: true })).toHaveCount(0);
});

test.describe("device approval", () => {
  const origin = "http://pairing-host.ts.net:8802";
  const hosts = [
    {
      id: "pairing-a",
      label: "Pairing A",
      transport: "tailscale" as const,
      user: "",
      hostname: "pairing-host-a",
      port: 80,
      demo: false,
      tailnetUrl: `${origin}/`,
    },
    {
      id: "pairing-b",
      label: "Pairing B",
      transport: "tailscale" as const,
      user: "",
      hostname: "pairing-host-b",
      port: 80,
      demo: false,
      tailnetUrl: origin,
    },
  ];

  test("shares pairing pending state across duplicate bridge profiles", async ({ page }) => {
    let authCalls = 0;
    let selfIssueCalls = 0;
    const pairingBodies: unknown[] = [];
    let releasePairing: () => void = () => {};
    let markPairingStarted: () => void = () => {};
    const pairingReleased = new Promise<void>((resolve) => { releasePairing = resolve; });
    const pairingStarted = new Promise<void>((resolve) => { markPairingStarted = resolve; });
    await page.route(`${origin}/**`, async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (pathname === "/api/auth-info") {
        authCalls++;
        return route.fulfill({ json: { protocol: 2, requiredFactors: [] } });
      }
      if (pathname === "/api/devices/pair") {
        selfIssueCalls++;
        return route.fulfill({ status: 403, json: { error: { code: "enrollment_authorization_required", message: "no" } } });
      }
      if (pathname === "/api/devices/pairing") {
        pairingBodies.push(request.postDataJSON());
        markPairingStarted();
        await pairingReleased;
        return route.fulfill({
          json: { deviceId: "device", deviceSecret: "s".repeat(43), expiresAt: null },
        });
      }
      if (pathname === "/api/snapshot")
        return route.fulfill({ json: { hostId: "pairing", agents: [], panes: [], kinds: [] } });
      if (pathname === "/api/devices") return route.fulfill({ json: [] });
      return route.fulfill({ json: {} });
    });

    await openApp(page, { demo: false });
    await seedHosts(page, hosts);
    await page.getByRole("button", { name: /hosts/i }).first().click();
    await page.getByRole("heading", { name: "Pairing A" }).locator("xpath=ancestor::article").getByRole("button", { name: "Connect" }).click();
    await expect(page.getByRole("alert")).toContainText("Request access below");
    await page.getByText("Have a pairing secret?").click();
    const approvalForm = page.getByRole("form", { name: "Device approval" });
    await page.getByLabel("Device name").fill("Dana's phone");
    // The panel names the host command, with the name the browser will use.
    await expect(page.getByText('node bridge/admin.mjs pair --name "Dana\'s phone"')).toBeVisible();
    await page.getByLabel("Pairing secret").fill("manual-grant");
    await approvalForm.evaluate((element) => {
      element.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await pairingStarted;

    await expect(approvalForm).toHaveAttribute("aria-busy", "true");
    await expect(page.getByLabel("Device name")).toBeDisabled();
    await expect(page.getByLabel("Pairing secret")).toBeDisabled();

    await page.getByRole("heading", { name: "Pairing B" }).locator("xpath=ancestor::article").getByRole("button", { name: "Connect" }).click();
    await expect.poll(() => authCalls).toBe(2);
    await expect(approvalForm).toHaveAttribute("aria-busy", "true");
    await expect(page.getByRole("button", { name: "Pairing…" })).toBeDisabled();
    await approvalForm.evaluate((element) => {
      element.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(pairingBodies).toHaveLength(1);

    releasePairing();
    await expect(page.getByRole("button", { name: "Disconnect" })).toBeVisible();
    expect(pairingBodies).toEqual([{ secret: "manual-grant", name: "Dana's phone" }]);
    expect(selfIssueCalls).toBe(0);
  });

  test("announces an asynchronous approval failure", async ({ page }) => {
    await page.route(`${origin}/**`, (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/api/auth-info")
        return route.fulfill({ json: { protocol: 2, requiredFactors: [] } });
      if (pathname === "/api/devices/pairing")
        return route.fulfill({
          status: 403,
          json: { error: { code: "pairing_grant_invalid", message: "That pairing secret is not valid. Create a new one on the host." } },
        });
      return route.fulfill({ json: {} });
    });

    await openApp(page, { demo: false });
    await seedHosts(page, [hosts[0]]);
    await page.getByRole("button", { name: /hosts/i }).first().click();
    await page.getByRole("button", { name: "Connect" }).click();
    await page.getByText("Have a pairing secret?").click();
    await expect(page.getByText('node bridge/admin.mjs pair --name "This device"')).toBeVisible();
    await page.getByLabel("Pairing secret").fill("spent-grant");
    await page.getByRole("button", { name: "Pair", exact: true }).click();

    await expect(page.getByRole("alert")).toContainText("Pairing failed");
    await expect(page.getByRole("alert")).toContainText("Create a new one on the host");
    // The failure keeps the panel so a fresh secret can be entered.
    await expect(page.getByLabel("Pairing secret")).toBeEnabled();
  });
});

test("a stale same-origin 403 cannot clear credentials from a newer pairing", async ({ page }) => {
  const origin = "http://repaired-host.ts.net:8802";
  const oldSecret = "a".repeat(43);
  const newSecret = "b".repeat(43);
  let releaseStale: () => void = () => {};
  let staleStarted: () => void = () => {};
  let staleSettled: () => void = () => {};
  const staleRelease = new Promise<void>((resolve) => { releaseStale = resolve; });
  const stalePending = new Promise<void>((resolve) => { staleStarted = resolve; });
  const staleDone = new Promise<void>((resolve) => { staleSettled = resolve; });
  // Host B's connect must meet "pair again". Keyed to the scenario, not to a
  // call count: a background poll of host A can land in between on a loaded
  // runner and would otherwise take the 403 meant for B.
  let requirePairing = false;
  let lists = 0;
  const device = (id: string, name: string) => ({
    id,
    name,
    owner: "owner",
    createdAt: Date.now(),
    expiresAt: null,
    revokedAt: null,
    active: true,
  });

  await page.route(`${origin}/**`, async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/api/auth-info")
      return route.fulfill({ json: { protocol: 2, requiredFactors: [] } });
    if (pathname === "/api/snapshot") {
      if (requirePairing)
        return route.fulfill({ status: 403, json: { error: { code: "device_required", message: "Pair again" } } });
      return route.fulfill({ json: { hostId: "shared", agents: [], panes: [], kinds: [] } });
    }
    if (pathname === "/api/devices/pairing") {
      requirePairing = false;
      return route.fulfill({ json: { deviceId: "new", deviceSecret: newSecret, expiresAt: null } });
    }
    if (pathname === "/api/devices" && request.method() === "GET") {
      lists += 1;
      if (lists === 2) {
        staleStarted();
        await staleRelease;
        await route.fulfill({
          status: 403,
          json: { error: { code: "device_expired", message: "Old device expired" } },
        }).catch(() => {});
        staleSettled();
        return;
      }
      return route.fulfill({ json: [device(lists === 1 ? "old" : "new", lists === 1 ? "Old phone" : "New phone")] });
    }
    if (pathname === "/api/devices/expiry")
      return route.fulfill({ json: device("old", "Old phone") });
    return route.fulfill({ json: {} });
  });

  await openApp(page, { demo: false });
  await seedHosts(page, [
    { id: "a", label: "A", transport: "tailscale", user: "", hostname: "a", port: 80, demo: false, tailnetUrl: origin },
    { id: "b", label: "B", transport: "tailscale", user: "", hostname: "b", port: 80, demo: false, tailnetUrl: origin },
  ]);
  await page.evaluate(({ origin, oldSecret }) => {
    localStorage.setItem(origin, JSON.stringify({ deviceId: "old", deviceSecret: oldSecret }));
  }, { origin, oldSecret });
  await page.getByRole("button", { name: /hosts/i }).first().click();

  await page.getByRole("heading", { name: "A", exact: true }).locator("xpath=ancestor::article").getByRole("button", { name: "Connect" }).click();
  await page.getByLabel("Expiry for Old phone").selectOption("30");
  await stalePending;
  await page.getByRole("heading", { name: "A", exact: true }).locator("xpath=ancestor::article").getByRole("button", { name: "Disconnect" }).click();
  requirePairing = true;
  await page.getByRole("heading", { name: "B", exact: true }).locator("xpath=ancestor::article").getByRole("button", { name: "Connect" }).click();
  await page.getByText("Have a pairing secret?").click();
  await page.getByLabel("Pairing secret").fill("new-grant");
  await page.getByRole("button", { name: "Pair", exact: true }).click();
  await expect(page.getByLabel("Expiry for New phone")).toBeVisible();

  releaseStale();
  await staleDone;
  await expect(page.getByLabel("Pairing secret")).toHaveCount(0);
  await expect(page.getByLabel("Expiry for New phone")).toBeVisible();
  expect(await page.evaluate((origin) => JSON.parse(localStorage.getItem(origin) ?? "{}"), origin)).toMatchObject({
    deviceId: "new",
    deviceSecret: newSecret,
  });
});

// Each failure mode gets its own message: the point is that the app tells you
// which of the three went wrong, not just that something did.
test.describe("connect failures", () => {
  const cases = [
    { door: "http://dead-door.ts.net:8802", behavior: "dead", message: "Can’t reach the bridge" },
    { door: "http://not-a-bridge.ts.net:8802", behavior: "not-bridge", message: "Not a moshpit bridge" },
    { door: "http://bridge-down.ts.net:8802", behavior: "down", message: "Bridge unreachable" },
  ] as const;

  for (const { door, behavior, message } of cases) {
    test(`a ${behavior} door reports "${message}"`, async ({ page }) => {
      await openApp(page, { demo: false });
      await stubDoor(page, door, behavior);
      await seedHosts(page, [
        {
          id: "t",
          label: "T",
          transport: "tailscale",
          user: "",
          hostname: "x",
          port: 80,
          demo: false,
          tailnetUrl: door,
        },
      ]);
      await page.evaluate((origin) => localStorage.setItem(origin, JSON.stringify({ deviceId: "d", deviceSecret: "s".repeat(43), deviceExpiresAt: Date.now() + 60000 })), door);
      // The route survives the reload seedHosts performs, but re-assert it so
      // the spec does not depend on that detail.
      await stubDoor(page, door, behavior);

      await page.getByRole("button", { name: /hosts/i }).first().click();
      await page.getByRole("button", { name: "Connect" }).click();

      // Connection diagnosis walks several probes before it concludes, so give
      // it room rather than racing it with a fixed sleep.
      await expect(page.getByText(message)).toBeVisible({ timeout: 30_000 });
    });
  }
});

// S5: a protocol mismatch is a version problem with its own recovery, never
// "authenticate with this bridge".
test.describe("incompatible bridge", () => {
  for (const { protocol, title, action } of [
    { protocol: 3, title: "This app is out of date", action: "Reload app" },
    { protocol: 1, title: "This bridge is out of date", action: "Check again" },
  ]) {
    test(`protocol ${protocol} explains the mismatch and offers ${action}`, async ({ page }) => {
      const door = `http://proto-${protocol}.ts.net:8802`;
      await openApp(page, { demo: false });
      await seedHosts(page, [{ id: "p", label: "P", transport: "tailscale", user: "", hostname: "x", port: 80, demo: false, tailnetUrl: door }]);
      await page.route(`${door}/**`, (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ protocol, requiredFactors: [] }) }));
      await page.getByRole("button", { name: /hosts/i }).first().click();
      await page.getByRole("button", { name: "Connect" }).click();

      const alert = page.getByRole("alert");
      await expect(alert).toContainText(title);
      await expect(alert).toContainText(`protocol ${protocol}`);
      await expect(alert).not.toContainText("Authenticate");
      await expect(alert.getByRole("button", { name: action })).toBeVisible();
    });
  }
});

// A network failure retries on its own at 1, 2, 4 and 8 seconds, then offers
// Retry. A failure that is not a network one stops the schedule, and another
// host's attempt cancels it.
test.describe("connect retries", () => {
  const door = "http://flaky-door.ts.net:8802";
  const host = { id: "f", label: "Flaky", transport: "tailscale", user: "", hostname: "x", port: 80, demo: false, tailnetUrl: door };

  const other = { ...host, id: "o", label: "Other", tailnetUrl: "http://other-door.ts.net:8802" };

  async function setUp(page: import("@playwright/test").Page) {
    const state = { behavior: "dead" as "dead" | "pairing", discovery: 0 };
    await openApp(page, { demo: false });
    await seedHosts(page, [host, other]);
    await page.route(`${other.tailnetUrl}/**`, (route) => route.abort());
    await page.route(`${door}/**`, (route) => {
      if (state.behavior === "dead") {
        if (new URL(route.request().url()).pathname === "/api/auth-info") state.discovery += 1;
        return route.abort();
      }
      // Alive, but this browser holds no device: pairing, not a network error.
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ protocol: 2, requiredFactors: [] }) });
    });
    await page.clock.install();
    await page.getByRole("button", { name: /hosts/i }).first().click();
    await page.getByRole("button", { name: "Connect" }).first().click();
    return state;
  }

  test("retries on the schedule, then offers Retry", async ({ page }) => {
    const state = await setUp(page);
    await expect(page.getByRole("alert")).toContainText("Trying again in 1 s.");
    // Each attempt's own failure schedules the next, so wait for it to be
    // reported before moving the clock on.
    for (const [wait, next] of [[1000, "in 2 s."], [2000, "in 4 s."], [4000, "in 8 s."]] as const) {
      await page.clock.runFor(wait);
      await expect(page.getByRole("alert")).toContainText(`Trying again ${next}`);
    }
    await page.clock.runFor(8000);
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(page.getByRole("alert")).not.toContainText("Trying again");
    const spent = state.discovery;
    await page.clock.runFor(60_000);
    expect(state.discovery, "no retries after the schedule is spent").toBe(spent);

    await page.getByRole("button", { name: "Retry" }).click();
    await page.clock.runFor(100);
    await expect.poll(() => state.discovery).toBeGreaterThan(spent);
  });

  test("a non-network failure stops the schedule", async ({ page }) => {
    const state = await setUp(page);
    await expect(page.getByRole("alert")).toContainText("Trying again in 1 s.");
    state.behavior = "pairing";
    await page.clock.runFor(1000);
    await expect(page.getByRole("alert")).toContainText("Pairing required");
    await page.clock.runFor(30_000);
    await expect(page.getByRole("alert")).toContainText("Pairing required");
    await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
  });

  test("another attempt cancels a pending retry", async ({ page }) => {
    const state = await setUp(page);
    await expect(page.getByRole("alert")).toContainText("Trying again in 1 s.");
    const before = state.discovery;
    // Connecting to the other host is a new attempt; the flaky door's
    // pending retry must not fire.
    await page.getByRole("button", { name: "Connect" }).nth(1).click();
    await page.clock.runFor(30_000);
    expect(state.discovery).toBe(before);
  });
});
