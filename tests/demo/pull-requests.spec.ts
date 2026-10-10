import { test, expect, isPhone } from "../fixtures";

// C9 in demo mode: the sample agents carry one pull request of each readiness.

const READINESS = [
  ["Pull request 318, ready to merge", "#318", "ready"],
  ["Pull request 482, checks or review pending", "#482", "pending"],
  ["Pull request 17, blocked by conflicts, failing checks or requested changes", "#17", "blocked"],
  ["Pull request 23, draft", "#23", "draft"],
  ["Pull request 470, merged", "#470", "merged"],
  ["Pull request 455, closed", "#455", "closed"],
] as const;

test.describe("Pull request pills in demo mode", () => {
  test("each readiness has a pill with its number, a name in words and its own state", async ({ demo }) => {
    for (const [name, text, readiness] of READINESS) {
      const link = demo.getByRole("link", { name }).last();
      await expect(link).toBeVisible();
      await expect(link).toHaveText(text);
      await expect(link).toHaveAttribute("title", name);
      await expect(link.locator("[data-readiness]")).toHaveAttribute("data-readiness", readiness);
      await expect(link).toHaveAttribute("target", "_blank");
      expect(((await link.getAttribute("rel")) ?? "").split(/\s+/).sort()).toEqual(["noopener", "noreferrer"]);
      expect(await link.getAttribute("href")).toMatch(new RegExp(`^https://github\\.com/example/[a-z-]+/pull/${text.slice(1)}$`));
    }
    // Six different states, and the colour of each is not shared with another kind.
    const tones = await Promise.all(
      READINESS.map(([name]) => demo.getByRole("link", { name }).last().locator("[data-readiness]").evaluate((element) => getComputedStyle(element).color)),
    );
    const byReadiness = new Map(READINESS.map(([, , readiness], index) => [readiness, tones[index]]));
    expect(new Set([byReadiness.get("ready"), byReadiness.get("pending"), byReadiness.get("blocked"), byReadiness.get("merged")]).size).toBe(4);
    expect(byReadiness.get("draft")).toBe(byReadiness.get("closed"));
  });

  test("a project whose agents share a PR shows it on the header; a project of several branches does not", async ({ demo }, testInfo) => {
    const postcard = demo.locator("section.project-group", { has: demo.getByRole("button", { name: "Project postcard" }) });
    // Header and card.
    await expect(postcard.getByTestId("pull-request")).toHaveCount(2);
    // The wide layout's list column has no room for it beside the name.
    const header = postcard.getByTestId("pull-request").first();
    if (isPhone(testInfo)) await expect(header).toBeVisible();
    else await expect(header).toBeHidden();
    const web = demo.locator("section.project-group", { has: demo.getByRole("button", { name: "Project web" }) });
    // Three cards on three branches, and no header pill speaking for all of them.
    await expect(web.getByTestId("pull-request")).toHaveCount(3);
    await expect(web.getByRole("link", { name: /Pull request 482/ })).toHaveCount(1);
  });

  test("a pill opens the link without opening the agent, and nothing overflows", async ({ demo, context }, testInfo) => {
    await context.route("https://github.com/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<title>fixture</title>" }));
    const link = demo.getByRole("link", { name: /^Pull request 482, / }).last();
    const opened = context.waitForEvent("page");
    await link.click();
    const popup = await opened;
    expect(popup.url()).toBe("https://github.com/example/web-app/pull/482");
    await popup.close();
    await expect(demo.getByRole("navigation", { name: "Primary" })).toBeVisible();
    if (isPhone(testInfo)) await expect(demo.getByRole("button", { name: "More actions" })).toHaveCount(0);

    const page_ = await demo.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
    expect(page_.scroll).toBeLessThanOrEqual(page_.width);
    // Every pill sits inside the card it belongs to.
    const outside = await demo.evaluate(() => {
      const bad: string[] = [];
      for (const pill of document.querySelectorAll<HTMLElement>('[data-testid="pull-request"]')) {
        const wrap = pill.parentElement!;
        const box = pill.getBoundingClientRect();
        if (!box.width) continue;
        const around = wrap.getBoundingClientRect();
        if (box.right > around.right || box.left < around.left) bad.push(pill.getAttribute("aria-label") ?? "");
      }
      return bad;
    });
    expect(outside).toEqual([]);
  });
});
