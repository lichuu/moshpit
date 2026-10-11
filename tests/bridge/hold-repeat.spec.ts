import type { Locator, Page } from "@playwright/test";
import { test, expect, openApp, seedHosts, loginBridge, pairBridge, type Bridge } from "../fixtures";

// C19: holding an arrow or Backspace repeats it through the pane's key queue.
// The keys request is answered by the test, so what the page sent is read off
// the wire and a request can be held open, and the clock is fake, so 400 ms
// and 83 ms are exact. A key sent on release would show up as one extra key.

const herdr = `
case "$*" in
  "api snapshot"*) echo '{"result":{"snapshot":{"agents":[{"pane_id":"w1:p1","agent":"codex","agent_status":"idle","cwd":"/repo/app","workspace_id":"w1","terminal_title":"codex","agent_session":{"kind":"id","value":"s1"},"revision":1}]}}}' ;;
  "pane list"*) echo '{"result":{"panes":[{"pane_id":"w1:p1","label":"alpha","terminal_id":"term_a","cwd":"/repo/app","workspace_id":"w1"}]}}' ;;
  "pane read w1:p1"*) printf 'ALPHA-MENU model\\n> gpt-5\\n' ;;
  *) echo '{}' ;;
esac`;

type Wire = {
  /** Every key sent so far, in the order it arrived. */
  keys: string[];
  /** Keys per request. */
  requests: string[][];
  sessionIds: unknown[];
  /** Answer the next requests with a failure. */
  fail: boolean;
  /** Holds every request open until `open()` is called. */
  hold: () => void;
  open: () => void;
};

async function watchKeys(page: Page, host: Bridge): Promise<Wire> {
  let gate: Promise<void> | null = null;
  let release = () => {};
  const wire: Wire = {
    keys: [], requests: [], sessionIds: [], fail: false,
    hold: () => { gate = new Promise<void>((resolve) => { release = resolve; }); },
    open: () => { gate = null; release(); },
  };
  await page.route(`${host.url}/api/action`, async (route) => {
    const body = route.request().postDataJSON() as { kind: string; keys?: (string | { text: string })[]; sessionId?: unknown };
    if (body.kind !== "keys") return route.continue();
    const batch = (body.keys ?? []).map((key) => (typeof key === "string" ? key : key.text));
    wire.requests.push(batch);
    wire.keys.push(...batch);
    wire.sessionIds.push(body.sessionId);
    await gate;
    if (wire.fail) return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "boom", message: "nope" } }) });
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  return wire;
}

async function connect(page: Page, host: Bridge) {
  await openApp(page, { demo: false });
  const token = await loginBridge(page, host.url);
  await pairBridge(page, host.url, token);
  await seedHosts(page, [{ id: "e2e", label: "E2E", transport: "tailscale", user: "", hostname: "127.0.0.1", port: host.port, demo: false, tailnetUrl: host.url }], "e2e");
  await page.getByRole("button", { name: /alpha/ }).first().click({ timeout: 20_000 });
}

async function openTerminal(page: Page, host: Bridge) {
  await connect(page, host);
  await page.getByRole("button", { name: "Terminal view", exact: true }).click();
  await expect(page.getByRole("status", { name: "Live PTY" })).toBeVisible({ timeout: 20_000 });
}

async function openNativePane(page: Page, host: Bridge) {
  await page.route(`${host.url}/api/session?**`, (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({
      kind: "available", agentId: "w1:p1", sessionId: "stream", entries: [], cursor: "0", before: null, reset: false,
      capabilities: { inputModes: ["send"], stop: false, fit: false },
    }),
  }));
  await connect(page, host);
  await page.getByRole("button", { name: "Show native pane" }).click();
  await expect(page.getByRole("region", { name: "Native pane" }).getByRole("status", { name: "Live PTY" })).toBeVisible({ timeout: 20_000 });
}

/** From here the page's timers move only when the test moves them. */
async function freezeClock(page: Page) {
  await page.clock.install({ time: new Date() });
  await page.clock.pauseAt(new Date(Date.now() + 10_000));
}

const bar = (page: Page) => page.locator(".terminal-keys");
const up = (page: Page) => bar(page).getByRole("button", { name: "up", exact: true });
const backspace = (page: Page) => bar(page).getByRole("button", { name: "Backspace", exact: true });

