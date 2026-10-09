import { readFileSync } from "node:fs";
import { test, expect, agentAction } from "../fixtures";

async function openTerminal(page: import("@playwright/test").Page, agent = "migrate") {
  await page.getByText(agent, { exact: true }).first().click();
  await page.getByRole("button", { name: "Terminal view" }).click();
  await expect(page.getByRole("application", { name: /^Pane / })).toBeVisible();
}

test.describe("terminal key bar", () => {
  test("sends shift+tab to the focused pane", async ({ demo }) => {
    await openTerminal(demo);
    const key = demo.getByRole("button", { name: "shift+tab", exact: true });
    await expect(key).toBeVisible();

    const pane = demo.getByRole("application", { name: /^Pane / });
    const before = await pane.getByText(/\[shift\+tab\]/).count();
    await key.click();
    // Count inside the pane: on desktop the list stays mounted and the same
    // line also appears as lastOutput on the card.
    await expect(pane.getByText(/\[shift\+tab\]/)).toHaveCount(before + 1);
  });
});

test.describe("terminal commands", () => {
  test("the key-bar / opens the agent's commands, and picking one inserts without sending", async ({ demo }) => {
    await openTerminal(demo, "auth-rewrite");
    const pane = demo.getByRole("application", { name: /^Pane / });
    await demo.locator(".terminal-keys").getByRole("button", { name: "Insert slash command" }).click();

    const input = demo.getByRole("textbox", { name: "Terminal input" });
    await expect(input).toHaveValue("/");
    const list = demo.getByRole("listbox", { name: "Command suggestions" });
    await expect(list).toBeVisible();
    // Every match is listed, not the first eight.
    expect(await list.getByRole("option").count()).toBeGreaterThan(8);

    await input.pressSequentially("comp");
    await list.getByRole("option", { name: /^\/compact/ }).click();
    await expect(input).toHaveValue("/compact ");
    await expect(pane).not.toContainText("> /compact");

    await demo.getByRole("button", { name: "Send", exact: true }).click();
    await expect(pane).toContainText("> /compact");
  });

  test("the ninth result is reachable by keyboard and inserts without sending", async ({ demo }) => {
    await openTerminal(demo, "auth-rewrite");
    const pane = demo.getByRole("application", { name: /^Pane / });
    await demo.locator(".terminal-keys").getByRole("button", { name: "Insert slash command" }).click();
    const input = demo.getByRole("textbox", { name: "Terminal input" });
    const list = demo.getByRole("listbox", { name: "Command suggestions" });
    await expect(list).toBeVisible();
    const options = list.getByRole("option");
    expect(await options.count()).toBeGreaterThan(8);
    const ninth = (await options.nth(8).getAttribute("aria-label")) ?? "";
    expect(ninth).toBeTruthy();
    for (let i = 0; i < 8; i += 1) await input.press("ArrowDown");
    const selected = list.getByRole("option", { selected: true });
    await expect(selected).toHaveCount(1);
    await expect(selected).toHaveAttribute("aria-label", ninth);
    await input.press("Enter");
    await expect(input).toHaveValue(`${ninth.split(":")[0]} `);
    await expect(pane).not.toContainText(ninth.split(":")[0]);
  });

  test("codex lists / built-ins beside its $ skills", async ({ demo }) => {
    await openTerminal(demo, "migrate");
    const input = demo.getByRole("textbox", { name: "Terminal input" });
    await input.fill("/mod");
    const list = demo.getByRole("listbox", { name: "Command suggestions" });
    await expect(list.getByRole("option", { name: /^\/model/ })).toBeVisible();
    await expect(list.getByText("built-in").first()).toBeVisible();
  });
});

test.describe("terminal quick replies", () => {
  test("sit in the key bar beside Aa and send from a popover", async ({ demo }) => {
    await openTerminal(demo);
    const keys = demo.locator(".terminal-keys");
    const button = keys.getByRole("button", { name: "Quick replies" });
    await expect(button).toBeVisible();
    // No full-width row between the key bar and the input any more.
    await expect(demo.locator("summary").filter({ hasText: "Quick replies" })).toHaveCount(0);

    await button.click();
    const menu = demo.getByRole("region", { name: "Quick replies" });
    await menu.getByRole("button", { name: "continue", exact: true }).click();
    const pane = demo.getByRole("application", { name: /^Pane / });
    await expect(pane).toContainText("> continue");
    // One-shot: the popover closes once a reply is sent.
    await expect(menu).toBeHidden();
  });
});

