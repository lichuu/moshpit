import { test, expect } from "@playwright/test";
import { DEV_URL } from "../../playwright.config";

test("protocol-2 discovery, credentials, errors and ticket requests", async ({ page }) => {
  await page.goto(`${DEV_URL}/`);
  const result = await page.evaluate(async () => {
    const accessPath = "/src/lib/moshpit/access.ts";
    const bridgePath = "/src/lib/moshpit/bridge.ts";
    const a = await import(accessPath);
    const b = await import(bridgePath);
    const origin = "https://protocol-two.example";
    const requests: { url: string; headers: Record<string, string> }[] = [];
    let failure: { code: string; message: string } | null = null;
    let protocol = 2;
    let ticket = 0;
    window.fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, headers: init?.headers as Record<string, string> ?? {} });
      if (url.endsWith("/auth-info")) return Response.json({ protocol, requiredFactors: ["password"] });
      if (failure) return Response.json({ error: failure }, { status: failure.code === "password_required" ? 401 : 403 });
      if (url.endsWith("/login")) return Response.json({ token: "token", owner: "owner" });
      if (url.endsWith("/pairing")) return Response.json({ deviceId: "device", deviceSecret: "s".repeat(43), expiresAt: Date.now() + 60000 });
      if (url.endsWith("/terminal-ticket")) return Response.json({ ticket: String(++ticket), expiresAt: Date.now() + 1000 });
      // Shaped like the bridge's own device view, so the client parses it the
      // way it parses a real one.
      if (url.endsWith("/devices/revoke"))
        return Response.json({ id: "device", name: "this browser", owner: "owner", createdAt: Date.now(), expiresAt: null, revokedAt: Date.now(), active: false });
      return Response.json({ agents: [] });
    };
    const states = [await b.discoverAccess(origin)];
    const before = requests.length;
    await b.fetchSnapshot(origin).catch(() => {});
    const gated = requests.length === before;
    await b.postLogin(origin, "password");
    states.push(await b.discoverAccess(origin));
    await b.consumePairing(origin, "grant");
    states.push(await b.discoverAccess(origin));
    a.saveCredentials(origin, { deviceExpiresAt: Date.now() - 1 });
    states.push(await b.discoverAccess(origin));
    const staleExpiryKept = Boolean(a.credentials(origin).deviceSecret);
    await b.fetchSnapshot(origin);
    const authenticated = requests.at(-1)?.headers;
    const tickets = [await b.terminalTicket(origin, "pane"), await b.terminalTicket(origin, "pane")];
    failure = { code: "device_revoked", message: "This device was revoked" };
    const count = requests.length;
    const message = await b.postAction(origin, { kind: "keys", target: "pane", keys: "enter" }).catch((error: Error) => error.message);
    const noRepair = requests.length === count + 1;
    states.push(a.hostAccess(origin));
    const clearedDevice = !a.credentials(origin).deviceSecret;
    failure = null;
    await b.consumePairing(origin, "grant");
    await b.discoverAccess(origin);
    failure = { code: "password_required", message: "Sign in again" };
    await b.fetchSnapshot(origin).catch(() => {});
    states.push(a.hostAccess(origin));
    const clearedSession = !a.credentials(origin).sessionToken;
    failure = null;
    protocol = 3;
    states.push(await b.discoverAccess(origin));
    protocol = 2;
    await b.postLogin(origin, "password");
    await b.consumePairing(origin, "grant");
    await b.discoverAccess(origin);
    const beforeSelfRevoke = requests.length;
    await b.revokeDevice(origin, "device");
    states.push(a.hostAccess(origin));
    const selfRevokeRequests = requests.length - beforeSelfRevoke;
    return { states, gated, authenticated, tickets, noRepair, message, staleExpiryKept, clearedDevice, clearedSession, selfRevokeRequests, isolated: a.credentials("https://other.example"), discoveryHeaders: requests[0].headers };
  });
  expect(result.states.map((state) => state.status)).toEqual(["login-required", "pairing-required", "ready", "ready", "pairing-required", "login-required", "incompatible", "pairing-required"]);
  expect(result.states[4]).toEqual({ status: "pairing-required", reason: "revoked" });
  expect(result.states[6]).toEqual({ status: "incompatible", requiredProtocol: 3 });
  expect(result.states[7]).toEqual({ status: "pairing-required", reason: "revoked" });
  expect(result.gated && result.noRepair && result.staleExpiryKept && result.clearedDevice && result.clearedSession).toBe(true);
  expect(result.selfRevokeRequests).toBe(1);
  expect(result.authenticated).toMatchObject({ authorization: "Bearer token", "x-moshpit-device": `device.${"s".repeat(43)}` });
  expect(result.message).toBe("This device was revoked");
  expect(result.tickets[0].ticket).not.toBe(result.tickets[1].ticket);
  expect(result.isolated).toEqual({});
  expect(result.discoveryHeaders).toEqual({});
});

