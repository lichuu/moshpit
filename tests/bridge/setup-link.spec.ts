import type { BrowserContext, Page } from "@playwright/test";
import { adminRequest, countPermissionPrompts, expect, issueGrant, permissionPrompts, seedHosts, STORE_KEY, test, type Bridge, type BridgeOptions } from "../fixtures";

// The app as the bridge serves it, in tailscale mode, with the login header
// Serve would add. A setup link only ever opens on the origin that printed it.

const OWNER = "dana@example.com";
const TAILSCALE: BridgeOptions = {
  env: { MOSHPIT_AUTH_MODE: "tailscale", MOSHPIT_TRUSTED_USER: OWNER, MOSHPIT_PASSWORD_FILE: undefined },
};

type Seen = { url: string; headers: Record<string, string>; body: string | null };

/** Every request the browser makes, the service worker's included, with its headers and body. */
function recordRequests(context: BrowserContext) {
  const seen: Promise<Seen>[] = [];
  context.on("request", (request) => {
    // A long-lived stream's full headers may never settle; its provisional
    // ones still hold everything the page set.
    const provisional = new Promise<Record<string, string>>((resolve) => setTimeout(() => resolve(request.headers()), 2000));
    const headers = Promise.race([request.allHeaders().catch(() => request.headers()), provisional]);
    seen.push(headers.then((headers) => ({ url: request.url(), headers, body: request.postData() })));
  });
  return () => Promise.all(seen);
}

async function servedBy(page: Page, bridge: (options?: BridgeOptions) => Promise<Bridge>) {
  const host = await bridge(TAILSCALE);
  await page.context().setExtraHTTPHeaders({ "Tailscale-User-Login": OWNER });
  return host;
}

const pairings = (seen: Seen[]) => seen.filter((request) => new URL(request.url).pathname === "/api/devices/pairing");

async function devices(url: string) {
  return (await adminRequest(url, { action: "devices" })) as { name: string; active: boolean }[];
}

/** Opens a setup link, checks the confirmation names this machine and account, and approves. */
async function approveLink(page: Page, host: Bridge, secret: string, path = "/") {
  await page.goto(`${host.url}${path}#moshpit-setup=${secret}`);
  await expect(page.getByRole("heading", { name: "Approve this browser?" })).toBeVisible();
  await expect(page.getByLabel("Machine")).toHaveText(new URL(host.url).host);
  await expect(page.getByLabel("Tailscale account")).toHaveText(OWNER);
  await page.getByRole("button", { name: "Approve", exact: true }).click();
}

test("a setup link approves this browser, skips onboarding, opens the herd and leaves the secret nowhere", async ({ page, bridge }) => {
  const host = await servedBy(page, bridge);
  const requests = recordRequests(page.context());
  const secret = await issueGrant(host.url, "First browser");

  await approveLink(page, host, secret, "/?from=setup");
  await expect(page.getByRole("heading", { name: "No agents yet." })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Primary" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Next", exact: true })).toHaveCount(0);
  await expect(page).toHaveURL(`${host.url}/?from=setup`);

  const approved = await devices(host.url);
  expect(approved).toHaveLength(1);
  expect(approved[0].active).toBe(true);
  expect(approved[0].name).toMatch(/ on /);

  const stored = await page.evaluate((key) => ({
    local: Object.fromEntries(Object.entries(localStorage)),
    session: Object.fromEntries(Object.entries(sessionStorage)),
    onboarded: JSON.parse(localStorage.getItem(key) ?? "{}").state?.onboarded,
    history: history.length,
  }), STORE_KEY);
  const credential = JSON.parse(stored.local[host.url] ?? "{}");
  expect(credential.deviceId).toEqual(expect.any(String));
  expect(credential.deviceSecret).toEqual(expect.any(String));
  expect(stored.onboarded).toBe(true);
  expect(JSON.stringify([stored.local, stored.session])).not.toContain(secret);

  // The Hosts tab shows the serving origin, attached.
  await page.getByRole("button", { name: /hosts/i }).first().click();
  await expect(page.getByText(new URL(host.url).hostname).first()).toBeVisible();

  const seen = await requests();
  expect(pairings(seen)).toHaveLength(1);
  expect(JSON.parse(pairings(seen)[0].body ?? "{}").secret).toBe(secret);
  for (const request of seen) {
    expect(request.url, "no URL carries the secret").not.toContain(secret);
    expect(JSON.stringify(request.headers), `no header of ${request.url} carries the secret`).not.toContain(secret);
    if (request !== pairings(seen)[0]) expect(request.body ?? "", `no other body carries the secret: ${request.url}`).not.toContain(secret);
  }
});

