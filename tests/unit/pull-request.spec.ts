import { test, expect } from "@playwright/test";
import { DEV_URL } from "../../playwright.config";

// C9: the client takes the bridge's pull request as it comes and refuses
// anything malformed. Imports from source, so it runs against the dev server.

const MODULE = "/src/lib/moshpit/pull-request.ts";

test.beforeEach(async ({}, testInfo) => {
  test.skip(testInfo.project.name !== "phone", "module specs are viewport-independent");
});

const GOOD = { number: 12, readiness: "ready", url: "https://github.com/example/web-app/pull/12" };

async function evaluate<T>(page: import("@playwright/test").Page, run: string, input: unknown): Promise<T> {
  await page.goto(`${DEV_URL}/`);
  return page.evaluate(
    async ([mod, run, input]) => {
      const lib = await import(mod as string);
      return new Function("lib", "input", `return ${run as string}`)(lib, input);
    },
    [MODULE, run, input] as const,
  ) as Promise<T>;
}

test("no field, no pull request", async ({ page }) => {
  const result = await evaluate<unknown[]>(page, "[lib.pullRequestOf({}) ?? null, lib.pullRequestOf({ pullRequest: undefined }) ?? null, lib.pullRequestOf({ pullRequest: null }) ?? null]", null);
  expect(result).toEqual([null, null, null]);
});

test("a good pull request passes through and is worded", async ({ page }) => {
  const result = await evaluate<{ pr: unknown; label: string }>(page, "({ pr: lib.pullRequestOf({ pullRequest: input }), label: lib.pullRequestLabel(input) })", GOOD);
  expect(result.pr).toEqual(GOOD);
  expect(result.label).toBe("Pull request 12, ready to merge");
});

test("malformed or unsafe pull requests are refused", async ({ page }) => {
  const bad = [
    { ...GOOD, number: 0 },
    { ...GOOD, number: 1.5 },
    { ...GOOD, number: "12" },
    { ...GOOD, readiness: "great" },
    { ...GOOD, readiness: "toString" },
    { ...GOOD, url: "javascript:alert(1)" },
    { ...GOOD, url: "http://github.com/example/web-app/pull/12" },
    { ...GOOD, url: "https://evil.example/example/web-app/pull/12" },
    { ...GOOD, url: "https://github.com.evil.example/example/web-app/pull/12" },
    { ...GOOD, url: "https://user:pass@github.com/example/web-app/pull/12" },
    { ...GOOD, url: "https://github.com/example/web-app/pull/13" },
    { ...GOOD, url: "https://github.com/example/web-app/pull/12?x=1" },
    { ...GOOD, url: "https://github.com/example/web-app/issues/12" },
    "12",
    7,
  ];
  const result = await evaluate<unknown[]>(page, "input.map((pullRequest) => lib.pullRequestOf({ pullRequest }) ?? null)", bad);
  expect(result).toEqual(bad.map(() => null));
});

test("a project header speaks only for a pull request every agent shares", async ({ page }) => {
  const other = { number: 13, readiness: "pending", url: "https://github.com/example/web-app/pull/13" };
  const result = await evaluate<unknown[]>(
    page,
    "[lib.sharedPullRequest([{ pullRequest: input.good }, { pullRequest: input.good }]), lib.sharedPullRequest([{ pullRequest: input.good }, { pullRequest: input.other }]), lib.sharedPullRequest([{ pullRequest: input.good }, {}]), lib.sharedPullRequest([])].map((value) => value ?? null)",
    { good: GOOD, other },
  );
  expect(result).toEqual([GOOD, null, null, null]);
});