test.describe("terminal display options", () => {
  test("wraps long rows to the pane and remembers the choice", async ({ demo }) => {
    await openTerminal(demo);
    const pane = demo.getByRole("application", { name: /^Pane / });
    const options = demo.getByRole("button", { name: "Display options" });
    await options.click();
    const toggle = demo.getByRole("button", { name: "Wrap long lines" });
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(pane.locator("pre")).toHaveCSS("white-space", "pre");

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(pane.locator("pre")).toHaveCSS("white-space", "pre-wrap");
    // Wrapped, nothing is left to pan to.
    await expect
      .poll(() => pane.evaluate((el) => el.scrollWidth - el.clientWidth))
      .toBeLessThanOrEqual(1);

    // Escape closes the popover without sending esc to the pane.
    const before = await pane.getByText(/\[esc\]/).count();
    await demo.keyboard.press("Escape");
    await expect(toggle).toBeHidden();
    await expect(pane.getByText(/\[esc\]/)).toHaveCount(before);

    await demo.reload();
    await openTerminal(demo);
    await demo.getByRole("button", { name: "Display options" }).click();
    await expect(demo.getByRole("button", { name: "Wrap long lines" })).toHaveAttribute("aria-pressed", "true");
  });

  test("sets the text size and closes on an outside tap", async ({ demo }) => {
    await openTerminal(demo);
    const pre = demo.getByRole("application", { name: /^Pane / }).locator("pre");
    await demo.getByRole("button", { name: "Display options" }).click();
    await demo.getByRole("button", { name: "Text size L" }).click();
    await expect(pre).toHaveCSS("font-size", "16px");
    await expect(demo.getByRole("button", { name: "Text size L" })).toHaveAttribute("aria-pressed", "true");
    await demo.getByRole("button", { name: "Terminal view" }).click();
    await expect(demo.getByRole("button", { name: "Text size L" })).toBeHidden();
  });

  test("the key strip leads with the keys reached for most", async ({ demo }) => {
    await openTerminal(demo);
    const labels = await demo
      .locator(".terminal-keys button")
      .evaluateAll((els) => els.slice(0, 3).map((el) => el.textContent));
    expect(labels).toEqual(["esc", "⌫", "^C"]);
  });
});