test("a host with push turned off says so and the browser is not subscribed", async ({ page }) => {
  await page.goto(`${DEV_URL}/`);
  const result = await page.evaluate(async () => {
    // Headless Chromium reports notifications as denied even after a grant,
    // and a denied browser never asks the bridge. Pin permission so this
    // test covers the bridge's answer rather than the runner's.
    Object.defineProperty(Notification, "permission", { configurable: true, get: () => "granted" });
    const accessPath = "/src/lib/moshpit/access.ts";
    const bridgePath = "/src/lib/moshpit/bridge.ts";
    const a = await import(accessPath);
    const b = await import(bridgePath);
    const origin = "https://push-off.example";
    const legacy = "https://push-legacy.example";
    const reason = "This host relays push through MOSHPIT_PUSH_ENDPOINT.";
    const paths: string[] = [];
    window.fetch = async (input) => {
      const url = new URL(String(input));
      paths.push(`${url.origin}${url.pathname}`);
      if (url.origin === legacy) return Response.json({ protocol: 2, requiredFactors: [] });
      return Response.json({ protocol: 2, requiredFactors: [], push: { available: false, reason } });
    };
    a.saveCredentials(origin, { deviceId: "device", deviceSecret: "s".repeat(43) });
    await b.discoverAccess(origin);
    const setup = await b.registerPush(origin);
    return {
      setup,
      control: b.pushControl(setup),
      paths,
      legacy: await b.fetchPushAvailability(legacy),
    };
  });
  expect(result.setup).toEqual({ status: "unavailable", reason: "bridge", message: "This host relays push through MOSHPIT_PUSH_ENDPOINT." });
  expect(result.control).toEqual({ checked: false, disabled: true, note: "This host relays push through MOSHPIT_PUSH_ENDPOINT." });
  expect(result.paths).not.toContain("https://push-off.example/api/vapid");
  expect(result.paths).not.toContain("https://push-off.example/api/push-subscription");
  // A bridge from before the field existed still sends push.
  expect(result.legacy).toEqual({ available: true });
});

test("pairing redeems a host-issued secret and never asks the bridge for a grant", async ({ page }) => {
  await page.goto(`${DEV_URL}/`);
  const { bodies, paths } = await page.evaluate(async () => {
    const bridgePath = "/src/lib/moshpit/bridge.ts";
    const { consumePairing } = await import(bridgePath);
    const bodies: unknown[] = [];
    const paths: string[] = [];
    window.fetch = async (input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      paths.push(new URL(String(input)).pathname);
      return Response.json({
        deviceId: "device",
        deviceSecret: "s".repeat(43),
        expiresAt: Date.now() + 60_000,
      });
    };

    await consumePairing("https://pairing-name.example", "manual");
    await consumePairing("https://pairing-name.example", "named", "Dana's phone");
    return { bodies, paths };
  });

  expect(paths).toEqual(["/api/devices/pairing", "/api/devices/pairing"]);
  expect(bodies).toEqual([
    { secret: "manual" },
    { secret: "named", name: "Dana's phone" },
  ]);
});

