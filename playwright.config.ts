import { defineConfig, devices } from "@playwright/test";

// The suite drives the production build, not the dev server: the app ships as
// dist/spa and the bridge serves exactly those files, so a check that passed
// against `vite dev` would not prove much. The build is fast enough (~300ms)
// to run on every invocation.
const PORT = Number(process.env.MOSHPIT_TEST_PORT ?? 4173);
// A couple of specs exercise modules rather than the UI — drafts.ts needs a
// real IndexedDB, so it has to run in a browser, and it has to be imported
// from source. Those get the dev server; everything else uses the build.
export const DEV_PORT = Number(process.env.MOSHPIT_DEV_PORT ?? 5174);
export const DEV_URL = `http://127.0.0.1:${DEV_PORT}`;

export default defineConfig({
  testDir: "./tests",
  // Every spec gets its own browser context, so they cannot leak state through
  // localStorage — which matters here because hosts, settings and snippets all
  // persist there.
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  // GitHub's hosted runners for public repositories have four CPUs.
  workers: process.env.CI ? 4 : undefined,
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    ...(["firefox", "webkit"] as const).map((browserName) => ({
      name: `security-${browserName}`,
      testMatch: "bridge/security.spec.ts",
      use: { browserName },
    })),
    // V1 claims host lifecycle across engines, not only the origin boundary:
    // login, pairing and revocation, switching, reconnect, incompatible-client
    // recovery, the terminal's states and paste, and Chat reading. These run
    // the same specs as the desktop project in Firefox and WebKit.
    ...(["firefox", "webkit"] as const).map((browserName) => ({
      name: `lifecycle-${browserName}`,
      // Most of these start and pair a real bridge before they measure
      // anything. They all land on one CI shard beside two heavier engines,
      // where that setup alone ran past the 30 s default.
      timeout: 60_000,
      testMatch: [
        "demo/hosts.spec.ts",
        "bridge/connect-intent.spec.ts",
        "bridge/terminal-surface.spec.ts",
        "bridge/terminal-live.spec.ts",
        "bridge/terminal-typing.spec.ts",
        "bridge/chat-answer.spec.ts",
        "bridge/chat-reading.spec.ts",
      ],
      // WebKit sends a service-worker-controlled page's requests through the
      // worker, where page.route cannot see them: every stubbed bridge call
      // went to the real network (a fake *.ts.net host failed DNS). None of
      // these specs tests the worker; pwa.spec.ts does, in Chromium.
      use: { browserName, viewport: { width: 1280, height: 800 }, serviceWorkers: "block" as const },
    })),
    {
      // The release target is phone-first, and the layout bugs live here: the
      // rename input collapsing to 0px only reproduced at this width.
      name: "phone",
      use: {
        ...devices["iPhone 13"],
        browserName: "chromium",
        // devices["iPhone 13"] asks for WebKit; the viewport and touch flags
        // are what matter, and pinning the engine keeps CI to one download.
        defaultBrowserType: "chromium",
      },
    },
    {
      name: "desktop",
      use: { browserName: "chromium", viewport: { width: 1280, height: 800 } },
    },
  ],
  webServer: [
    {
      command: `npm run build && npx vite preview --port ${PORT} --strictPort`,
      url: `http://127.0.0.1:${PORT}/`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      command: `npx vite --port ${DEV_PORT} --strictPort`,
      url: `${DEV_URL}/`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: "ignore",
      stderr: "pipe",
    },
  ],
});
