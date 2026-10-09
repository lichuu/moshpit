import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, appendFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSessionReader } from "./sessions.mjs";

// C1: the context meter comes from the newest usage row of the parent model
// call, in the same read that builds the conversation.

async function fixture(t, kind, records) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "moshpit-context-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "session.jsonl");
  await writeFile(file, records.map(JSON.stringify).join("\n") + "\n");
  const agent = { id: "pane", kind, session: { agent: kind, kind: "path", source: "test", value: file } };
  return { file, agent, read: createSessionReader() };
}
const append = (file, ...rows) => appendFile(file, rows.map(JSON.stringify).join("\n") + "\n");

const codexCount = (total, window, rateLimits) => ({
  type: "event_msg",
  payload: {
    type: "token_count",
    info: { last_token_usage: { input_tokens: total - 10, output_tokens: 10, total_tokens: total }, total_token_usage: { total_tokens: total * 40 }, model_context_window: window },
    ...(rateLimits ? { rate_limits: rateLimits } : {}),
  },
});
const codexMessage = (text) => ({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });

const claudeCall = (usage, extra = {}) => ({ type: "assistant", uuid: `a${Math.random()}`, message: { role: "assistant", model: "model-x", content: [{ type: "text", text: "ok" }], usage }, ...extra });
const claudeBoundary = { type: "system", subtype: "compact_boundary", uuid: "boundary" };

const piCall = (id, parentId, usage) => ({ type: "message", id, parentId, message: { role: "assistant", content: [{ type: "text", text: "ok" }], usage } });

test("Codex: the latest token_count wins, with capacity and plan limits", async (t) => {
  const limits = {
    primary: { used_percent: 62.04, window_minutes: 300, resets_at: 1_900_000_000 },
    secondary: { used_percent: 18, window_minutes: 10080, resets_at: 1_900_500_000 },
  };
  const { agent, read, file } = await fixture(t, "codex", [codexMessage("hi"), codexCount(40_000, 272_000, limits), codexCount(84_000, 272_000, limits)]);
  const first = await read(agent);
  assert.deepEqual(first.context, {
    used: 84_000, capacity: 272_000,
    limits: {
      primary: { usedPercent: 62, windowMinutes: 300, resetsAt: 1_900_000_000 },
      secondary: { usedPercent: 18, windowMinutes: 10080, resetsAt: 1_900_500_000 },
    },
  });
  await append(file, codexCount(90_000, 272_000));
  assert.equal((await read(agent, { after: first.cursor })).context.used, 90_000);
});

test("Codex: a count row without info, and limits that are not numbers, do not break it", async (t) => {
  const bad = { primary: { used_percent: "lots", window_minutes: 300 }, secondary: { used_percent: 140 } };
  const { agent, read, file } = await fixture(t, "codex", [codexCount(5_000, 100_000, bad)]);
  assert.deepEqual((await read(agent)).context, { used: 5_000, capacity: 100_000 });
  await append(file, { type: "event_msg", payload: { type: "token_count", info: null, rate_limits: { primary: { used_percent: 3 } } } });
  // A rate-limit-only row carries no context figure: the earlier one stands.
  assert.equal((await read(agent)).context.used, 5_000);
});

test("Codex: a compaction clears the meter until the next count", async (t) => {
  const { agent, read, file } = await fixture(t, "codex", [codexCount(200_000, 272_000)]);
  assert.equal((await read(agent)).context.used, 200_000);
  await append(file, { type: "compacted", payload: { message: "" } });
  const cleared = await read(agent);
  assert.equal("context" in cleared, false);
  await append(file, codexCount(30_000, 272_000));
  assert.equal((await read(agent)).context.used, 30_000);
});

test("Claude: latest non-sidechain call, input plus both cache counters, no capacity", async (t) => {
  const { agent, read, file } = await fixture(t, "claude", [
    claudeCall({ input_tokens: 10, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 500, output_tokens: 900 }),
    claudeCall({ input_tokens: 20, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 2_000, output_tokens: 5, service_tier: "standard" }),
  ]);
  const response = await read(agent);
  assert.deepEqual(response.context, { used: 42_020 });
  // A subagent's call, newer in the file, must not move it.
  await append(file, claudeCall({ input_tokens: 150_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, { isSidechain: true }));
  assert.deepEqual((await read(agent)).context, { used: 42_020 });
  // Neither does a synthetic error row with empty counters.
  await append(file, claudeCall({ input_tokens: 0, output_tokens: 0 }, { message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "e" }], usage: { input_tokens: 0, output_tokens: 0 } } }));
  assert.deepEqual((await read(agent)).context, { used: 42_020 });
});

