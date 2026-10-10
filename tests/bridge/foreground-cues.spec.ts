import path from "node:path";
import { rename, writeFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { test, expect, openApp, openDemo, seedHosts, loginBridge, pairBridge, type Bridge } from "../fixtures";

// C8: an optional sound while the app is open, and the blocked count on the
// app icon. The browser audio and badge APIs are replaced by recorders, so the
// specs read what the page asked for. The fake herdr reads both agents'
// statuses from one file, replaced whole, so a spec can change two agents in
// one snapshot.

const herdr = `
read -r s1 s2 < "$MOSHPIT_STATE_DIR/statuses" 2>/dev/null
s1=\${s1:-working}
s2=\${s2:-working}
case "$*" in
  "api snapshot"*)
    echo '{"result":{"snapshot":{"agents":[{"pane_id":"w1:p1","agent":"codex","agent_status":"'$s1'","cwd":"/repo/app","workspace_id":"w1","terminal_title":"codex","revision":1},{"pane_id":"w1:p2","agent":"claude","agent_status":"'$s2'","cwd":"/repo/app","workspace_id":"w1","terminal_title":"claude","revision":1}]}}}'
    ;;
  "pane list"*) echo '{"result":{"panes":[{"pane_id":"w1:p1","label":"flipper","terminal_id":"term_f1","cwd":"/repo/app","workspace_id":"w1"},{"pane_id":"w1:p2","label":"second","terminal_id":"term_f2","cwd":"/repo/app","workspace_id":"w1"}]}}' ;;
  "pane read"*) printf 'Proceed with the deploy? y/n' ;;
  *) echo '{}' ;;
esac`;

type Status = "working" | "blocked" | "idle" | "done";

/** Replaces both agents' statuses at once, so one snapshot carries both changes. */
async function setStatuses(host: Bridge, first: Status, second: Status) {
  const file = path.join(host.dir, "state", "statuses");
  await writeFile(`${file}.next`, `${first} ${second}\n`);
  await rename(`${file}.next`, file);
}

type Note = { hz: number; peak: number; start: number; stop: number };
type Recorded = { contexts: number; notes: Note[]; badge: string[] };

/**
 * Replaces AudioContext with a recorder that, like a browser, only runs once
 * the page has had a user gesture, and records the badge calls. `badge: false`
 * leaves the badge API missing, as in Firefox.
 */
async function stubMedia(page: Page, { badge = true } = {}) {
  await page.context().addInitScript((withBadge) => {
    const rec: Recorded = { contexts: 0, notes: [], badge: [] };
    Object.defineProperty(window, "__rec", { value: rec });
    const active = () => (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation?.isActive === true;
    class FakeContext extends EventTarget {
      state = active() ? "running" : "suspended";
      destination = {};
      constructor() {
        super();
        rec.contexts += 1;
      }
      get currentTime() {
        return performance.now() / 1000;
      }
      async resume() {
        if (this.state !== "running" && active()) {
          this.state = "running";
          this.dispatchEvent(new Event("statechange"));
        }
      }
      createGain() {
        const gain = { peak: 0 };
        return {
          gain: {
            setValueAtTime() {},
            exponentialRampToValueAtTime(value: number) {
              gain.peak = Math.max(gain.peak, value);
            },
          },
          connect() {},
          peak: () => gain.peak,
        };
      }
      createOscillator() {
        let out: { peak: () => number } | null = null;
        let note: Note | null = null;
        const osc = {
          type: "",
          frequency: { value: 0 },
          connect(node: { peak?: () => number }) {
            if (node.peak) out = node as { peak: () => number };
          },
          start(at: number) {
            note = { hz: osc.frequency.value, peak: out?.peak() ?? 0, start: at, stop: 0 };
            rec.notes.push(note);
          },
          stop(at: number) {
            if (note) note.stop = at;
          },
        };
        return osc;
      }
    }
    Object.defineProperty(window, "AudioContext", { value: FakeContext, configurable: true });
    if (!withBadge) {
      // Chromium ships the API; take it away, as Firefox never had it.
      delete (Navigator.prototype as unknown as Record<string, unknown>).setAppBadge;
      delete (Navigator.prototype as unknown as Record<string, unknown>).clearAppBadge;
    } else {
      const nav = navigator as Navigator & Record<string, unknown>;
      nav.setAppBadge = async (n: number) => void rec.badge.push(`set ${n}`);
      nav.clearAppBadge = async () => void rec.badge.push("clear");
    }
  }, badge);
}

const recorded = (page: Page) => page.evaluate(() => (window as unknown as { __rec: Recorded }).__rec);
const notes = async (page: Page) => (await recorded(page)).notes.map((n) => n.hz);
const badge = async (page: Page) => (await recorded(page)).badge;

const profile = (bridge: Bridge) => ({
  id: "e2e", label: "E2E", transport: "tailscale", user: "", hostname: "127.0.0.1", port: bridge.port, demo: false, tailnetUrl: bridge.url,
});

/** A paired bridge with both agents listed, the app on its Hosts screen. */
async function open(page: Page, host: Bridge, { connected = true } = {}) {
  await openApp(page, { demo: false });
  await pairBridge(page, host.url, await loginBridge(page, host.url));
  await seedHosts(page, [profile(host)], connected ? "e2e" : null);
  if (connected) await expect(page.getByRole("button", { name: /flipper/ }).first()).toBeVisible({ timeout: 20_000 });
  await goHosts(page);
}

/**
 * Turns the sound on. The poll skips a tick while a text field has focus, and
 * a checkbox counts, so the focus is let go as a person's next tap would.
 */
async function turnOn(page: Page) {
  await sound(page).check();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

const goHosts = (page: Page) => page.getByRole("button", { name: /hosts/i }).first().click();
const sound = (page: Page) => page.getByRole("checkbox", { name: "Sound when an agent needs you" });
const testSound = (page: Page) => page.getByRole("button", { name: "Test sound" });

/** Two polls with nothing to hear, long enough for a wrong cue to have played. */
const settle = (page: Page) => page.waitForTimeout(4_500);

const BLOCKED = [660, 880];
const FINISHED = [523];

test.describe("sound when an agent needs you", () => {
  test("is off by default and silent", async ({ page, bridge }) => {
    await stubMedia(page);
    const host = await bridge({ herdr });
    await open(page, host);
    await expect(sound(page)).not.toBeChecked();
    await expect(testSound(page)).toHaveCount(0);

    await setStatuses(host, "blocked", "idle");
    await settle(page);
    expect((await recorded(page)).contexts, "no audio context until the setting is turned on").toBe(0);
    expect(await notes(page)).toEqual([]);
  });

  test("turning it on plays nothing, and Test sound plays the blocked cue", async ({ page, bridge }) => {
    await stubMedia(page);
    const host = await bridge({ herdr });
    await open(page, host);
    await turnOn(page);
    await expect(testSound(page)).toBeVisible();
    await expect(page.getByText("Plays while this app is open")).toBeVisible();
    expect((await recorded(page)).contexts).toBe(1);
    expect(await notes(page)).toEqual([]);

    await testSound(page).click();
    await expect.poll(() => notes(page)).toEqual(BLOCKED);
    const [first, second] = (await recorded(page)).notes;
    expect(second.stop - first.start, "the whole cue is under 300 ms").toBeLessThan(0.3);
  });

  test("a transition to blocked plays one cue, and the first snapshot plays none", async ({ page, bridge }) => {
    await stubMedia(page);
    const host = await bridge({ herdr });
    await setStatuses(host, "blocked", "working");
    await open(page, host, { connected: false });
    await turnOn(page);
    await page.getByRole("button", { name: "Connect" }).click();
    await expect(page.getByRole("button", { name: "Disconnect" })).toBeVisible();
    await settle(page);
    expect(await notes(page), "an agent already blocked at connect is not a transition").toEqual([]);

    // The first snapshot after the host stopped answering only sets the
    // baseline, whatever changed meanwhile.
    await page.route("**/api/snapshot", (route) => route.abort());
    await expect(page.getByText("Connection interrupted")).toBeVisible({ timeout: 15_000 });
    await setStatuses(host, "idle", "blocked");
    await page.unroute("**/api/snapshot");
    await expect(page.getByText("Connection interrupted")).toHaveCount(0, { timeout: 15_000 });
    await settle(page);
    expect(await notes(page)).toEqual([]);

    await setStatuses(host, "working", "working");
    await settle(page);
    expect(await notes(page)).toEqual([]);

    await setStatuses(host, "blocked", "blocked");
    await expect.poll(() => notes(page), { timeout: 15_000 }).toEqual(BLOCKED);
    await settle(page);
    expect(await notes(page), "later polls of the same block add nothing").toEqual(BLOCKED);
  });

  test("a hidden page plays nothing", async ({ page, bridge }) => {
    await stubMedia(page);
    const host = await bridge({ herdr });
    await open(page, host);
    await turnOn(page);
    const visibility = (state: string) =>
      page.evaluate((value) => Object.defineProperty(document, "visibilityState", { get: () => value, configurable: true }), state);

    await visibility("hidden");
    await setStatuses(host, "blocked", "working");
    await settle(page);
    expect(await notes(page)).toEqual([]);

    // The block seen while hidden is spent, not held back for later.
    await visibility("visible");
    await settle(page);
    expect(await notes(page)).toEqual([]);
    await setStatuses(host, "blocked", "blocked");
    await expect.poll(() => notes(page), { timeout: 15_000 }).toEqual(BLOCKED);
  });

  test("several transitions in one snapshot make one cue, blocked first", async ({ page, bridge }) => {
    await stubMedia(page);
    const host = await bridge({ herdr });
    await open(page, host);
    await turnOn(page);

    await setStatuses(host, "idle", "blocked");
    await expect.poll(() => notes(page), { timeout: 15_000 }).toEqual(BLOCKED);
    await settle(page);
    expect(await notes(page), "the finish in the same snapshot is not a second cue").toEqual(BLOCKED);

    await setStatuses(host, "working", "working");
    await settle(page);
    await setStatuses(host, "idle", "done");
    await expect.poll(async () => (await notes(page)).length, { timeout: 15_000 }).toBe(BLOCKED.length + FINISHED.length);
    await settle(page);
    expect((await notes(page)).slice(BLOCKED.length), "two finishes are one cue").toEqual(FINISHED);
  });

  test("a finished turn is a quieter, different cue, and is skipped for the agent on screen", async ({ page, bridge }) => {
    await stubMedia(page);
    const host = await bridge({ herdr });
    await open(page, host);
    await turnOn(page);

    await setStatuses(host, "working", "blocked");
    await expect.poll(() => notes(page), { timeout: 15_000 }).toEqual(BLOCKED);
    await setStatuses(host, "working", "working");
    await settle(page);

    // Open the first agent, then let it finish: it is on screen, so no cue.
    await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /^moshpit/i }).click();
    await page.getByRole("button", { name: /flipper/ }).first().click();
    await setStatuses(host, "idle", "working");
    await settle(page);
    expect(await notes(page)).toEqual(BLOCKED);

    // The second agent finishing is not on screen.
    await setStatuses(host, "idle", "idle");
    await expect.poll(() => notes(page), { timeout: 15_000 }).toEqual([...BLOCKED, ...FINISHED]);
    const [blockedNote, , finishedNote] = (await recorded(page)).notes;
    expect(finishedNote.hz).not.toBe(blockedNote.hz);
    expect(finishedNote.peak, "quieter than the blocked cue").toBeLessThan(blockedNote.peak);
  });

  test("the setting survives a reload and the sound waits for the first tap", async ({ page, bridge }) => {
    await stubMedia(page);
    const host = await bridge({ herdr });
    await open(page, host);
    await turnOn(page);

    await page.reload({ waitUntil: "networkidle" });
    await expect(page.getByRole("button", { name: /flipper/ }).first()).toBeVisible({ timeout: 20_000 });
    // A synthetic click, not a tap: the page must not have had a gesture yet.
    await page.getByRole("button", { name: /hosts/i }).first().dispatchEvent("click");
    await expect(sound(page)).toBeChecked();
    await expect(page.getByText("Sound is waiting for a tap")).toBeVisible();

    // No gesture yet: the cue is dropped, not held for later.
    await setStatuses(host, "blocked", "working");
    await settle(page);
    expect(await notes(page)).toEqual([]);

    await page.getByText("Settings", { exact: true }).click();
    await expect(page.getByText("Plays while this app is open")).toBeVisible();
    expect(await notes(page), "arming plays nothing").toEqual([]);
    await setStatuses(host, "blocked", "blocked");
    await expect.poll(() => notes(page), { timeout: 15_000 }).toEqual(BLOCKED);
  });

  test("an unknown saved value reads as off", async ({ page, bridge }) => {
    await stubMedia(page);
    const host = await bridge({ herdr });
    await open(page, host);
    await page.evaluate(() => {
      const raw = JSON.parse(localStorage.getItem("moshpit-v1") ?? "{}");
      raw.state.settings.cueSound = "yes";
      localStorage.setItem("moshpit-v1", JSON.stringify(raw));
    });
    await page.reload({ waitUntil: "networkidle" });
    await goHosts(page);
    await expect(sound(page)).not.toBeChecked();
  });

  test("the demo cues only for its own simulated block, and never touches the badge", async ({ page }) => {
    await stubMedia(page);
    await openDemo(page);
    await goHosts(page);
    await turnOn(page);
    await page.getByRole("button", { name: "Simulate: agent blocked" }).click();
    await expect.poll(() => notes(page)).toEqual(BLOCKED);
    expect(await badge(page)).toEqual([]);
  });
});

test.describe("app badge", () => {
  test("follows the blocked count, and clears at zero and on disconnect", async ({ page, bridge }) => {
    await stubMedia(page);
    const host = await bridge({ herdr });
    await open(page, host);
    const last = async () => (await badge(page)).at(-1);

    await setStatuses(host, "blocked", "working");
    await expect.poll(last, { timeout: 15_000 }).toBe("set 1");
    await setStatuses(host, "blocked", "blocked");
    await expect.poll(last, { timeout: 15_000 }).toBe("set 2");
    await setStatuses(host, "working", "blocked");
    await expect.poll(last, { timeout: 15_000 }).toBe("set 1");
    await setStatuses(host, "working", "working");
    await expect.poll(last, { timeout: 15_000 }).toBe("clear");

    await setStatuses(host, "blocked", "working");
    await expect.poll(last, { timeout: 15_000 }).toBe("set 1");
    await page.getByRole("button", { name: "Disconnect" }).click();
    await expect.poll(last).toBe("clear");
    expect((await badge(page)).some((call) => call === "set 0")).toBe(false);
  });

  test("makes no calls, and breaks nothing, where the API is missing", async ({ page, bridge }) => {
    await stubMedia(page, { badge: false });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const host = await bridge({ herdr });
    await open(page, host);
    expect(await page.evaluate(() => "setAppBadge" in navigator)).toBe(false);

    await setStatuses(host, "blocked", "working");
    await expect(page).toHaveTitle("(1) moshpit", { timeout: 15_000 });
    expect(await badge(page)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("a refused badge call is swallowed", async ({ page, bridge }) => {
    await page.context().addInitScript(() => {
      const nav = navigator as Navigator & Record<string, unknown>;
      nav.setAppBadge = () => Promise.reject(new Error("refused"));
      nav.clearAppBadge = () => Promise.reject(new Error("refused"));
    });
    await stubMedia(page, { badge: false });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const host = await bridge({ herdr });
    await open(page, host);
    await setStatuses(host, "blocked", "working");
    await expect(page).toHaveTitle("(1) moshpit", { timeout: 15_000 });
    expect(errors).toEqual([]);
  });
});
