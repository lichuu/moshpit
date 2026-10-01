import { test, expect, openApp, seedHosts, loginBridge, pairBridge } from "../fixtures";

async function catalogue(page: import("@playwright/test").Page, url: string, kind: string) {
  await page.goto("/");
  const token = await loginBridge(page, url);
  const device = await pairBridge(page, url, token);
  return page.evaluate(async ({ url, kind, token, device }) => {
    const response = await fetch(`${url}/api/commands?agent=${encodeURIComponent(kind)}`, {
      headers: { authorization: `Bearer ${token}`, "x-moshpit-device": `${device.deviceId}.${device.deviceSecret}` },
    });
    if (!response.ok) throw new Error(`catalogue ${response.status}`);
    return response.json();
  }, { url, kind, token, device });
}

const skill = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`;

test.describe("skill suggestions", () => {
  test("offers the host's claude skills and inserts one without sending", async ({
    page,
    bridge,
  }) => {
    const host = await bridge({
      // A fake HOME, so the catalogue is what this spec wrote rather than
      // whatever skills happen to be installed on the machine running it.
      home: {
        ".claude/skills/deploy-thing/SKILL.md": skill("deploy-thing", "Ship it."),
        ".claude/skills/review-diff/SKILL.md": skill("review-diff", "Read the diff."),
      },
      // One claude agent, idle, with a resolved session so the composer is live.
      herdr: `
case "$*" in
  "api snapshot"*) echo '{"result":{"snapshot":{"agents":[{"pane_id":"w1:p1","agent":"claude","agent_status":"idle","cwd":"/repo/app","workspace_id":"w1","terminal_title":"claude"}]}}}' ;;
  "pane list"*)    echo '{"result":{"panes":[{"pane_id":"w1:p1","label":"builder","cwd":"/repo/app","workspace_id":"w1"}]}}' ;;
  *) echo '{}' ;;
esac`,
    });

    const body = await catalogue(page, host.url, "claude");
    // The bridge resolves the kind to a fixed directory; the client never
    // supplies a path.
    expect(body.prefix).toBe("/");
    expect(body.commands.map((c: { name: string }) => c.name).sort()).toEqual([
      "deploy-thing",
      "review-diff",
    ]);
    expect(body.commands[0].invocation.startsWith("/")).toBeTruthy();
  });

  test("a kind the bridge does not catalogue gets an empty list, not a path", async ({
    page,
    bridge,
  }) => {
    const host = await bridge({ home: { ".claude/skills/x/SKILL.md": skill("x", "d") } });

    for (const kind of ["../../etc", "unknown-agent", ""]) {
      const body = await catalogue(page, host.url, kind);
      // An unknown kind must resolve to nothing rather than being treated as
      // a directory to walk.
      expect(body.commands).toEqual([]);
      expect(body.prefix).toBe("");
    }
  });

  test("pi skills use the /skill: prefix and need a description", async ({ page, bridge }) => {
    const host = await bridge({
      home: {
        ".pi/agent/skills/with-desc/SKILL.md": skill("with-desc", "Has one."),
        // pi will not register a skill without a description, so the catalogue
        // must not offer it either.
        ".pi/agent/skills/no-desc/SKILL.md": "---\nname: no-desc\n---\n\nBody.\n",
      },
    });

    const body = await catalogue(page, host.url, "pi");
    expect(body.prefix).toBe("/skill:");
    expect(body.commands.map((c: { name: string }) => c.name)).toEqual(["with-desc"]);
    expect(body.commands[0].invocation).toBe("/skill:with-desc");
  });
});

test.describe("bridge as a saved host", () => {
  test("connects to a real bridge and lists what herdr reports", async ({ page, bridge }) => {
    const host = await bridge({
      herdr: `
case "$*" in
  "api snapshot"*) echo '{"result":{"snapshot":{"agents":[{"pane_id":"w1:p1","agent":"claude","agent_status":"idle","cwd":"/repo/app","workspace_id":"w1","terminal_title":"claude"}]}}}' ;;
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
