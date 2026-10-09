import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSubmissions } from "./submissions.mjs";

function request(overrides = {}) {
  return { id: randomUUID(), target: "pane-1", sessionId: "session-1", mode: "send", text: "hello", ...overrides };
}
async function setup(t, methods = {}) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "moshpit-submissions-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const calls = [];
  const herdr = {
    snapshot: async () => ({ agents: [{ id: "pane-1", sessionId: "session-1" }] }),
    submit: async (...args) => { calls.push(args); return { state: "delivered", message: "Sent to terminal" }; },
    keys: async (...args) => { calls.push(args); },
    ...methods,
  };
  return { stateDir, herdr, calls, manager: createSubmissions({ stateDir, herdr }) };
}

test("deduplicates concurrent requests and receipts survive restart", async (t) => {
  const { manager, calls, stateDir, herdr } = await setup(t);
  const input = request();
  const receipts = await Promise.all([manager.submit(input, "phone"), manager.submit(input, "phone")]);
  assert.equal(calls.length, 1);
  assert.deepEqual(receipts[0], receipts[1]);
  const restarted = createSubmissions({ stateDir, herdr });
  assert.deepEqual(await restarted.submit(input, "phone"), receipts[0]);
  assert.equal(calls.length, 1);
  await assert.rejects(async () => restarted.submit(input, "other-phone"), { status: 409 });
  await assert.rejects(async () => restarted.submit({ ...input, text: "different" }, "phone"), { status: 409 });
});

test("records uncertainty before input and never replays interrupted requests", async (t) => {
  let finish;
  const gate = new Promise((resolve) => { finish = resolve; });
  let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  const { manager, stateDir, herdr } = await setup(t, {
    submit: async () => { entered(); await gate; throw new Error("connection lost"); },
  });
  const input = request();
  const first = manager.submit(input, "phone");
  await ready;
  const files = await readdir(path.join(stateDir, "submissions"));
  const saved = JSON.parse(await readFile(path.join(stateDir, "submissions", files[0]), "utf8"));
  assert.equal(saved.receipt.state, "unknown");
  const restarted = createSubmissions({ stateDir, herdr: { ...herdr, submit: () => assert.fail("must not replay") } });
  assert.equal((await restarted.submit(input, "phone")).state, "unknown");
  finish();
  assert.equal((await first).state, "unknown");
});

test("stale sessions and pre-delivery native rejections preserve failed receipts", async (t) => {
  const { manager, calls } = await setup(t);
  assert.equal((await manager.submit(request({ sessionId: "old" }), "phone")).state, "failed");
  assert.equal(calls.length, 0);
  const rejected = await setup(t, { submit: async () => { throw Object.assign(new Error("Queue unsupported"), { delivery: "failed" }); } });
  const receipt = await rejected.manager.submit(request({ mode: "queue" }), "phone");
  assert.equal(receipt.state, "failed");
  assert.equal(receipt.message, "Queue unsupported");
});

test("all clients and raw input share the pane write lane", async (t) => {
  const sequence = [];
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const ready = new Promise((resolve) => { entered = resolve; });
  const { manager } = await setup(t, {
    submit: async (_target, text) => {
      sequence.push(`start:${text}`);
      entered();
      await gate;
      sequence.push(`end:${text}`);
      return { state: "delivered", message: "Sent" };
    },
    keys: async (_target, keys) => { sequence.push(keys); },
  });
  const first = manager.submit(request(), "phone");
  await ready;
  const key = manager.write("pane-1", "Escape");
  const second = manager.submit(request({ text: "next" }), "tablet");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sequence, ["start:hello"]);
  release();
  await Promise.all([first, key, second]);
  assert.deepEqual(sequence, ["start:hello", "end:hello", "Escape", "start:next", "end:next"]);
});

test("attachment preparation happens once after dedupe and rechecks session", async (t) => {
  const { stateDir, herdr, calls } = await setup(t);
  let uploads = 0;
  const manager = createSubmissions({ stateDir, herdr, prepareAttachment: async (_attachment, input) => {
    uploads++;
    return `${input.text} /image.png`;
  } });
  const input = request({ attachment: { name: "image.png", type: "image/png", data: "AAAA" } });
  await Promise.all([manager.submit(input, "phone"), manager.submit(input, "phone")]);
  assert.equal(uploads, 1);
  assert.equal(calls[0][1], "hello /image.png");

  const stale = createSubmissions({ stateDir, herdr, prepareAttachment: async () => {
    herdr.snapshot = async () => ({ agents: [] });
    return "image path";
  } });
  assert.equal((await stale.submit({ ...input, id: randomUUID() }, "phone")).state, "failed");
  assert.equal(calls.length, 1);
});

