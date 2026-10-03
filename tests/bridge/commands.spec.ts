import path from "node:path";
import { test, expect, openApp, seedHosts, loginBridge, pairBridge, isPhone } from "../fixtures";

const skill = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`;

const CLAUDE_AGENT = {
  pane_id: "w1:p1", agent: "claude", agent_status: "idle", cwd: "/repo/app",
  workspace_id: "w1", terminal_title: "claude", agent_session: { kind: "id", value: "sess-claude" },
};
const CODEX_AGENT = {
  pane_id: "w2:p1", agent: "codex", agent_status: "idle", cwd: "/repo/app",
  workspace_id: "w2", terminal_title: "codex", agent_session: { kind: "id", value: "sess-codex" },
};
const PI_AGENT = {
  pane_id: "w3:p1", agent: "pi", agent_status: "idle", cwd: "/repo/app",
  workspace_id: "w3", terminal_title: "pi", agent_session: { kind: "path", value: "/home/user/.pi/agent/sessions/s1.jsonl" },
};
const snapshotBody = (agents: unknown[]) =>
  JSON.stringify({ result: { snapshot: { agents } } });

const CLAUDE_HERDR = `
case "$*" in
  "api snapshot"*) echo '${snapshotBody([CLAUDE_AGENT])}' ;;
  "pane list"*)    echo '{"result":{"panes":[{"pane_id":"w1:p1","label":"builder","cwd":"/repo/app","workspace_id":"w1"}]}}' ;;
  *) echo '{}' ;;
