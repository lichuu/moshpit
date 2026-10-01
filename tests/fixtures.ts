import { test as base, type BrowserContext, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const BRIDGE_PASSWORD = "e2e-password";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** An ephemeral free port, so specs can run in parallel without colliding. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error("no port"))));
    });
  });
}

/**
 * Clicks through onboarding into demo mode.
 *
 * Twenty-five of the old helper scripts open-coded this, which is why a change
 * to the onboarding copy used to mean editing twenty-five files.
 */
export async function openApp(page: Page, { demo = true } = {}) {
  await page.goto(demo ? "/?demo=1" : "/", { waitUntil: "networkidle" });
  for (let step = 0; step < 2; step += 1) {
    await page.getByRole("button", { name: "Next", exact: true }).click();
  }
  await page.getByRole("button", { name: "Open moshpit" }).click();
  await page.getByRole("navigation", { name: "Primary" }).waitFor();
}

export const openDemo = (page: Page) => openApp(page, { demo: true });

/** The persist key the store writes to. */
export const STORE_KEY = "moshpit-v1";

/**
 * Counts notification permission prompts and push subscriptions in every
 * page of the context. Permission reads as granted, so a push registration
 * that ignored the notify setting would reach subscribe and be counted.
 * Read the count with `permissionPrompts(page)`.
 */
export async function countPermissionPrompts(context: BrowserContext) {
  await context.addInitScript(() => {
    const counts = { requestPermission: 0, subscribe: 0 };
    Object.defineProperty(window, "__prompts", { value: counts });
    if (typeof Notification !== "undefined") {
      Object.defineProperty(Notification, "permission", { get: () => "granted" });
      Notification.requestPermission = async () => {
        counts.requestPermission += 1;
        return "granted";
      };
    }
    if (typeof PushManager !== "undefined") {
      PushManager.prototype.subscribe = async function () {
        counts.subscribe += 1;
        throw new Error("subscribe is stubbed");
      };
    }
  });
}

export const permissionPrompts = (page: Page) =>
  page.evaluate(() => (window as unknown as { __prompts: { requestPermission: number; subscribe: number } }).__prompts);

/**
 * Replaces the saved host list and reloads. Hosts live in local storage, so a
 * spec that wants a specific host has to write one before the app boots.
 */
export async function seedHosts(
  page: Page,
  hosts: unknown[],
  connectedHostId: string | null = null,
) {
  await page.evaluate(
    ({ key, hosts, connectedHostId }) => {
      const raw = JSON.parse(localStorage.getItem(key) ?? "{}");
      raw.state = { ...raw.state, hosts, connectedHostId };
      localStorage.setItem(key, JSON.stringify(raw));
    },
    { key: STORE_KEY, hosts, connectedHostId },
  );
  await page.reload({ waitUntil: "networkidle" });
}

/**
 * Answers a bridge origin without a real bridge. "live" is a healthy door,
 * "not-bridge" answers but is not one, and "dead" refuses the connection.
 */
export async function stubDoor(
  page: Page,
  origin: string,
  behavior: "live" | "not-bridge" | "dead" | "down" = "live",
) {
  await page.route(`${origin}/**`, (route) => {
    if (behavior === "dead") return route.abort();
    const { pathname } = new URL(route.request().url());
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    // /api/vapid is the probe that decides "is this a bridge at all"; every
    // other path decides "is the bridge working". The three failure messages
    // come from different combinations, so they must be stubbed separately.
    if (pathname === "/api/vapid") {
      return behavior === "not-bridge" ? json({}, 404) : json({ publicKey: "x" });
    }
    if (behavior !== "live") return json({ error: "down" }, 502);
    if (pathname === "/api/pair") return json({ deviceId: "d" });
    if (pathname === "/api/snapshot")
      return json({ hostId: "test", herdrRunning: true, agents: [], kinds: [] });
    return json({});
  });
}