test("the confirmation names the machine and this browser's own account, and nothing is redeemed before Approve", async ({ page, bridge }) => {
  const host = await servedBy(page, bridge);
  const requests = recordRequests(page.context());
  const secret = await issueGrant(host.url);
  await page.goto(`${host.url}/#moshpit-setup=${secret}`);
  await expect(page.getByRole("heading", { name: "Approve this browser?" })).toBeVisible();
  await expect(page.getByLabel("Machine")).toHaveText(new URL(host.url).host);
  await expect(page.getByLabel("Tailscale account")).toHaveText(OWNER);
  await page.waitForLoadState("networkidle");
  expect(pairings(await requests()), "no redemption while the person decides").toHaveLength(0);
  const storage = await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]));
  expect(storage, "the waiting capability is in memory only").not.toContain(secret);
  expect(await devices(host.url)).toHaveLength(0);
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByRole("heading", { name: "No agents yet." })).toBeVisible();
  expect(pairings(await requests())).toHaveLength(1);
});

test("Cancel discards the link without redeeming it and goes to Hosts", async ({ page, bridge }) => {
  const host = await servedBy(page, bridge);
  const requests = recordRequests(page.context());
  await page.goto(`${host.url}/#moshpit-setup=${await issueGrant(host.url)}`);
  await expect(page.getByLabel("Tailscale account")).toHaveText(OWNER);
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText("Setup link cancelled")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Hosts", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect", exact: true })).toBeVisible();
  await page.waitForTimeout(1000);
  expect(pairings(await requests())).toHaveLength(0);
  expect(await devices(host.url)).toHaveLength(0);
});

test("a reload during the confirmation drops the link, and reopening the app later lands on a normal screen", async ({ page, bridge }) => {
  const host = await servedBy(page, bridge);
  const requests = recordRequests(page.context());
  await page.goto(`${host.url}/#moshpit-setup=${await issueGrant(host.url)}`);
  await expect(page.getByLabel("Tailscale account")).toHaveText(OWNER);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Approve this browser?" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Open the setup link again." })).toHaveCount(0);
  const reopened = await page.context().newPage();
  await reopened.goto(`${host.url}/`);
  await expect(reopened.getByRole("heading", { name: "Approve this browser?" })).toHaveCount(0);
  await expect(reopened.getByRole("heading", { name: "Open the setup link again." })).toHaveCount(0);
  await expect(reopened.getByRole("heading", { name: "Attach a host to see who’s blocked." })).toBeVisible();
  expect(pairings(await requests())).toHaveLength(0);
  expect(await devices(host.url)).toHaveLength(0);
});