test("Claude: a compaction boundary clears the meter until the next call", async (t) => {
  const { agent, read, file } = await fixture(t, "claude", [claudeCall({ input_tokens: 5, cache_read_input_tokens: 150_000 })]);
  assert.equal((await read(agent)).context.used, 150_005);
  await append(file, claudeBoundary);
  assert.equal("context" in (await read(agent)), false);
  await append(file, claudeCall({ input_tokens: 3, cache_read_input_tokens: 9_000 }));
  assert.equal((await read(agent)).context.used, 9_003);
});

test("Pi: latest assistant usage on the active branch, cleared by a compaction", async (t) => {
  const { agent, read, file } = await fixture(t, "pi", [
    { type: "session", id: "s" },
    { type: "message", id: "u", parentId: null, message: { role: "user", content: "hi" } },
    piCall("a", "u", { input: 1_000, output: 50, cacheRead: 20_000, cacheWrite: 300, totalTokens: 21_350 }),
  ]);
  assert.deepEqual((await read(agent)).context, { used: 21_300 });
  await append(file, { type: "compaction", id: "c", parentId: "a", summary: "short" });
  assert.equal("context" in (await read(agent)), false);
  await append(file, piCall("b", "c", { input: 700, output: 5, cacheRead: 3_000, cacheWrite: 0 }));
  assert.deepEqual((await read(agent)).context, { used: 3_700 });
  // A new branch from an earlier message becomes the visible conversation; the
  // compaction and the call after it are no longer on it.
  await append(file, piCall("x", "u", { input: 99_000, cacheRead: 0, cacheWrite: 0 }));
  assert.equal((await read(agent)).context.used, 99_000);
});

test("malformed or absurd numbers drop the field instead of sending garbage", async (t) => {
  const cases = [
    ["claude", [claudeCall({ input_tokens: -5 })]],
    ["claude", [claudeCall({ input_tokens: "12" })]],
    ["claude", [claudeCall({ input_tokens: 1e12 })]],
    ["claude", [claudeCall({ input_tokens: null, cache_read_input_tokens: NaN })]],
    ["claude", [claudeCall({ input_tokens: 100 }), claudeCall({ input_tokens: -1 })]],
    ["pi", [{ type: "message", id: "a", parentId: null, message: { role: "assistant", content: "x", usage: { input: Infinity } } }]],
    ["codex", [codexCount(-1, 100_000)]],
    ["codex", [{ type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { total_tokens: "9" } } } }]],
  ];
  for (const [kind, rows] of cases) {
    const { agent, read } = await fixture(t, kind, rows);
    const response = await read(agent);
    assert.equal(response.kind, "available");
    assert.equal("context" in response, false, JSON.stringify(rows));
  }
});

test("an unusable capacity leaves tokens only", async (t) => {
  for (const window of [0, -1, "big", 50, 1e12]) {
    const { agent, read } = await fixture(t, "codex", [codexCount(1_000, window)]);
    assert.deepEqual((await read(agent)).context, { used: 1_000 }, String(window));
  }
});

test("harnesses without usage rows have no context field", async (t) => {
  const grok = { timestamp: 1, method: "session/update", params: { sessionId: "n", update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "hello" } } } };
  const { agent, read } = await fixture(t, "grok", [grok]);
  const response = await read(agent);
  assert.equal(response.kind, "available");
  assert.equal("context" in response, false);
  const noUsage = await fixture(t, "claude", [{ type: "user", uuid: "u", message: { role: "user", content: "hi" } }]);
  assert.equal("context" in (await noUsage.read(noUsage.agent)), false);
});

test("paging older history and polling by cursor keep reporting the newest usage", async (t) => {
  const rows = Array.from({ length: 130 }, (_, i) => codexMessage(`Prompt ${i}`));
  rows.splice(5, 0, codexCount(1_000, 272_000));
  rows.push(codexCount(120_000, 272_000));
  const { agent, read } = await fixture(t, "codex", rows);
  const first = await read(agent);
  assert.equal(first.context.used, 120_000);
  assert.ok(first.before);
  const older = await read(agent, { before: first.before });
  assert.equal(older.context.used, 120_000);
  assert.deepEqual((await read(agent, { after: first.cursor })).context, first.context);
});

test("a new row that is not a model call leaves the last call's figure in place", async (t) => {
  const { agent, read, file } = await fixture(t, "claude", [claudeCall({ input_tokens: 7, cache_read_input_tokens: 700 })]);
  const first = await read(agent);
  await append(file, { type: "user", uuid: "u2", message: { role: "user", content: "next" } });
  assert.deepEqual((await read(agent, { after: first.cursor })).context, { used: 707 });
});
