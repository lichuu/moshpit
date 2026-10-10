import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { test, expect } from "@playwright/test";
import { ROOT } from "../fixtures";

// The worker has no DOM, so its push handler runs here against a stand-in
// for the worker scope, with the payloads the bridge sends at each privacy
// level. Viewport is irrelevant, so run once.
test.beforeEach(async ({}, testInfo) => {
  test.skip(testInfo.project.name !== "phone", "worker specs are viewport-independent");
});

type Shown = { title: string; options: { body: string; tag: string; requireInteraction: boolean; data: { url: string; agent?: string } } };

/** Delivers one push message to the worker and returns the notification it showed, if any. */
async function pushed(message: unknown, raw?: string): Promise<Shown | null> {
  const listeners: Record<string, (event: unknown) => void> = {};
  const shown: Shown[] = [];
  const scope = {
    addEventListener: (type: string, listener: (event: unknown) => void) => { listeners[type] = listener; },
    registration: { showNotification: (title: string, options: Shown["options"]) => { shown.push({ title, options }); return Promise.resolve(); } },
    location: { origin: "https://moshpit.example" },
  };
  vm.runInNewContext(readFileSync(path.join(ROOT, "public/sw.js"), "utf8"), { self: scope, URL, Response, caches: {} });
  const waiting: Promise<unknown>[] = [];
  listeners["push"]({
    data: { json: () => (raw === undefined ? message : JSON.parse(raw)) },
    waitUntil: (promise: Promise<unknown>) => waiting.push(promise),
  });
  await Promise.all(waiting);
  return shown[0] ?? null;
}

const URL_OF = "/?tab=steer&agent=w1%3Ap2";

test("full shows the agent's name and what it needs", async () => {
  const shown = await pushed({ type: "block", agent: "w1:p2", name: "refactor-auth", prompt: "Allow the build step?", url: URL_OF });
  expect(shown?.title).toBe("refactor-auth");
  expect(shown?.options.body).toBe("Allow the build step?");
  expect(shown?.options.data).toEqual({ url: URL_OF, agent: "w1:p2" });
});

test("name only shows the name with the generic line, and opens the agent", async () => {
  const blocked = await pushed({ type: "block", agent: "w1:p2", name: "refactor-auth", url: URL_OF });
  expect(blocked?.title).toBe("refactor-auth");
  expect(blocked?.options.body).toBe("An agent is blocked.");
  expect(blocked?.options.requireInteraction).toBe(true);
  expect(blocked?.options.data.url).toBe(URL_OF);
  const finished = await pushed({ type: "turn", agent: "w1:p2", name: "refactor-auth", url: URL_OF });
  expect(finished?.title).toBe("refactor-auth");
  expect(finished?.options.body).toBe("An agent finished its turn.");
});

test("generic shows only the generic line under the app's name", async () => {
  const blocked = await pushed({ type: "block", url: URL_OF });
  expect(blocked?.title).toBe("moshpit");
  expect(blocked?.options.body).toBe("An agent is blocked.");
  expect(blocked?.options.data).toEqual({ url: URL_OF, agent: undefined });
  const other = await pushed({ type: "block", url: "/?tab=steer&agent=w1%3Ap3" });
  expect(other?.options.tag, "two agents stay two notifications").not.toBe(blocked?.options.tag);
  const finished = await pushed({ type: "turn", url: URL_OF });
  expect(finished?.title).toBe("moshpit");
  expect(finished?.options.body).toBe("An agent finished its turn.");
});

test("a missing, empty or malformed field never shows as undefined or an empty title", async () => {
  for (const message of [
    { type: "block" },
    { type: "block", name: "", prompt: "", agent: "", url: "" },
    { type: "block", name: "   ", prompt: null, agent: 7, url: 3 },
    { type: "turn", name: {}, prompt: [] },
  ]) {
    const shown = await pushed(message);
    expect(shown, JSON.stringify(message)).not.toBeNull();
    expect(shown?.title).toBe("moshpit");
    expect(`${shown?.title} ${shown?.options.body} ${shown?.options.tag}`).not.toMatch(/undefined|null|\[object/);
    expect(shown?.options.body).toMatch(/^An agent (is blocked|finished its turn)\.$/);
    expect(shown?.options.data.url).toBe("/");
  }
});

test("a message that is not a block or a finished turn shows nothing", async () => {
  expect(await pushed({ type: "other", name: "x" })).toBeNull();
  expect(await pushed(undefined, "not json")).toBeNull();
});