test("a setup link never asks for notification permission or subscribes to push until notifications are turned on", async ({ page, bridge }) => {
  const host = await servedBy(page, bridge);
  await countPermissionPrompts(page.context());
  await approveLink(page, host, await issueGrant(host.url));
  await expect(page.getByRole("heading", { name: "No agents yet." })).toBeVisible();
  await page.getByRole("button", { name: /hosts/i }).first().click();
  await expect(page.getByRole("button", { name: "Disconnect" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(await permissionPrompts(page)).toEqual({ requestPermission: 0, subscribe: 0 });

  // The stub counts: turning notifications on asks once, then subscribes.
  await page.getByRole("checkbox", { name: "Notify when an agent blocks" }).check();
  await expect.poll(() => permissionPrompts(page)).toEqual({ requestPermission: 1, subscribe: 1 });
});

test("an empty herd reads as connected with how to start an agent, and an unreachable host does not", async ({ page, bridge }) => {
  const host = await servedBy(page, bridge);
  await approveLink(page, host, await issueGrant(host.url));
  await expect(page.getByRole("heading", { name: "No agents yet." })).toBeVisible();
  await expect(page.getByText(`Connected to ${new URL(host.url).hostname}`)).toBeVisible();
  await expect(page.getByText(/Start one in herdr on the host: run herdr, open a pane in your project, and start your coding agent there/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Waiting for your herd." })).toHaveCount(0);

  // The host stops answering: the poll fails and the copy says so.
  await page.context().route(`${host.url}/api/snapshot*`, (route) => route.abort("connectionrefused"));
  await expect(page.getByRole("heading", { name: "Waiting for your herd." })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "No agents yet." })).toHaveCount(0);

  // A reload remembers the host and its approval, but no snapshot arrives.
  await page.context().unrouteAll();
  await page.context().route(`${host.url}/api/snapshot*`, () => {});
  await page.reload();
  await expect(page.getByRole("heading", { name: "Waiting for your herd." })).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(page.getByRole("heading", { name: "No agents yet." })).toHaveCount(0);
});

test("a reload after redemption, or the same link opened again, never redeems twice", async ({ page, bridge }) => {
  const host = await servedBy(page, bridge);
  const requests = recordRequests(page.context());
  const secret = await issueGrant(host.url);
  await approveLink(page, host, secret);
  await expect(page.getByRole("heading", { name: "No agents yet." })).toBeVisible();
  expect(pairings(await requests())).toHaveLength(1);

  await page.reload();
  await expect(page.getByRole("heading", { name: "No agents yet." })).toBeVisible();
  // An approved browser opening a link keeps its approval and discards the capability.
  const second = await issueGrant(host.url);
  const checked = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/devices");
  await page.goto(`${host.url}/#moshpit-setup=${second}`);
  expect((await checked).status(), "the stored approval is checked, and holds").toBe(200);
  await expect(page.getByRole("heading", { name: "No agents yet." })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Approve this browser?" }), "an approved browser is not asked again").toHaveCount(0);
  await expect(page).toHaveURL(`${host.url}/`);
  expect(pairings(await requests())).toHaveLength(1);
  expect(await devices(host.url)).toHaveLength(1);
});

test("a browser whose device was revoked re-enrolls from a fresh link on the first try", async ({ page, bridge }) => {
  const host = await servedBy(page, bridge);
  const requests = recordRequests(page.context());
  await approveLink(page, host, await issueGrant(host.url));
  await expect(page.getByRole("heading", { name: "No agents yet." })).toBeVisible();
  const [first] = (await adminRequest(host.url, { action: "devices" })) as { id: string }[];
  await adminRequest(host.url, { action: "revoke", deviceId: first.id });

  await page.goto("about:blank");
  await approveLink(page, host, await issueGrant(host.url));
  await expect(page.getByRole("heading", { name: "No agents yet." })).toBeVisible();
  await expect.poll(async () => (await devices(host.url)).filter((device) => device.active).length).toBe(1);
  expect(pairings(await requests())).toHaveLength(2);
  const credential = await page.evaluate((url) => JSON.parse(localStorage.getItem(url) ?? "{}"), host.url);
  expect(credential.deviceId).not.toBe(first.id);
});

test("a used link and an unknown one each say why on Hosts, without showing the secret, and are not retried", async ({ page, bridge, request }) => {
  const host = await servedBy(page, bridge);
  const used = await issueGrant(host.url);
  const redeemed = await request.post(`${host.url}/api/devices/pairing`, {
    headers: { "Tailscale-User-Login": OWNER, Origin: host.url },
    data: { secret: used },
  });
  expect(redeemed.status()).toBe(200);
  const reasons: [string, string, string][] = [
    [used, "Setup link not accepted", "This setup link was already used."],
    // A secret the bridge never issued gets no reason at all, so a browser cannot probe for secrets.
    ["AAAAAAAAAAAAAAAAAAAAAA", "Setup link not accepted", "This setup link is not valid"],
  ];
  for (const [secret, title, detail] of reasons) {
    const requests = recordRequests(page.context());
    await approveLink(page, host, secret);
    const alert = page.getByRole("alert");
    await expect(alert).toContainText(title);
    await expect(alert).toContainText(detail);
    await expect(alert).toContainText("Run moshpit setup on the host for a new link.");
    await expect(page.getByRole("button", { name: "Next", exact: true })).toHaveCount(0);
    await expect(page).toHaveURL(`${host.url}/`);
    expect(await page.content()).not.toContain(secret);
    await page.waitForTimeout(1500);
    expect(pairings(await requests()), "no automatic retry").toHaveLength(1);
  }
  expect(await devices(host.url)).toHaveLength(1);
});

// The reasons a real bridge cannot be made to give on demand (its grant lasts
// five minutes, and identity is checked before the owner), answered with the
// codes the bridge sends, and a host that does not answer at all.
const REFUSED_BY_HOST: { name: string; answer: "abort" | { status: number; code: string; message: string }; title: string; detail: string }[] = [
  { name: "expired", answer: { status: 403, code: "pairing_grant_expired", message: "expired" }, title: "Setup link not accepted", detail: "This setup link expired." },
  {
    name: "wrong owner",
    answer: { status: 403, code: "pairing_grant_wrong_owner", message: "wrong owner" },
    title: "Setup link not accepted",
    detail: "made for a different Tailscale account",
  },
  {
    name: "request budget exhausted",
    answer: { status: 429, code: "pairing_rate_limited", message: "limited" },
    title: "Setup link not accepted",
    detail: "too many times in a minute",
  },
  { name: "host unreachable", answer: "abort", title: "Could not reach the host", detail: "still valid until it expires" },
];

for (const { name, answer, title, detail } of REFUSED_BY_HOST) {
  test(`a setup link refused as ${name} says so on Hosts, and never shows the secret`, async ({ page, bridge }) => {
    const host = await servedBy(page, bridge);
    const secret = await issueGrant(host.url);
    await page.route(`${host.url}/api/devices/pairing`, (route) =>
      answer === "abort"
        ? route.abort("connectionrefused")
        : route.fulfill({ status: answer.status, json: { error: { code: answer.code, message: answer.message } } }),
    );
    await approveLink(page, host, secret);
    const alert = page.getByRole("alert");
    await expect(alert).toContainText(title);
    await expect(alert).toContainText(detail);
    await expect(alert).not.toContainText(OWNER);
    expect(await page.content()).not.toContain(secret);
    expect(await devices(host.url)).toHaveLength(0);
  });
}

test("a fragment that is not a setup link is left alone", async ({ page, bridge }) => {
  const host = await servedBy(page, bridge);
  const requests = recordRequests(page.context());
  await page.goto(`${host.url}/#moshpit-setup`);
  await expect(page.getByRole("button", { name: "Next", exact: true })).toBeVisible();
  expect(new URL(page.url()).hash).toBe("#moshpit-setup");
  await page.goto(`${host.url}/?tab=hosts#section-2`);
  await expect(page.getByRole("button", { name: "Next", exact: true })).toBeVisible();
  expect(new URL(page.url()).hash).toBe("#section-2");
  await page.waitForLoadState("networkidle");
  expect(pairings(await requests())).toHaveLength(0);
});

test("the secret goes only to the serving origin, even with another host saved and connected", async ({ page, bridge }) => {
  const host = await servedBy(page, bridge);
  const OTHER = "https://other.example.test";
  const toOther: string[] = [];
  await page.context().route(`${OTHER}/**`, (route) => {
    toOther.push(`${route.request().url()} ${route.request().postData() ?? ""}`);
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ protocol: 2, requiredFactors: [] }) });
  });
  await page.goto(`${host.url}/`);
  await seedHosts(page, [{ id: "other", label: "Other", transport: "tailscale", user: "", hostname: "other.example.test", port: 443, tailnetUrl: OTHER, demo: false }], "other");
  const requests = recordRequests(page.context());
  const secret = await issueGrant(host.url);
  await approveLink(page, host, secret);
  await expect(page.getByRole("heading", { name: "No agents yet." })).toBeVisible();
  expect(await devices(host.url)).toHaveLength(1);
  expect(pairings(await requests()).map((request) => new URL(request.url).origin)).toEqual([host.url]);
  expect(toOther.join("\n")).not.toContain(secret);
  const saved = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "{}").state, STORE_KEY);
  expect(saved.hosts.map((entry: { tailnetUrl: string }) => entry.tailnetUrl)).toEqual([OTHER, host.url]);
  expect(saved.connectedHostId).not.toBe("other");
});