/** Presses a button with the mouse and keeps it down. */
async function press(page: Page, button: Locator) {
  await button.scrollIntoViewIfNeeded();
  const box = await button.boundingBox();
  if (!box) throw new Error("the key has no box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  return box;
}

/**
 * Keys are sent in order over one connection, so once a marker key has
 * arrived, nothing sent before it is still on its way. Returns everything
 * that arrived before the marker.
 */
async function before(wire: Wire, page: Page, marker: Locator) {
  const seen = wire.keys.length;
  await marker.click();
  await expect.poll(() => wire.keys.length).toBeGreaterThan(seen);
  return wire.keys.slice(0, -1);
}

test.describe("hold to repeat", () => {
  test("a tap sends one key, and a press that slides off the key sends none", async ({ page, bridge }) => {
    const host = await bridge({ herdr });
    const wire = await watchKeys(page, host);
    await openTerminal(page, host);
    await freezeClock(page);

    await up(page).click();
    await expect.poll(() => wire.keys).toEqual(["up"]);
    await page.clock.runFor(5000);

    // Down on the key, up somewhere else, before the delay: not a tap.
    const box = await press(page, backspace(page));
    await page.mouse.move(box.x + box.width / 2, box.y - 200);
    await page.mouse.up();
    expect(await before(wire, page, bar(page).getByRole("button", { name: "esc", exact: true }))).toEqual(["up"]);
  });

  test("sends nothing before 400 ms, then repeats about twelve a second, and release adds no click", async ({ page, bridge }) => {
    const host = await bridge({ herdr });
    const wire = await watchKeys(page, host);
    await openTerminal(page, host);
    await freezeClock(page);

    await press(page, up(page));
    await page.clock.runFor(399);
    // Give a stray request time to show before saying none was sent.
    await page.waitForTimeout(150);
    expect(wire.keys).toEqual([]);

    await page.clock.runFor(1);
    await expect.poll(() => wire.keys).toEqual(["up"]);
    // 83 ms apart: five more in the next 415 ms, and not a sixth.
    await page.clock.runFor(415);
    await expect.poll(() => wire.keys.length).toBe(6);
    await page.clock.runFor(82);
    await page.waitForTimeout(150);
    expect(wire.keys).toHaveLength(6);

    await page.mouse.up();
    await page.clock.runFor(5000);
    expect(await before(wire, page, bar(page).getByRole("button", { name: "esc", exact: true }))).toEqual(Array(6).fill("up"));
  });

  test("Backspace repeats too, and a finger that drifts off the key keeps the hold", async ({ page, bridge }) => {
    const host = await bridge({ herdr });
    const wire = await watchKeys(page, host);
    await openTerminal(page, host);
    await freezeClock(page);

    const box = await press(page, backspace(page));
    await page.mouse.move(box.x + box.width / 2, box.y - 150);
    await page.clock.runFor(400 + 83 * 2);
    await expect.poll(() => wire.keys).toEqual(["backspace", "backspace", "backspace"]);

    await page.mouse.up();
    expect(await before(wire, page, bar(page).getByRole("button", { name: "esc", exact: true }))).toHaveLength(3);
  });

  test("a release while a request is in flight sends nothing after it", async ({ page, bridge }) => {
    const host = await bridge({ herdr });
    const wire = await watchKeys(page, host);
    await openTerminal(page, host);
    await freezeClock(page);

    wire.hold();
    await press(page, up(page));
    await page.clock.runFor(400);
    await expect.poll(() => wire.requests.length).toBe(1);
    // Three more are pressed while that request is open: they wait their turn.
    await page.clock.runFor(83 * 3);
    await page.mouse.up();
    await page.clock.runFor(10_000);
    expect(wire.requests).toHaveLength(1);

    wire.open();
    // What was pressed before the release arrives together, and then nothing.
    await expect.poll(() => wire.requests).toEqual([["up"], ["up", "up", "up"]]);
    await page.clock.runFor(10_000);
    expect(await before(wire, page, bar(page).getByRole("button", { name: "esc", exact: true }))).toEqual(Array(4).fill("up"));
  });

  test("a failed request drops the rest and ends the hold until the next press", async ({ page, bridge }) => {
    const host = await bridge({ herdr });
    const wire = await watchKeys(page, host);
    await openTerminal(page, host);
    await freezeClock(page);

    wire.fail = true;
    wire.hold();
    await press(page, up(page));
    await page.clock.runFor(400 + 83 * 3);
    await expect.poll(() => wire.requests).toEqual([["up"]]);
    // Three more were pressed behind it. The failure drops them and, with
    // the finger still down, ends the hold.
    await page.clock.runFor(83 * 3);
    wire.open();
    await page.waitForTimeout(300);
    await page.clock.runFor(5000);
    await page.waitForTimeout(150);
    expect(wire.requests).toEqual([["up"]]);
    await page.mouse.up();

    wire.fail = false;
    await press(page, up(page));
    await page.clock.runFor(400);
    await expect.poll(() => wire.requests).toEqual([["up"], ["up"]]);
    await page.mouse.up();
  });

  test("stops at 200 keys", async ({ page, bridge }) => {
    const host = await bridge({ herdr });
    const wire = await watchKeys(page, host);
    await openTerminal(page, host);
    await freezeClock(page);

    await press(page, up(page));
    await page.clock.runFor(400 + 83 * 400);
    await expect.poll(() => wire.keys.length).toBe(200);
    await page.clock.runFor(30_000);
    await page.waitForTimeout(150);
    expect(wire.keys).toHaveLength(200);
    await page.mouse.up();
    expect(await before(wire, page, bar(page).getByRole("button", { name: "esc", exact: true }))).toHaveLength(200);
  });

  test("Esc, Tab and Ctrl+C never repeat, however long they are held", async ({ page, bridge }) => {
    const host = await bridge({ herdr });
    const wire = await watchKeys(page, host);
    await openTerminal(page, host);
    await freezeClock(page);

    for (const name of ["esc", "tab", "^C"]) {
      await press(page, bar(page).getByRole("button", { name, exact: true }));
      await page.clock.runFor(3000);
      await page.mouse.up();
    }
    await expect.poll(() => wire.keys).toEqual(["esc", "tab", "ctrl+c"]);
    await page.clock.runFor(3000);
    expect(await before(wire, page, up(page))).toEqual(["esc", "tab", "ctrl+c"]);
  });

  test("hiding the page, blurring the window and a cancelled pointer each end the hold", async ({ page, bridge }) => {
    const host = await bridge({ herdr });
    const wire = await watchKeys(page, host);
    await openTerminal(page, host);
    await freezeClock(page);

    const stops: [string, () => Promise<unknown>][] = [
      ["hidden", () => page.evaluate(() => {
        Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
        document.dispatchEvent(new Event("visibilitychange"));
      })],
      ["blur", () => page.evaluate(() => window.dispatchEvent(new Event("blur")))],
      ["pointercancel", () => up(page).dispatchEvent("pointercancel", { pointerId: 1, bubbles: true })],
    ];
    for (const [name, stop] of stops) {
      const seen = wire.keys.length;
      await press(page, up(page));
      await page.clock.runFor(400 + 83);
      await expect.poll(() => wire.keys.length, name).toBe(seen + 2);
      await stop();
      await page.clock.runFor(5000);
      await page.waitForTimeout(150);
      expect(wire.keys.length, name).toBe(seen + 2);
      await page.mouse.up();
      if (name === "hidden") {
        // The page is shown again for the next press.
        await page.evaluate(() => {
          Reflect.deleteProperty(document, "hidden");
          document.dispatchEvent(new Event("visibilitychange"));
        });
        await expect(page.getByRole("status", { name: "Live PTY" })).toBeVisible({ timeout: 20_000 });
      }
    }
  });

  test("a held finger repeats, and its release is not a second tap", async ({ page, bridge }, info) => {
    test.skip(info.project.name !== "phone", "a touch screen");
    const host = await bridge({ herdr });
    const wire = await watchKeys(page, host);
    await openTerminal(page, host);
    await freezeClock(page);

    const button = up(page);
    await button.scrollIntoViewIfNeeded();
    const box = await button.boundingBox();
    if (!box) throw new Error("the key has no box");
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const touch = await page.context().newCDPSession(page);
    await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
    await page.clock.runFor(400 + 83 * 2);
    await expect.poll(() => wire.keys).toEqual(["up", "up", "up"]);
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.clock.runFor(5000);

    // A tap is its click, once.
    await button.tap();
    await expect.poll(() => wire.keys.length).toBe(4);
    expect(await before(wire, page, bar(page).getByRole("button", { name: "esc", exact: true }))).toEqual(Array(4).fill("up"));
  });

  test("the pane in Chat repeats its arrows and Backspace, and never Enter", async ({ page, bridge }) => {
    const host = await bridge({ herdr });
    const wire = await watchKeys(page, host);
    await openNativePane(page, host);
    await freezeClock(page);
    const keys = page.getByRole("region", { name: "Native pane" }).getByRole("group", { name: "Pane keys" });

    await press(page, keys.getByRole("button", { name: "Down", exact: true }));
    await page.clock.runFor(400 + 83 * 2);
    await expect.poll(() => wire.keys).toEqual(["down", "down", "down"]);
    await page.mouse.up();

    await press(page, keys.getByRole("button", { name: "Backspace", exact: true }));
    await page.clock.runFor(400);
    await expect.poll(() => wire.keys.length).toBe(4);
    await page.mouse.up();

    await press(page, keys.getByRole("button", { name: "enter", exact: true }));
    await page.clock.runFor(3000);
    await page.mouse.up();
    await keys.getByRole("button", { name: "esc", exact: true }).click();
    await expect.poll(() => wire.keys).toEqual(["down", "down", "down", "backspace", "enter", "esc"]);
    // Every request names the session the pane was attached to.
    expect(new Set(wire.sessionIds)).toEqual(new Set(["s1"]));
  });

  test("a key pressed from the keyboard sends once, however long it is held", async ({ page, bridge }) => {
    const host = await bridge({ herdr });
    const wire = await watchKeys(page, host);
    await openNativePane(page, host);
    await freezeClock(page);
    const keys = page.getByRole("region", { name: "Native pane" }).getByRole("group", { name: "Pane keys" });

    const left = keys.getByRole("button", { name: "Left", exact: true });
    await left.focus();
    await page.keyboard.press("Space");
    await expect.poll(() => wire.keys).toEqual(["left"]);
    // Enter held down auto-repeats its keydown; the button must not follow.
    for (let i = 0; i < 5; i += 1) await page.keyboard.down("Enter");
    await page.keyboard.up("Enter");
    await page.clock.runFor(5000);
    expect(await before(wire, page, keys.getByRole("button", { name: "esc", exact: true }))).toEqual(["left", "left"]);
  });
});