test("every request that carries credentials refuses to follow a redirect", async ({ page }) => {
  await page.goto(`${DEV_URL}/`);
  const result = await page.evaluate(async () => {
    const accessPath = "/src/lib/moshpit/access.ts";
    const bridgePath = "/src/lib/moshpit/bridge.ts";
    const sessionPath = "/src/lib/moshpit/session.ts";
    const blackboxPath = "/src/lib/moshpit/blackbox.ts";
    const a = await import(accessPath);
    const b = await import(bridgePath);
    const s = await import(sessionPath);
    const box = await import(blackboxPath);
    const origin = "https://redirects.example";
    const calls: { path: string; credentialed: boolean; redirect?: string }[] = [];
    window.fetch = async (input, init) => {
      const url = new URL(String(input));
      const headers = (init?.headers ?? {}) as Record<string, string>;
      // Login carries its credential in the body rather than a header.
      const credentialed = Boolean(headers.authorization || headers["x-moshpit-device"] || String(init?.body ?? "").includes('"password"'));
      calls.push({ path: url.pathname, credentialed, redirect: init?.redirect });
      if (url.pathname === "/api/auth-info") return Response.json({ protocol: 2, requiredFactors: ["password"] });
      if (url.pathname === "/api/login") return Response.json({ token: "token", owner: "owner" });
      if (url.pathname === "/api/devices/pairing") return Response.json({ deviceId: "device", deviceSecret: "s".repeat(43), expiresAt: null });
      if (url.pathname === "/api/terminal-ticket") return Response.json({ ticket: "t", expiresAt: Date.now() + 1000 });
      if (url.pathname === "/api/submit") return Response.json({ id: "r", state: "delivered" });
      return Response.json({});
    };
    await b.postLogin(origin, "password");
    await b.consumePairing(origin, "grant");
    await b.discoverAccess(origin);
    const settle = (p: Promise<unknown>) => p.catch(() => {});
    await settle(b.fetchSnapshot(origin));
    await settle(b.fetchRepoRoot(origin, "/tmp"));
    await settle(b.listDevices(origin));
    await settle(b.setDeviceExpiry(origin, "device", "30d"));
    await settle(b.terminalTicket(origin, "pane"));
    await settle(b.fetchCommands(origin, "codex"));
    await settle(b.fetchAgentDetail(origin, "pane", new AbortController().signal));
    await settle(b.updatePushSubscription(origin, { action: "clear" }));
    await settle(b.postAction(origin, { kind: "keys", target: "pane", keys: "enter" }));
    await settle(s.submitSession(origin, { id: "r", target: "pane", mode: "chat", text: "hi" }));
    box.startBlackBox(origin);
    window.dispatchEvent(new ErrorEvent("error", { message: "boom" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await settle(b.revokeDevice(origin, "device"));
    await b.postLogout(origin);
    a.saveCredentials(origin, { sessionToken: undefined, deviceId: undefined, deviceSecret: undefined });
    return calls;
  });
  const credentialed = result.filter((call) => call.credentialed);
  expect(new Set(credentialed.map((call) => call.path))).toEqual(
    new Set([
      "/api/login",
      "/api/devices/pairing",
      "/api/snapshot",
      "/api/repo-root",
      "/api/devices",
      "/api/devices/expiry",
      "/api/terminal-ticket",
      "/api/commands",
      "/api/agent-detail",
      "/api/push-subscription",
      "/api/action",
      "/api/submit",
      "/api/log",
      "/api/devices/revoke",
      "/api/logout",
    ]),
  );
  expect(credentialed.filter((call) => call.redirect !== "error")).toEqual([]);
});