esac`;

async function request(
  page: import("@playwright/test").Page,
  url: string,
  query: string,
  token: string,
  device: { deviceId: string; deviceSecret: string },
) {
  return page.evaluate(
    async ({ url, query, token, device }) => {
      const response = await fetch(`${url}/api/commands${query}`, {
        headers: { authorization: `Bearer ${token}`, "x-moshpit-device": `${device.deviceId}.${device.deviceSecret}` },
      });
      return { status: response.status, body: (await response.json().catch(() => null)) as Record<string, unknown> | null };
    },
    { url, query, token, device },
  );
}

test.describe("scoped command discovery", () => {
  test("a scoped request returns the pane's partial catalog bound to its identity", async ({
    page,
    bridge,
  }) => {
    const host = await bridge({
      home: {
        ".claude/skills/deploy-thing/SKILL.md": skill("deploy-thing", "Ship it."),
        ".claude/skills/review-diff/SKILL.md": skill("review-diff", "Read the diff."),
      },
      herdr: CLAUDE_HERDR,
    });
    await page.goto("/");
    const token = await loginBridge(page, host.url);
    const device = await pairBridge(page, host.url, token);
    const { status, body } = await request(
      page, host.url,
      `?target=${encodeURIComponent("w1:p1")}&sessionId=${encodeURIComponent("sess-claude")}`,
      token, device,
    );
    expect(status).toBe(200);
    expect(body?.scope).toEqual({
      target: "w1:p1",
      sessionId: "sess-claude",
      project: JSON.stringify([null, "/repo/app"]),
    });
    expect(body?.coverage).toBe("partial");
    expect(body?.truncated).toBe(false);
    expect(body?.prefixes).toEqual(["/"]);
    expect(Array.isArray(body?.warnings)).toBe(true);
    expect(typeof body?.revision).toBe("string");
    expect(String(body?.revision)).toMatch(/^[0-9a-f]{64}$/);
    const commands = (body?.commands ?? []) as Array<Record<string, unknown>>;
    expect(commands.map((c) => c.name).sort()).toEqual(["deploy-thing", "review-diff"]);
    expect(commands.every((c) => c.origin === "home-skills")).toBe(true);
    expect(body?.live).toBeUndefined();
  });

  test("scoped validation refuses missing, repeated, unknown and spoofed parameters", async ({
    page,
    bridge,
  }) => {
    const host = await bridge({ home: { ".claude/skills/x/SKILL.md": skill("x", "d") }, herdr: CLAUDE_HERDR });
    await page.goto("/");
    const token = await loginBridge(page, host.url);
    const device = await pairBridge(page, host.url, token);
    const target = encodeURIComponent("w1:p1");
    const session = encodeURIComponent("sess-claude");
    for (const query of [
      `?target=${target}`,
      `?sessionId=${session}`,
      `?target=${target}&target=${target}&sessionId=${session}`,
      `?target=${target}&sessionId=${session}&agent=claude`,
      `?target=${target}&sessionId=${session}&path=/etc`,
      `?target=&sessionId=${session}`,
    ]) {
      const { status, body } = await request(page, host.url, query, token, device);
      expect(status, query).toBe(400);
      expect((body?.error as { code?: string })?.code).toBe("command_request_invalid");
    }
  });

  test("an unknown pane is a 404 and a wrong session a 409 scope change", async ({
    page,
    bridge,
  }) => {
    const host = await bridge({ home: { ".claude/skills/x/SKILL.md": skill("x", "d") }, herdr: CLAUDE_HERDR });
    await page.goto("/");
    const token = await loginBridge(page, host.url);
    const device = await pairBridge(page, host.url, token);
    const unknown = await request(
      page, host.url, `?target=${encodeURIComponent("w9:p9")}&sessionId=${encodeURIComponent("sess-claude")}`, token, device,
    );
    expect(unknown.status).toBe(404);
    expect((unknown.body?.error as { code?: string })?.code).toBe("command_target_unknown");
    const wrong = await request(
      page, host.url, `?target=${encodeURIComponent("w1:p1")}&sessionId=${encodeURIComponent("other")}`, token, device,
    );
    expect(wrong.status).toBe(409);
    expect((wrong.body?.error as { code?: string })?.code).toBe("command_scope_changed");
  });

  test("the legacy kind route keeps its shape and says partial", async ({
    page,
    bridge,
  }) => {
    const host = await bridge({
      home: { ".claude/skills/deploy-thing/SKILL.md": skill("deploy-thing", "Ship it.") },
      herdr: CLAUDE_HERDR,
    });
    await page.goto("/");
    const token = await loginBridge(page, host.url);
    const device = await pairBridge(page, host.url, token);
    const { status, body } = await request(page, host.url, `?agent=${encodeURIComponent("claude")}`, token, device);
    expect(status).toBe(200);
    expect(body?.kind).toBe("claude");
    expect(body?.prefix).toBe("/");
    expect(body?.coverage).toBe("partial");
    expect(body?.scope).toBeUndefined();
    expect(body?.revision).toBeUndefined();
    expect((body?.commands as Array<Record<string, unknown>>).map((c) => c.name)).toEqual(["deploy-thing"]);
    expect((body?.commands as Array<Record<string, unknown>>).every((c) => c.origin === undefined)).toBe(true);
  });

  test("a pi pane gets the partial disk catalog without spawning pi", async ({
    page,
    bridge,
  }) => {
    const { mkdtemp, writeFile, readFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    // A sentinel pi on PATH records any spawn: a restored Pi-discovery path
    // would touch it, so its absence proves the no-spawn contract.
    const sentinelDir = await mkdtemp(path.join(tmpdir(), "moshpit-sentinel-"));
    const marker = path.join(sentinelDir, "pi-spawned");
    await writeFile(path.join(sentinelDir, "pi"), `#!/bin/sh\ntouch ${marker}\nexit 1\n`, { mode: 0o755 });
    try {
      const host = await bridge({
        home: {
          ".pi/agent/skills/with-desc/SKILL.md": skill("with-desc", "Has one."),
          ".pi/agent/skills/no-desc/SKILL.md": "---\nname: no-desc\n---\n\nBody.\n",
        },
        herdr: `
case "$*" in
  "api snapshot"*) echo '${snapshotBody([PI_AGENT])}' ;;
  "pane list"*)    echo '{"result":{"panes":[{"pane_id":"w3:p1","label":"pi-pane","cwd":"/repo/app","workspace_id":"w3"}]}}' ;;
  *) echo '{}' ;;
esac`,
        env: { PATH: `${sentinelDir}:${process.env.PATH}` },
      });
      await page.goto("/");
      const token = await loginBridge(page, host.url);
      const device = await pairBridge(page, host.url, token);
      const { status, body } = await request(
        page, host.url,
        `?target=${encodeURIComponent("w3:p1")}&sessionId=${encodeURIComponent(PI_AGENT.agent_session.value)}`,
        token, device,
      );
      expect(status).toBe(200);
      // The disk inventory, explicitly partial: extension commands exist only
      // in a running pi, and discovery must not start one.
      expect(body?.coverage).toBe("partial");
      expect(body?.live).toBeUndefined();
      const commands = (body?.commands ?? []) as Array<Record<string, unknown>>;
      expect(commands.map((c) => c.invocation)).toEqual(["/skill:with-desc"]);
      expect(body?.scope).toEqual({
        target: "w3:p1",
        sessionId: PI_AGENT.agent_session.value,
        project: JSON.stringify([null, "/repo/app"]),
      });
      const calls = await host.calls();
      expect(calls.some((call) => call.includes("agent start"))).toBe(false);
      expect(calls.some((call) => call.includes("get_commands"))).toBe(false);
      expect(await readFile(marker, "utf8").catch(() => null)).toBeNull();
    } finally {
      await rm(sentinelDir, { recursive: true, force: true });
    }
  });

  test("a deadline during the snapshot ends the live response with 504, not a hang", async ({
    page,
    bridge,
  }) => {
    const { rm, writeFile } = await import("node:fs/promises");
    const TRIGGER = "/tmp/moshpit-e2e-commands-hang";
    await rm(TRIGGER, { force: true });
    try {
      const host = await bridge({
        home: { ".claude/skills/x/SKILL.md": skill("x", "d") },
        herdr: `
if [ -f ${TRIGGER} ] && [ "$1 $2" = "api snapshot" ]; then exec sleep 30; fi
case "$*" in
  "api snapshot"*) echo '${snapshotBody([CLAUDE_AGENT])}' ;;
  "pane list"*)    echo '{"result":{"panes":[]}}' ;;
  *) echo '{}' ;;
esac`,
        env: { MOSHPIT_POLL_MS: "60000" },
      });
      await page.goto("/");
      const token = await loginBridge(page, host.url);
      const device = await pairBridge(page, host.url, token);
      await writeFile(TRIGGER, "x");
      const startedAt = Date.now();
      const { status, body } = await request(
        page, host.url,
        `?target=${encodeURIComponent("w1:p1")}&sessionId=${encodeURIComponent("sess-claude")}`,
        token, device,
      );
      expect(status).toBe(504);
      expect((body?.error as { code?: string })?.code).toBe("scan_stopped");
      expect(Date.now() - startedAt).toBeLessThan(10_000);
    } finally {
      await rm(TRIGGER, { force: true });
    }
  });

  test("two panes of the same kind keep separate scopes", async ({
    page,
    bridge,
  }) => {
    const host = await bridge({
      home: { ".claude/skills/deploy-thing/SKILL.md": skill("deploy-thing", "Ship it.") },
      herdr: `
case "$*" in
  "api snapshot"*) echo '${snapshotBody([
    { ...CLAUDE_AGENT, cwd: "/repo/a" },
    { ...CLAUDE_AGENT, pane_id: "w2:p1", agent_session: { kind: "id", value: "sess-b" }, cwd: "/repo/b" },
  ])}' ;;
  "pane list"*)    echo '{"result":{"panes":[]}}' ;;
  *) echo '{}' ;;
esac`,
    });
    await page.goto("/");
    const token = await loginBridge(page, host.url);
    const device = await pairBridge(page, host.url, token);
    const crossed = await request(
      page, host.url, `?target=${encodeURIComponent("w2:p1")}&sessionId=${encodeURIComponent("sess-claude")}`, token, device,
    );
    expect(crossed.status).toBe(409);
    const own = await request(
      page, host.url, `?target=${encodeURIComponent("w2:p1")}&sessionId=${encodeURIComponent("sess-b")}`, token, device,
    );
    expect(own.status).toBe(200);
    expect((own.body?.scope as { project?: string })?.project).toBe(JSON.stringify([null, "/repo/b"]));
  });

  test("a hung directory read ends the live route at the shared deadline", async ({
    page,
    bridge,
  }) => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const work = await mkdtemp(path.join(tmpdir(), "moshpit-s8-hung-"));
    const preload = path.join(work, "hung-directory.mjs");
    // The bridge child's HOME is the fixture's fake home; hang the reads of
    // its skills directory so the route's scanner waits on a stalled fs op.
    await writeFile(
      preload,
      `import { Dir } from "node:fs";
import path from "node:path";
const marker = path.join(process.env.HOME ?? "", ".claude", "skills");
const nativeRead = Dir.prototype.read;
const nativeIterator = Dir.prototype[Symbol.asyncIterator];
Dir.prototype.read = function (callback) {
  if (this.path !== marker) return nativeRead.apply(this, arguments);
  if (typeof callback === "function") return;
  return new Promise(() => {});
};
Dir.prototype[Symbol.asyncIterator] = function () {
  if (this.path !== marker) return nativeIterator.call(this);
  return { next: () => new Promise(() => {}) };
};
`,
    );
    const host = await bridge({
      home: { ".claude/skills/ok/SKILL.md": skill("ok", "Fine.") },
      herdr: CLAUDE_HERDR,
      env: { NODE_OPTIONS: `--import=${preload}`, MOSHPIT_POLL_MS: "3600000" },
    });
    try {
      await page.goto("/");
      const token = await loginBridge(page, host.url);
      const device = await pairBridge(page, host.url, token);
      const started = Date.now();
      const { status, body } = await request(
        page, host.url,
        `?target=${encodeURIComponent("w1:p1")}&sessionId=${encodeURIComponent("sess-claude")}`,
        token, device,
      );
      const elapsed = Date.now() - started;
      expect(status).toBe(504);
      expect((body?.error as { code?: string })?.code).toBe("scan_stopped");
      expect(elapsed).toBeLessThan(4000);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
});

