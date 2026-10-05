import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { nativeCapabilities, submitNative } from "./native-input.mjs";

const agent = { kind: "pi", status: "idle" };
const pasted = (text) => `\x1b[200~${text}\x1b[201~`;

async function callsFor(mode, { agent: a = agent, text = "hello" } = {}) {
  const calls = [];
  const run = async (_bin, args) => { calls.push(args); return ""; };
  const result = await submitNative({ run, bin: "herdr", target: "w1:p1", text, mode, agent: a });
  return { calls, result };
}

async function rejectsFor(mode, { agent: a = agent, text = "hello" } = {}) {
  const calls = [];
  const run = async (_bin, args) => { calls.push(args); return ""; };
  try {
    await submitNative({ run, bin: "herdr", target: "w1:p1", text, mode, agent: a });
  } catch (error) {
    return { error, calls };
  }
  throw new Error(`Expected ${mode} to reject.`);
}

test("idle send is the native submit: text, then Enter — nothing that interrupts", async () => {
  const { calls, result } = await callsFor("send");
  assert.deepEqual(calls, [["pane", "send-text", "w1:p1", pasted("hello")], ["pane", "send-keys", "w1:p1", "enter"]]);
  assert.equal(result.state, "delivered");
  assert.ok(!calls.some((c) => c.at(-1) === "esc"), "an idle send must not press esc");
  assert.ok(!calls.some((c) => c.at(-1) === "alt+enter"), "an idle send must not queue");
});

test("pi text arrives as a paste, so its completion list cannot take the Enter", async () => {
  // Typed, "/model " opens pi's model completions and Enter accepts the first
  // one instead of running the command.
  const { calls } = await callsFor("terminal", { text: "/model " });
  assert.deepEqual(calls, [["pane", "send-text", "w1:p1", pasted("/model ")], ["pane", "send-keys", "w1:p1", "enter"]]);
  const closing = await callsFor("send", { text: "a\x1b[201~b" });
  assert.deepEqual(closing.calls[0], ["pane", "send-text", "w1:p1", pasted("ab")]);
  const claude = await callsFor("send", { agent: { kind: "claude", status: "idle" } });
  assert.deepEqual(claude.calls[0], ["pane", "send-text", "w1:p1", "hello"]);
});

test("queue is the only mode that queues; steer keeps the native timing", async () => {
  const queue = await callsFor("queue", { agent: { ...agent, status: "working" } });
  assert.deepEqual(queue.calls.at(-1), ["pane", "send-keys", "w1:p1", "alt+enter"]);
  const steer = await callsFor("steer", { agent: { ...agent, status: "working" } });
  assert.deepEqual(steer.calls.at(-1), ["pane", "send-keys", "w1:p1", "enter"]);
});

test("a blocked agent inserts text and never presses Enter", async () => {
  const { calls, result } = await callsFor("send", { agent: { ...agent, status: "blocked" } });
  assert.deepEqual(calls, [["pane", "send-text", "w1:p1", pasted("hello")]]);
  assert.equal(result.state, "delivered");
  assert.ok(!calls.some((c) => c.at(-1) === "enter"), "Enter on a blocked dialog answers whatever is highlighted");
  const terminal = await callsFor("terminal", { agent: { ...agent, status: "blocked" }, text: "" });
  assert.deepEqual(terminal.calls, [["pane", "send-keys", "w1:p1", "enter"]]);
});

test("empty messages and unsupported modes are rejected before delivery", async () => {
  const empty = await rejectsFor("send", { text: "  " });
  assert.equal(empty.error.delivery, "failed");
  const unsupported = await rejectsFor("send", { agent: { kind: "gemini", status: "idle" } });
  assert.equal(unsupported.error.delivery, "failed");
  assert.equal(unsupported.calls.length, 0);
});

test("stop needs a working turn and a capable agent", async () => {
  const working = await callsFor("stop", { agent: { ...agent, status: "working" }, text: "" });
  assert.deepEqual(working.calls, [["pane", "send-keys", "w1:p1", "esc"]]);
  const idle = await rejectsFor("stop", { text: "" });
  assert.equal(idle.error.delivery, "failed");
});

test("pi custom keybindings fall back to plain send only", async () => {
  process.env.PI_CODING_AGENT_DIR = await mkdtemp(path.join(tmpdir(), "pi-"));
  try {
    assert.deepEqual(await nativeCapabilities(agent), { inputModes: ["send", "steer", "queue"], stop: true, fit: false });
    await writeFile(path.join(process.env.PI_CODING_AGENT_DIR, "keybindings.json"), JSON.stringify({ "tui.input.submit": "mod+x" }));
    assert.deepEqual(await nativeCapabilities(agent), { inputModes: ["send"], stop: false, fit: false });
  } finally {
    delete process.env.PI_CODING_AGENT_DIR;
  }
});
