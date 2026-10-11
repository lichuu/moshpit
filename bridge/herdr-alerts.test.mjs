import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHerdrAlerts, herdrConfigPath, parseAlertConfig, soundMuted, tomlScalars } from "./herdr-alerts.mjs";
import { createAlertDelay } from "../src/lib/moshpit/alert-delay.mjs";

test("the config path is herdr's own, and HERDR_CONFIG_PATH overrides it", () => {
  assert.equal(herdrConfigPath({ HOME: "/h" }), "/h/.config/herdr/config.toml");
  assert.equal(herdrConfigPath({ HOME: "/h", HERDR_CONFIG_PATH: "/x/c.toml" }), "/x/c.toml");
});

test("scalars are read from tables, dotted keys and inline tables", () => {
  const got = tomlScalars(`
onboarding = false # trailing
[ui.toast]
delivery = "herdr"   # a "quoted # hash" stays below
delay_seconds = 1_0
note = "a # b"
[ui]
sound.enabled = false
sound.agents = { claude = "on", "open_code" = 'off' }
[[keys.command]]
name = "x"
`);
  assert.equal(got.get("onboarding"), false);
  assert.equal(got.get("ui.toast.delivery"), "herdr");
  assert.equal(got.get("ui.toast.delay_seconds"), 10);
  assert.equal(got.get("ui.toast.note"), "a # b");
  assert.equal(got.get("ui.sound.enabled"), false);
  assert.equal(got.get("ui.sound.agents.claude"), "on");
  assert.equal(got.get("ui.sound.agents.open_code"), "off");
  assert.equal(got.get("keys.command.name"), "x");
});

test("what the reader does not understand is skipped, not guessed", () => {
  const got = tomlScalars(`
[ui.toast]
delay_seconds = 2.5
list = [1, 2,
  3]
text = """
[ui.sound.agents]
claude = "off"
"""
when = 2026-01-01
[bad header
ok = true
`);
  assert.deepEqual([...got], [["ui.toast.ok", true]]);
});

test("missing or out-of-range settings are herdr's defaults", () => {
  assert.deepEqual(parseAlertConfig(""), { delaySeconds: 1, soundAgents: { droid: "off" } });
  assert.equal(parseAlertConfig("[ui.toast]\ndelay_seconds = 0").delaySeconds, 0);
  assert.equal(parseAlertConfig("[ui.toast]\ndelay_seconds = 3600").delaySeconds, 3600);
  for (const bad of ["3601", "-1", '"5"', "true", "1.5"])
    assert.equal(parseAlertConfig(`[ui.toast]\ndelay_seconds = ${bad}`).delaySeconds, 1, bad);
  assert.deepEqual(parseAlertConfig('[ui.sound.agents]\ndroid = "on"\nclaude = "off"\ncodex = "loud"\n').soundAgents, { droid: "on", claude: "off" });
});

test("only an explicit off mutes, and herdr's labels meet the bridge's kinds", () => {
  const config = parseAlertConfig('[ui.sound.agents]\nclaude = "off"\nopen_code = "off"\ngithub_copilot = "off"\ncodex = "on"\npi = "default"\n');
  for (const kind of ["claude", "opencode", "copilot", "droid"]) assert.equal(soundMuted(config, kind), true, kind);
  for (const kind of ["codex", "pi", "gemini", "", undefined]) assert.equal(soundMuted(config, kind), false, String(kind));
});

test("the file is re-read when it changes, and a missing file is the defaults", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "herdr-alerts-"));
  try {
    const file = path.join(dir, "config.toml");
    const alerts = createHerdrAlerts({ file });
    assert.equal((await alerts.current()).delaySeconds, 1);
    await writeFile(file, "[ui.toast]\ndelay_seconds = 7\n");
    assert.equal((await alerts.current()).delaySeconds, 7);
    await writeFile(file, "[ui.toast]\ndelay_seconds = 9\n");
    await utimes(file, new Date(), new Date(Date.now() + 5000));
    const current = await alerts.current();
    assert.equal(current.delaySeconds, 9);
    assert.deepEqual(alerts.annotate([{ id: "a", kind: "droid" }, { id: "b", kind: "claude" }], current), [{ id: "a", kind: "droid", soundMuted: true }, { id: "b", kind: "claude" }]);
    await rm(file);
    assert.equal((await alerts.current()).delaySeconds, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an oversized config is not read", async () => {
  let reads = 0;
  const alerts = createHerdrAlerts({
    file: "x",
    fs: { stat: async () => ({ size: 2 * 1024 * 1024, mtimeMs: 1, isFile: () => true }), readFile: async () => ((reads += 1), "[ui.toast]\ndelay_seconds = 9") },
  });
  assert.equal((await alerts.current()).delaySeconds, 1);
  assert.equal(reads, 0);
});

const holds = ({ type }, status) => (type === "block" ? status === "blocked" : status === "idle" || status === "done");

test("an alert waits its delay and goes only if the agent is still in that state", () => {
  const held = createAlertDelay(holds);
  const blocked = [{ id: "a", status: "blocked" }];
  assert.deepEqual(held.step([{ id: "a", type: "block" }], blocked, 1000, 0), []);
  assert.equal(held.size, 1);
  assert.deepEqual(held.step([], blocked, 1000, 999), []);
  assert.deepEqual(held.step([], blocked, 1000, 1000), [{ id: "a", type: "block" }]);
  assert.equal(held.size, 0);
  assert.deepEqual(held.step([], blocked, 1000, 5000), []);
});

test("an agent that left the state, or the snapshot, drops its alert", () => {
  const held = createAlertDelay(holds);
  held.step([{ id: "a", type: "block" }, { id: "b", type: "turn" }, { id: "c", type: "turn" }], [{ id: "a", status: "blocked" }, { id: "b", status: "idle" }, { id: "c", status: "done" }], 1000, 0);
  assert.equal(held.size, 3);
  assert.deepEqual(held.step([], [{ id: "a", status: "working" }, { id: "b", status: "working" }], 1000, 500), []);
  assert.equal(held.size, 0);
  assert.deepEqual(held.step([], [{ id: "a", status: "blocked" }], 1000, 2000), []);
});

test("no delay sends at once, and clear forgets what was held", () => {
  const held = createAlertDelay(holds);
  assert.deepEqual(held.step([{ id: "a", type: "turn" }], [{ id: "a", status: "idle" }], 0, 10), [{ id: "a", type: "turn" }]);
  held.step([{ id: "a", type: "block" }], [{ id: "a", status: "blocked" }], 1000, 0);
  held.clear();
  assert.deepEqual(held.step([], [{ id: "a", status: "blocked" }], 1000, 9000), []);
});