test("terminal attachments use the same dedupe and session checks as messages", async (t) => {
  const { stateDir, herdr, calls } = await setup(t);
  let uploads = 0;
  const manager = createSubmissions({ stateDir, herdr, prepareAttachment: async (_attachment, input) => {
    uploads++;
    return `${input.text}\n/image.png`;
  } });
  const input = request({ mode: "terminal", text: "  literal\ninput  ", attachment: { name: "image.png", type: "image/png", data: "AAAA" } });
  const [first, second] = await Promise.all([manager.submit(input, "phone"), manager.submit(input, "phone")]);
  assert.equal(first.state, "delivered");
  assert.deepEqual(second, first);
  assert.equal(uploads, 1);
  assert.deepEqual(calls, [["pane-1", "  literal\ninput  \n/image.png", "terminal"]]);

  const stop = await manager.submit({ ...input, id: randomUUID(), mode: "stop" }, "phone");
  assert.equal(stop.state, "failed");
  assert.equal(uploads, 1);
  assert.equal(calls.length, 1);

  const stale = createSubmissions({ stateDir, herdr, prepareAttachment: async () => {
    herdr.snapshot = async () => ({ agents: [{ id: "pane-1", sessionId: "session-2" }] });
    return "image path";
  } });
  assert.equal((await stale.submit({ ...input, id: randomUUID() }, "phone")).state, "failed");
  assert.equal(calls.length, 1);
});

test("uncertain bridge errors are not reported as failed or replayed", async (t) => {
  const { manager } = await setup(t, { submit: async () => { throw new Error("Lost response after write"); } });
  const input = request();
  assert.equal((await manager.submit(input, "phone")).state, "unknown");
  assert.equal((await manager.submit(input, "phone")).state, "unknown");
});

test("unknown session identity rejects native sends and stale terminal drafts", async (t) => {
  const { manager, calls } = await setup(t, { snapshot: async () => ({ agents: [{ id: "pane-1" }] }) });
  assert.equal((await manager.submit(request(), "phone")).state, "failed");
  assert.equal((await manager.submit(request({ mode: "terminal" }), "phone")).state, "failed");
  assert.equal(calls.length, 0);
  assert.equal((await manager.submit(request({ mode: "terminal", sessionId: "unresolved:pane-1" }), "phone")).state, "delivered");
});

test("session-bound keys are refused once the pane runs another session", async (t) => {
  let sessionId = "session-1";
  const { manager, calls } = await setup(t, {
    snapshot: async () => ({ agents: [{ id: "pane-1", sessionId }] }),
  });
  await manager.write("pane-1", "down", undefined, "session-1");
  assert.deepEqual(calls, [["pane-1", "down"]]);

  sessionId = "session-2";
  await assert.rejects(manager.write("pane-1", "enter", undefined, "session-1"), { status: 409, code: "session_changed" });
  // A pane that is gone, or one with no reported session, is not that session.
  sessionId = undefined;
  await assert.rejects(manager.write("pane-1", "enter", undefined, "session-1"), { status: 409 });
  await assert.rejects(manager.write("pane-9", "enter", undefined, "session-1"), { status: 409 });
  assert.equal(calls.length, 1, "nothing reached herdr after the session changed");

  // Unbound keys are Terminal's: they follow the pane whatever runs there.
  await manager.write("pane-1", "esc");
  assert.deepEqual(calls.at(-1), ["pane-1", "esc"]);
});

test("the session check waits its turn in the lane", async (t) => {
  let sessionId = "session-1";
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const ready = new Promise((resolve) => { entered = resolve; });
  const { manager, calls } = await setup(t, {
    snapshot: async () => ({ agents: [{ id: "pane-1", sessionId }] }),
    submit: async (...args) => { entered(); await gate; sessionId = "session-2"; calls.push(args); return { state: "delivered", message: "Sent" }; },
  });
  // The command ahead in the lane replaces the session; the key queued behind
  // it was aimed at the old one and must not land on the new one.
  const command = manager.submit(request({ text: "/new" }), "phone");
  await ready;
  const key = manager.write("pane-1", "enter", undefined, "session-1");
  const refused = assert.rejects(key, { status: 409, code: "session_changed" });
  release();
  await command;
  await refused;
  assert.equal(calls.length, 1);
});