test.describe("terminal scroll", () => {
  test("opens on the bottom rows and follows new output until you scroll up", async ({ demo }) => {
    await openTerminal(demo);
    const pane = demo.getByRole("application", { name: /^Pane / });
    // Large text so the rows outgrow the pane at every viewport.
    await demo.getByRole("button", { name: "Display options" }).click();
    await demo.getByRole("button", { name: "Text size L" }).click();
    await demo.keyboard.press("Escape");
    await demo.setViewportSize({ width: 390, height: 520 });

    const gap = () => pane.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
    await expect.poll(() => pane.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    const key = demo.locator(".terminal-keys").getByRole("button", { name: "esc", exact: true });
    await key.click();
    await expect.poll(gap).toBeLessThanOrEqual(1);

    // Reading back: new output must not yank the view down.
    await pane.evaluate((el) => { el.scrollTop = 0; el.dispatchEvent(new Event("scroll")); });
    await key.click();
    await expect(pane.getByText("[esc]")).toHaveCount(2);
    expect(await pane.evaluate((el) => el.scrollTop)).toBe(0);
  });
});

test.describe("compact terminal composer", () => {
  test("an attached image leaves the input its full row", async ({ demo }) => {
    await openTerminal(demo);
    await demo.setViewportSize({ width: 390, height: 450 });
    await expect(demo.locator("html")).toHaveAttribute("data-compact", "true");

    const input = demo.getByRole("textbox", { name: "Terminal input" });
    const width = async () => (await input.boundingBox())?.width ?? 0;
    const bare = await width();
    // A portrait phone stacks the actions under the input, as Chat does.
    expect(bare).toBeGreaterThan(300);
    await demo.locator('input[type="file"][accept="image/*"]').setInputFiles({
      name: "Screenshot 2026-01-01 at 10.00.00.png",
      mimeType: "image/png",
      buffer: readFileSync(new URL("../fixtures/tiny.png", import.meta.url)),
    });
    await expect(demo.getByRole("button", { name: "Remove image" })).toBeVisible();
    expect(await width()).toBe(bare);
  });

  test("a long draft grows past two lines while the pane and Send stay on screen", async ({ demo }) => {
    await openTerminal(demo);
    await demo.setViewportSize({ width: 390, height: 500 });
    await expect(demo.locator("html")).toHaveAttribute("data-compact", "true");

    const input = demo.getByRole("textbox", { name: "Terminal input" });
    await input.fill("one two three four five six seven eight nine ten ".repeat(6));
    const pane = demo.getByRole("application", { name: /^Pane / });
    const send = demo.getByRole("button", { name: "Send", exact: true });
    await expect.poll(async () => (await input.boundingBox())?.height ?? 0).toBeGreaterThan(60);
    const row = await pane.locator("pre > div").first().boundingBox();
    expect((await pane.boundingBox())!.height).toBeGreaterThanOrEqual(2 * row!.height - 1);
    const sendBox = (await send.boundingBox())!;
    expect(sendBox.y + sendBox.height).toBeLessThanOrEqual(500);
  });
});

test.describe("terminal prefix", () => {
  test("the configured prefix is what the hint shows", async ({ demo }) => {
    await demo.getByRole("button", { name: /hosts/i }).first().click();
    const preset = demo.getByRole("button", { name: "Set prefix ctrl plus a" });
    await expect(preset).toBeVisible();
    await preset.click();

    await demo.getByRole("button", { name: /moshpit/i }).first().click();
    await openTerminal(demo);
    // The key bar has to follow the setting: a stale prefix tells you to press
    // a key combination that will not do anything. It renders ctrl+x as ^X.
    await expect(demo.getByRole("button", { name: "^A", exact: true })).toBeVisible();
  });
});

test.describe("links view", () => {
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });

  test("collects URLs the pane printed, and never previews them", async ({ demo }) => {
    const external: string[] = [];
    demo.on("request", (request) => {
      const { hostname } = new URL(request.url());
      if (!hostname.includes("127.0.0.1") && !hostname.includes("localhost")) {
        external.push(request.url());
      }
    });

    // Links are gathered only while the terminal is mounted, and only this
    // seeded agent prints one.
    await openTerminal(demo, "tailscale-docs");
    await demo.getByRole("button", { name: "Links view" }).click();

    const list = demo.getByRole("list", { name: "Terminal links" });
    await expect(list).toBeVisible();
    const links = list.getByRole("link");
    await expect(links.first()).toBeVisible();

    // Deduplicated: the same URL printed twice is one row.
    const hrefs = await links.evaluateAll((nodes) =>
      nodes.map((n) => (n as HTMLAnchorElement).href),
    );
    expect(new Set(hrefs).size).toBe(hrefs.length);

    // Opening is an explicit tap in a new tab, and nothing is fetched for a
    // preview — that would leak the URL to whatever it points at.
    await expect(links.first()).toHaveAttribute("target", "_blank");
    await expect(links.first()).toHaveAttribute("rel", /noopener/);
    expect(external, "the links view must not fetch anything").toEqual([]);
  });

  test("copies a link", async ({ demo }) => {
    await openTerminal(demo, "tailscale-docs");
    await demo.getByRole("button", { name: "Links view" }).click();
    const first = demo.getByRole("list", { name: "Terminal links" }).getByRole("link").first();
    const href = await first.getAttribute("href");

    await demo.getByRole("button", { name: `Copy ${href}` }).click();
    await expect(demo.getByText("Link copied")).toBeVisible();
  });

  test("says so when the pane has printed nothing", async ({ demo }) => {
    // A fresh agent whose seeded output carries no URLs.
    await demo.getByText("auth-rewrite", { exact: true }).first().click();
    await demo.getByRole("button", { name: "Links view" }).click();
    await expect(demo.getByText("no links")).toBeVisible();
  });
});

test.describe("companion shell", () => {
  test("opens a shell, echoes input, and closes it", async ({ demo }) => {
    await demo.getByText("migrate", { exact: true }).first().click();
    await (await agentAction(demo, "Open shell here")).click();

    // A shell borrows the terminal, but must be labelled as itself so input is
    // never mistaken for the coding agent's session.
    await expect(demo.getByText("companion shell").first()).toBeVisible();
    await expect(demo.getByRole("application", { name: /^Shell pane / })).toBeVisible();
    await demo.getByRole("button", { name: "Quick replies" }).click();
    const quickReplies = demo.getByRole("region", { name: "Quick replies" });
    await expect(quickReplies.getByRole("button", { name: "y", exact: true })).toBeVisible();
    await expect(quickReplies.getByRole("button", { name: "n", exact: true })).toBeVisible();
    await expect(quickReplies.getByRole("button", { name: "continue", exact: true })).toHaveCount(0);

    const input = demo.getByPlaceholder("Type or dictate terminal input");
    await input.click();
    await input.fill("echo hi");
    await demo.getByRole("button", { name: "Send" }).click();
    await expect(demo.getByText("demo shell ran it")).toBeVisible();

    await demo.getByRole("button", { name: "Close shell" }).click();
    const confirm = demo.getByRole("alertdialog");
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "Close shell" }).click();
    await expect(demo.getByText("companion shell")).toHaveCount(0);
  });
});