export async function loginBridge(page: Page, url: string) {
  return page.evaluate(async ({ url, password }) => {
    const response = await fetch(`${url}/api/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (!response.ok) throw new Error(`login ${response.status}`);
    const { token } = await response.json();
    return token as string;
  }, { url, password: BRIDGE_PASSWORD });
}

/** The state directory of each running fixture bridge, keyed by its URL. */
const stateDirs = new Map<string, string>();

type AdminEnvelope = { result?: unknown; error?: { code: string; message: string } };
type AdminClient = { sendAdminRequest: (message: object, options: { stateDir: string }) => Promise<AdminEnvelope> };

/** One request to a fixture bridge's private admin socket, as an operator on the host would send it. */
export async function adminRequest(url: string, message: object): Promise<unknown> {
  const stateDir = stateDirs.get(url);
  if (!stateDir) throw new Error(`no fixture bridge is running at ${url}`);
  // A computed specifier keeps TypeScript from demanding types for the .mjs.
  const adminModule = pathToFileURL(path.join(ROOT, "bridge/admin.mjs")).href;
  const { sendAdminRequest } = (await import(adminModule)) as AdminClient;
  const answer = await sendAdminRequest(message, { stateDir });
  if (answer.error) throw new Error(`admin ${JSON.stringify(answer.error)}`);
  return answer.result;
}

/** A single-use pairing grant from the admin socket. Identity alone cannot mint one. */
export async function issueGrant(url: string, name = "e2e"): Promise<string> {
  return ((await adminRequest(url, { action: "pair", name })) as { secret: string }).secret;
}

/**
 * Issues a grant, then redeems it in the page and stores the per-origin
 * credentials.
 */
export async function pairBridge(page: Page, url: string, token: string): Promise<{ deviceId: string; deviceSecret: string }> {
  const secret = await issueGrant(url);
  return page.evaluate(async ({ url, token, secret }) => {
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const paired = await fetch(`${url}/api/devices/pairing`, { method: "POST", headers, body: JSON.stringify({ secret, name: "e2e" }) });
    if (!paired.ok) throw new Error(`pairing ${paired.status}`);
    const body = await paired.json() as { deviceId: string; deviceSecret: string; expiresAt: number };
    const origin = new URL(url).origin;
    localStorage.setItem(origin, JSON.stringify({
      ...JSON.parse(localStorage.getItem(origin) ?? "{}"),
      deviceId: body.deviceId, deviceSecret: body.deviceSecret, sessionToken: token, deviceExpiresAt: body.expiresAt,
    }));
    return { deviceId: body.deviceId, deviceSecret: body.deviceSecret };
  }, { url, token, secret });
}

export type BridgeOptions = {
  /**
   * Body of a fake herdr executable. It receives the herdr subcommand in "$@"
   * and must print JSON on stdout — the bridge shells out to it for every
   * pane read and write, so each spec stubs only the calls it needs.
   */
  herdr?: string;
  /** Overrides the fixture's environment; undefined removes a variable. */
  env?: Record<string, string | undefined>;
  /**
   * Files to write into a fake HOME, keyed by path relative to it. The skills
   * catalogue reads os.homedir(), so without this a spec would assert against
   * whatever happens to be installed on the machine running it.
   */
  home?: Record<string, string>;
};

export type Bridge = {
  url: string;
  port: number;
  /** Temp directory holding the bridge state dir, herdr stub and logs. */
  dir: string;
  /** The fake HOME, when one was requested. */
  home?: string;
  /** Lines the fake herdr recorded, for asserting what the bridge asked for. */
  calls: () => Promise<string[]>;
  stderr: () => Promise<string>;
};

const DEFAULT_HERDR = `echo '{}'`;

async function startBridge(options: BridgeOptions = {}): Promise<[Bridge, () => Promise<void>]> {
  const dir = await mkdtemp(path.join(tmpdir(), "moshpit-e2e-"));
  const binDir = path.join(dir, "bin");
  await mkdir(binDir, { recursive: true });
  const callLog = path.join(dir, "herdr-calls.log");
  const herdrBin = path.join(binDir, "herdr");
  await writeFile(
    herdrBin,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(callLog)}\n${options.herdr ?? DEFAULT_HERDR}\n`,
    { mode: 0o700 },
  );

  let home: string | undefined;
  if (options.home) {
    home = path.join(dir, "home");
    for (const [relative, contents] of Object.entries(options.home)) {
      const file = path.join(home, relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, contents);
    }
  }

  const port = await freePort();
  const passwordFile = path.join(dir, "bridge-password");
  await writeFile(passwordFile, BRIDGE_PASSWORD, { mode: 0o600 });
  const errFile = path.join(dir, "bridge.err");
  const child: ChildProcess = spawn(process.execPath, [path.join(ROOT, "bridge/index.mjs")], {
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("MOSHPIT_"))),
      MOSHPIT_PORT: String(port),
      MOSHPIT_BIND: "127.0.0.1",
      MOSHPIT_AUTH_MODE: "password",
      MOSHPIT_PASSWORD_FILE: passwordFile,
      MOSHPIT_PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
      MOSHPIT_ALLOWED_AUTHORITIES: `127.0.0.1:${port}`,
      MOSHPIT_ALLOWED_ORIGINS: `http://127.0.0.1:${process.env.MOSHPIT_TEST_PORT ?? 4173},http://127.0.0.1:${process.env.MOSHPIT_DEV_PORT ?? 5174}`,
      MOSHPIT_DEV_INSECURE: "1",
      MOSHPIT_STATE_DIR: path.join(dir, "state"),
      MOSHPIT_HERDR_BIN: herdrBin,
      ...(home ? { HOME: home } : {}),
      ...options.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const errors: Buffer[] = [];
  child.stderr?.on("data", (chunk: Buffer) => errors.push(chunk));

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`bridge exited early (${child.exitCode}): ${Buffer.concat(errors)}`);
    }
    try {
      // Any answer means the listener is up; /api/ is gated on the trusted
      // header, so a 401 here is a healthy bridge, not a failure.
      await fetch(`${url}/api/snapshot`);
      break;
    } catch {
      if (Date.now() > deadline) throw new Error(`bridge never listened on ${port}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  const bridge: Bridge = {
    url,
    port,
    dir,
    home,
    calls: async () => {
      try {
        return (await readFile(callLog, "utf8")).split("\n").filter(Boolean);
      } catch {
        return [];
      }
    },
    stderr: async () => {
      try {
        return await readFile(errFile, "utf8");
      } catch {
        return Buffer.concat(errors).toString("utf8");
      }
    },
  };

  stateDirs.set(url, path.join(dir, "state"));
  return [
    bridge,
    async () => {
      stateDirs.delete(url);
      child.kill();
      await exited;
      await rm(dir, { recursive: true, force: true });
    },
  ];
}

export const test = base.extend<{
  /** A page already through onboarding and into the seeded demo herd. */
  demo: Page;
  /** Starts an isolated bridge with a disposable state dir and stubbed herdr. */
  bridge: (options?: BridgeOptions) => Promise<Bridge>;
}>({
  demo: async ({ page }, use) => {
    await openDemo(page);
    await use(page);
  },
  bridge: async ({}, use) => {
    const stops: Array<() => Promise<void>> = [];
    await use(async (options) => {
      const [handle, stop] = await startBridge(options);
      stops.push(stop);
      return handle;
    });
    for (const stop of stops) await stop().catch(() => {});
  },
});

/**
 * Layout differs by project, and the difference is a feature: phones get
 * bottom navigation and a Back button inside each agent, while wider layouts
 * show the list and the detail pane together and have no Back.
 */
export function isPhone(testInfo: { project: { name: string } }) {
  return testInfo.project.name === "phone";
}

/**
 * The agent header's Shell, Rename and Close buttons. Phones keep them behind
 * a "More actions" menu so the agent's name has room; wide layouts show them
 * inline.
 */
export async function agentAction(
  page: import("@playwright/test").Page,
  name: string,
) {
  const more = page.getByRole("button", { name: "More actions" });
  if (await more.isVisible() && (await more.getAttribute("aria-expanded")) !== "true") {
    await more.click();
  }
  return page.getByRole("button", { name });
}

export { expect } from "@playwright/test";
