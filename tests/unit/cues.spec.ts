import { test, expect } from "@playwright/test";
import { DEV_URL } from "../../playwright.config";

// C8: which cue a snapshot earns is a pure rule, checked here without a host
// or a browser audio stack. Like the other module specs this imports from
// source, so it runs against the dev server.

const CUES = "/src/lib/moshpit/cues.ts";

test.beforeEach(async ({}, testInfo) => {
  test.skip(testInfo.project.name !== "phone", "module specs are viewport-independent");
});

type Row = [string, string];
type Case = { prior: Row[] | null; next: Row[]; open?: string[]; onScreen?: string[] };

async function cueFor(page: import("@playwright/test").Page, cases: Case[]) {
  await page.goto(`${DEV_URL}/`);
  return page.evaluate(
    async ([mod, cases]) => {
      const { cueTransition } = await import(mod as string);
      const agents = (rows: [string, string][]) => rows.map(([id, status]) => ({ id, status }));
      return (cases as Case[]).map((c) =>
        cueTransition(
          c.prior && agents(c.prior),
          agents(c.next),
          new Set(c.open ?? []),
          (id: string) => (c.onScreen ?? []).includes(id),
        ),
      );
    },
    [CUES, cases] as const,
  );
}

test.describe("cue transitions", () => {
  test("the first snapshot of a connection is never a transition", async ({ page }) => {
    const [first] = await cueFor(page, [
      { prior: null, next: [["a", "blocked"], ["b", "idle"]] },
    ]);
    expect(first).toBeNull();
  });

  test("a new block cues, a block the Inbox already holds does not", async ({ page }) => {
    const [fresh, appeared, known, stays] = await cueFor(page, [
      { prior: [["a", "working"]], next: [["a", "blocked"]] },
      { prior: [["a", "working"]], next: [["a", "working"], ["b", "blocked"]] },
      { prior: [["a", "working"]], next: [["a", "blocked"]], open: ["a"] },
      { prior: [["a", "blocked"]], next: [["a", "blocked"]] },
    ]);
    expect(fresh).toBe("blocked");
    expect(appeared, "an agent that shows up already blocked is new").toBe("blocked");
    expect(known).toBeNull();
    expect(stays, "still blocked is not a new block, even with no row yet").toBeNull();
  });

  test("a finish is working to idle or done, and nothing else", async ({ page }) => {
    const [idle, done, fromIdle, stillWorking, appeared] = await cueFor(page, [
      { prior: [["a", "working"]], next: [["a", "idle"]] },
      { prior: [["a", "working"]], next: [["a", "done"]] },
      { prior: [["a", "idle"]], next: [["a", "done"]] },
      { prior: [["a", "working"]], next: [["a", "working"]] },
      { prior: [], next: [["a", "idle"]] },
    ]);
    expect(idle).toBe("finished");
    expect(done).toBe("finished");
    expect(fromIdle).toBeNull();
    expect(stillWorking).toBeNull();
    expect(appeared).toBeNull();
  });

  test("an agent on screen does not cue when it finishes, but still does when it blocks", async ({ page }) => {
    const [finished, otherFinished, blocked] = await cueFor(page, [
      { prior: [["a", "working"]], next: [["a", "idle"]], onScreen: ["a"] },
      { prior: [["a", "working"], ["b", "working"]], next: [["a", "idle"], ["b", "idle"]], onScreen: ["a"] },
      { prior: [["a", "working"]], next: [["a", "blocked"]], onScreen: ["a"] },
    ]);
    expect(finished).toBeNull();
    expect(otherFinished).toBe("finished");
    expect(blocked).toBe("blocked");
  });

  test("several transitions are one cue, blocked first", async ({ page }) => {
    const [both, twoFinished] = await cueFor(page, [
      { prior: [["a", "working"], ["b", "working"]], next: [["a", "idle"], ["b", "blocked"]] },
      { prior: [["a", "working"], ["b", "working"]], next: [["a", "done"], ["b", "idle"]] },
    ]);
    expect(both).toBe("blocked");
    expect(twoFinished).toBe("finished");
  });
});