test.describe("composer discovery", () => {
  const TRIGGER = "/tmp/moshpit-e2e-commands-trigger";

  const twoAgentHerdr = (body: string) => `
case "$*" in
  "api snapshot"*) ${body} ;;
  "pane list"*)    echo '{"result":{"panes":[]}}' ;;
  *) echo '{}' ;;
esac`;

  async function connect(page: import("@playwright/test").Page, host: { url: string }) {
    await openApp(page, { demo: false });
    const token = await loginBridge(page, host.url);
    await pairBridge(page, host.url, token);
    await seedHosts(
      page,
      [{
        id: "e2e", label: "E2E", transport: "tailscale", user: "",
        hostname: "127.0.0.1", port: new URL(host.url).port, demo: false, tailnetUrl: host.url,
      }],
      "e2e",
    );
  }

  // Phones return to the list through Back; wide layouts keep the list
  // beside the detail, so the next agent is selected directly.
  async function switchTo(page: import("@playwright/test").Page, testInfo: import("@playwright/test").TestInfo, name: RegExp) {
    if (isPhone(testInfo)) await page.getByRole("button", { name: "Back", exact: true }).click();
    await page.getByRole("button", { name }).first().click();
  }

  test("a late response from the previous agent never lands on the new one", async ({
    page,
    bridge,
  }, testInfo) => {
    const host = await bridge({
      home: { ".claude/skills/deploy-thing/SKILL.md": skill("deploy-thing", "Ship it.") },
      herdr: twoAgentHerdr(`sleep 0.4; echo '${snapshotBody([CLAUDE_AGENT, CODEX_AGENT])}'`),
      env: { MOSHPIT_POLL_MS: "60000" },
    });
    // Wide layouts open the first agent's detail as soon as the snapshot
    // lands, so the initial scoped read can start inside connect; the wait
    // is armed before connect to catch it either way.
    const initialRequest = page.waitForRequest((request) => request.url().includes("/api/commands"));
    await connect(page, host);
    const listbox = page.getByRole("listbox", { name: "Command suggestions" });
    const prompt = page.getByPlaceholder("Message this agent…");

    await page.getByRole("button", { name: /^claude/ }).first().click({ timeout: 20_000 });
    await prompt.waitFor({ state: "visible", timeout: 20_000 });
    await initialRequest;
    await switchTo(page, testInfo, /^codex/);
    await prompt.waitFor({ state: "visible", timeout: 20_000 });
    await prompt.fill("/");
    await expect(page.getByRole("status").filter({ hasText: "Commands may be incomplete." })).toBeVisible({ timeout: 15_000 });
    await expect(listbox.getByRole("option", { name: /deploy-thing/ })).toHaveCount(0);
    await expect(listbox.getByRole("option", { name: /^\/model/ })).toBeVisible();
  });

  test("failed discovery shows Retry and keeps manual input usable", async ({
    page,
    bridge,
  }, testInfo) => {
    const { rm, writeFile } = await import("node:fs/promises");
    await rm(TRIGGER, { force: true });
    const host = await bridge({
      home: { ".claude/skills/deploy-thing/SKILL.md": skill("deploy-thing", "Ship it.") },
      herdr: twoAgentHerdr(
        `if [ -f ${TRIGGER} ]; then echo 'not json'; else echo '${snapshotBody([CLAUDE_AGENT, CODEX_AGENT])}'; fi`,
      ),
      env: { MOSHPIT_POLL_MS: "60000" },
    });
    try {
      await connect(page, host);
      const prompt = page.getByPlaceholder("Message this agent…");
      const listbox = page.getByRole("listbox", { name: "Command suggestions" });

      await page.getByRole("button", { name: /^claude/ }).first().click({ timeout: 20_000 });
      await prompt.waitFor({ state: "visible", timeout: 20_000 });
      await prompt.fill("/");
      await expect(listbox.getByRole("option", { name: /deploy-thing/ })).toBeVisible({ timeout: 10_000 });

      await writeFile(TRIGGER, "x");
      await switchTo(page, testInfo, /^codex/);
      await prompt.waitFor({ state: "visible", timeout: 20_000 });
      const failure = page.getByRole("status").filter({ hasText: "Could not load commands" });
      await expect(failure).toBeVisible({ timeout: 10_000 });
      const retry = page.getByRole("button", { name: "Retry", exact: true });
      await expect(retry).toBeVisible();
      await prompt.fill("type / anyway");
      await expect(prompt).toHaveValue("type / anyway");

      await rm(TRIGGER, { force: true });
      await retry.click();
      await expect(prompt).toHaveValue("type / anyway");
      await expect(page.getByRole("status").filter({ hasText: "Commands may be incomplete." })).toBeVisible({ timeout: 15_000 });
      await expect(failure).toHaveCount(0);
      await expect(prompt).toHaveValue("type / anyway");
      await prompt.fill("/");
      await expect(listbox).toBeVisible();
      await expect(listbox.getByRole("option", { name: /^\/model/ })).toBeVisible();
    } finally {
      await rm(TRIGGER, { force: true });
    }
  });

  test("a held tap after a scope change inserts nothing", async ({
    page,
    bridge,
  }) => {
    const { rm, writeFile } = await import("node:fs/promises");
    const DRIFT = "/tmp/moshpit-e2e-commands-drift";
    await rm(DRIFT, { force: true });
    const drifted = { ...CLAUDE_AGENT, cwd: "/repo/other" };
    const host = await bridge({
      home: { ".claude/skills/deploy-thing/SKILL.md": skill("deploy-thing", "Ship it.") },
      herdr: `
case "$*" in
  "api snapshot"*)
    if [ -f ${DRIFT} ]; then echo '${snapshotBody([drifted])}'; else echo '${snapshotBody([CLAUDE_AGENT])}'; fi ;;
  "pane list"*)    echo '{"result":{"panes":[]}}' ;;
  *) echo '{}' ;;
esac`,
      env: { MOSHPIT_POLL_MS: "300" },
    });
    try {
      let commandsSeen = 0;
      const secondScoped = page.waitForRequest((request) => {
        if (!request.url().includes("/api/commands")) return false;
        commandsSeen += 1;
        return commandsSeen >= 2;
      });
      await connect(page, host);
      const prompt = page.getByPlaceholder("Message this agent…");
      const listbox = page.getByRole("listbox", { name: "Command suggestions" });
      const sends: string[] = [];
      page.on("request", (request) => {
        if (request.method() === "POST" && /\/api\/(submit|action)$/.test(request.url())) sends.push(request.url());
      });

      await page.getByRole("button", { name: /^claude/ }).first().click({ timeout: 20_000 });
      await prompt.waitFor({ state: "visible", timeout: 20_000 });
      await prompt.fill("/");
      await expect(listbox).toBeVisible({ timeout: 15_000 });
      const option = listbox.getByRole("option").first();
      const box = await option.boundingBox();
      if (!box) throw new Error("first option is not visible");
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await writeFile(DRIFT, "x");
      // The drift lands in the store and starts a fresh scoped read before
      // the pointer is released.
      await secondScoped;
      await page.mouse.up();
      await expect(prompt).toHaveValue("/");
      expect(sends).toEqual([]);
    } finally {
      await rm(DRIFT, { force: true });
    }
  });

  test("the ninth result is reachable by keyboard and touch without sending", async ({
    page,
    bridge,
  }, testInfo) => {
    const host = await bridge({
      home: { ".claude/skills/deploy-thing/SKILL.md": skill("deploy-thing", "Ship it.") },
      herdr: twoAgentHerdr(`echo '${snapshotBody([CLAUDE_AGENT])}'`),
      env: { MOSHPIT_POLL_MS: "60000" },
    });
    await connect(page, host);
    const sends: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && /\/api\/(submit|action)$/.test(request.url())) sends.push(request.url());
    });
    const listbox = page.getByRole("listbox", { name: "Command suggestions" });
    const prompt = page.getByPlaceholder("Message this agent…");
    await page.getByRole("button", { name: /^claude/ }).first().click({ timeout: 20_000 });
    await prompt.waitFor({ state: "visible", timeout: 20_000 });
    await prompt.fill("/");
    await expect(listbox).toBeVisible({ timeout: 15_000 });
    const options = listbox.getByRole("option");
    expect(await options.count()).toBeGreaterThan(8);
    const ninth = (await options.nth(8).getAttribute("aria-label")) ?? "";
    expect(ninth).toBeTruthy();
    for (let i = 0; i < 8; i += 1) await prompt.press("ArrowDown");
    await expect(listbox.getByRole("option", { selected: true })).toHaveAttribute("aria-label", ninth);
    await prompt.press("Enter");
    await expect(prompt).toHaveValue(`${ninth.split(":")[0]} `);
    expect(sends).toEqual([]);
    await prompt.fill("/");
    await expect(listbox).toBeVisible({ timeout: 15_000 });
    const target = options.nth(8);
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    if (!box) throw new Error("ninth option is not visible");
    if (isPhone(testInfo)) await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    else await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(prompt).toHaveValue(`${ninth.split(":")[0]} `);
    expect(sends).toEqual([]);
  });

  test("an unsupported kind shows the unavailable state, not a failure", async ({
    page,
    bridge,
  }) => {
    const GEMINI_AGENT = {
      pane_id: "w4:p1", agent: "gemini", agent_status: "idle", cwd: "/repo/app",
      workspace_id: "w4", terminal_title: "gemini", agent_session: { kind: "id", value: "sess-gemini" },
    };
    const host = await bridge({
      herdr: twoAgentHerdr(`echo '${snapshotBody([GEMINI_AGENT])}'`),
      env: { MOSHPIT_POLL_MS: "60000" },
    });
    await connect(page, host);
    const prompt = page.getByPlaceholder("Message this agent…");
    await page.getByRole("button", { name: /^gemini/ }).first().click({ timeout: 20_000 });
    await prompt.waitFor({ state: "visible", timeout: 20_000 });
    const unavailable = page.getByRole("status").filter({ hasText: "Command discovery is unavailable for this agent." });
    await expect(unavailable).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
    await prompt.fill("type anyway");
    await expect(prompt).toHaveValue("type anyway");
  });
});

test.describe("bridge as a saved host", () => {
  test("connects to a real bridge and lists what herdr reports", async ({ page, bridge }) => {
    const host = await bridge({
      herdr: `
case "$*" in
  "api snapshot"*) echo '${snapshotBody([CLAUDE_AGENT])}' ;;
  "pane list"*)    echo '{"result":{"panes":[{"pane_id":"w1:p1","label":"builder","cwd":"/repo/app","workspace_id":"w1"}]}}' ;;
  *) echo '{}' ;;
esac`,
    });

    await openApp(page, { demo: false });
    const token = await loginBridge(page, host.url);
    await pairBridge(page, host.url, token);
    await seedHosts(
      page,
      [
        {
          id: "e2e",
          label: "E2E",
          transport: "tailscale",
          user: "",
          hostname: "127.0.0.1",
          port: host.port,
          demo: false,
          tailnetUrl: host.url,
        },
      ],
      "e2e",
    );

    // The pane label is what herdr reports, and it is what the list shows.
    await expect(page.getByText("builder").first()).toBeVisible({ timeout: 20_000 });
    expect(await host.calls()).toContain("api snapshot");
  });
});
