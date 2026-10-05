import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, appendFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSessionReader } from "./sessions.mjs";

async function fixture(t, kind, records) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "moshpit-session-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "session.jsonl");
  await writeFile(file, records.map(JSON.stringify).join("\n") + "\n");
  const agent = { id: "pane", kind, session: { agent: kind, kind: "path", source: "test", value: file } };
  return { file, agent, read: createSessionReader() };
}
const codexMessage = (role, value) => ({ type: "response_item", payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text: value }] } });
const grok = (update) => ({ timestamp: 1, method: "session/update", params: { sessionId: "native", update } });

test("Codex preserves paragraphs and code, completes tools, and paginates", async (t) => {
  const rows = Array.from({ length: 110 }, (_, i) => codexMessage("user", `Prompt ${i}`));
  rows.push(codexMessage("assistant", "First paragraph\n\nSecond paragraph\n\n```js\nconst x = 1;\n```"));
  rows.push({ type: "response_item", payload: { type: "function_call", call_id: "call", name: "exec", arguments: '{"cmd":"true"}' } });
  rows.push({ type: "response_item", payload: { type: "function_call_output", call_id: "call", output: "passed" } });
  const { agent, read } = await fixture(t, "codex", rows);
  const first = await read(agent);
  assert.equal(first.kind, "available");
  assert.equal(first.entries.length, 100);
  assert.match(first.entries.at(-2).text, /First paragraph\n\nSecond paragraph/);
  assert.equal(first.entries.at(-1).status, "complete");
  const older = await read(agent, { before: first.before });
  assert.equal(older.entries.length, 12);
  assert.equal(older.before, null);
  const unchanged = await read(agent, { after: first.cursor });
  assert.deepEqual(unchanged.entries, []);
});

test("complete JSONL lines only; streamed Grok text and tools update stable IDs", async (t) => {
  const { file, agent, read } = await fixture(t, "grok", [grok({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Hello" } }), grok({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "First" } })]);
  const first = await read(agent);
  const delta = JSON.stringify(grok({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "\n\nSecond" } }));
  await appendFile(file, delta.slice(0, 20));
  assert.deepEqual((await read(agent, { after: first.cursor })).entries, []);
  await appendFile(file, delta.slice(20) + "\n");
  const next = await read(agent, { after: first.cursor });
  assert.equal(next.entries.length, 1);
  assert.equal(next.entries[0].id, first.entries[1].id);
  assert.equal(next.entries[0].text, "First\n\nSecond");
  await appendFile(file, [grok({ sessionUpdate: "tool_call", toolCallId: "x", title: "Run tests", rawInput: { command: "false" } }), grok({ sessionUpdate: "tool_call_update", toolCallId: "x", status: "failed", content: [{ type: "content", content: { type: "text", text: "test failed" } }] })].map(JSON.stringify).join("\n") + "\n");
  const tool = (await read(agent, { after: next.cursor })).entries[0];
  assert.equal(tool.status, "failed"); assert.equal(tool.output, "test failed");
});

test("Pi follows active parent chain and resets after branching", async (t) => {
  const rows = [{ type: "session", id: "s" }, { type: "message", id: "a", parentId: null, message: { role: "user", content: "Hello" } }, { type: "message", id: "b", parentId: "a", message: { role: "assistant", content: [{ type: "text", text: "Old branch" }] } }];
  const { agent, read, file } = await fixture(t, "pi", rows);
  const first = await read(agent);
  await appendFile(file, JSON.stringify({ type: "message", id: "c", parentId: "a", message: { role: "assistant", content: [{ type: "text", text: "New branch" }] } }) + "\n");
  const next = await read(agent, { after: first.cursor });
  assert.equal(next.reset, true);
  assert.deepEqual(next.entries.map((e) => e.text), ["Hello", "New branch"]);
});

test("Pi skill invocations show as the typed command, not the expanded SKILL.md", async (t) => {
  const skill = (args) => `<skill name="poteto-mode" location="/home/u/.pi/agent/skills/poteto-mode/SKILL.md">\nReferences are relative to /home/u/.pi/agent/skills/poteto-mode.\n\n# Poteto mode\n\nRemaining triggers:\n</skill>${args ? `\n\n${args}` : ""}`;
  const { agent, read } = await fixture(t, "pi", [
    { type: "session", id: "s" },
    { type: "message", id: "a", parentId: null, message: { role: "user", content: [{ type: "text", text: skill("check out master") }] } },
    { type: "message", id: "b", parentId: "a", message: { role: "user", content: [{ type: "text", text: skill("") }] } },
  ]);
  assert.deepEqual((await read(agent)).entries.map((e) => e.text), ["/skill:poteto-mode check out master", "/skill:poteto-mode"]);
});

test("Claude native content supports tools, errors, and ignores sidechains", async (t) => {
  const { agent, read } = await fixture(t, "claude", [
    { type: "user", uuid: "u", message: { content: "Hello\n\nworld" } },
    { type: "assistant", uuid: "a", message: { content: [{ type: "text", text: "Checking" }, { type: "tool_use", id: "t", name: "Bash", input: { command: "false" } }] } },
    { type: "user", uuid: "r", message: { content: [{ type: "tool_result", tool_use_id: "t", content: "error", is_error: true }] } },
    { type: "assistant", uuid: "child", isSidechain: true, message: { content: "Child session" } },
  ]);
  const result = await read(agent);
  assert.equal(result.entries.length, 3);
  assert.equal(result.entries[2].status, "failed");
  assert.deepEqual(result.capabilities, { inputModes: ["send"], stop: false, fit: false });
});

test("Claude rows the harness injected stay out of the conversation", async (t) => {
  const { agent, read } = await fixture(t, "claude", [
    { type: "user", uuid: "u", message: { content: "use the skill" } },
    { type: "assistant", uuid: "a", message: { content: [{ type: "tool_use", id: "t", name: "Skill", input: { skill: "poteto-mode" } }] } },
    { type: "user", uuid: "r", message: { content: [{ type: "tool_result", tool_use_id: "t", content: "Launching skill: poteto-mode" }] } },
    { type: "user", uuid: "m", isMeta: true, sourceToolUseID: "t", message: { content: [{ type: "text", text: "Base directory for this skill: /home/u/.claude/skills/poteto-mode\n\n# Poteto mode" }] } },
    { type: "user", uuid: "i", isMeta: true, message: { content: [{ type: "text", text: "[Image: original 1320x2868, displayed at 921x2000.]" }] } },
    { type: "assistant", uuid: "b", message: { content: "On it" } },
  ]);
  const { entries } = await read(agent);
  assert.deepEqual(entries.map((e) => e.text ?? e.title), ["use the skill", "Skill", "On it"]);
  assert.equal(entries[2].turnId, "u");
});

test("truncation and wrong-session cursors reset rather than mixing histories", async (t) => {
  const { agent, read, file } = await fixture(t, "codex", [codexMessage("user", "A long initial prompt"), codexMessage("assistant", "Old answer")]);
  const first = await read(agent);
  await writeFile(file, JSON.stringify(codexMessage("user", "New")) + "\n");
  const next = await read(agent, { after: first.cursor });
  assert.equal(next.reset, true); assert.equal(next.entries[0].text, "New");
  assert.equal((await read(agent, { after: "invalid" })).reset, true);
});

test("missing exact metadata cannot fall back to cwd/newest files", async () => {
  const read = createSessionReader();
  const response = await read({ id: "pane", kind: "codex", cwd: process.cwd() });
  assert.equal(response.kind, "unavailable");
  assert.match(response.reason, /exact native session/);
});

test("OpenCode uses registered existing server, verifies session, and preserves part IDs", async () => {
  const paths = [];
  const read = createSessionReader({ openCodeServers: { ses_existing: { url: "http://127.0.0.1:4096", directory: "/project" } }, fetch: async (url, options) => {
    paths.push(url.pathname);
    assert.equal(options.headers["x-opencode-directory"], "/project");
    return { ok: true, json: async () => url.pathname.endsWith("/message") ? [{ info: { id: "msg", role: "assistant", parentID: "user" }, parts: [{ id: "part", type: "text", text: "Hello\n\nthere" }, { id: "toolpart", type: "tool", tool: "bash", callID: "call", state: { status: "error", input: { command: "false" }, error: "Failed" } }] }] : { id: "ses_existing" } };
  } });
  const agent = { id: "pane", kind: "opencode", session: { kind: "id", value: "ses_existing" } };
  const result = await read(agent);
  assert.equal(result.kind, "available"); assert.equal(result.entries[0].id, "part");
  assert.equal(result.entries[1].status, "failed");
  assert.deepEqual(paths, ["/session/ses_existing", "/session/ses_existing/message"]);
  const missing = await createSessionReader()(agent);
  assert.equal(missing.kind, "unavailable");
});

test("question tools become tappable entries and resolve on the tool result", async (t) => {
  const { agent, read, file } = await fixture(t, "claude", [
    { type: "assistant", uuid: "a", message: { content: [{ type: "text", text: "Let me ask." }, { type: "tool_use", id: "q1", name: "AskUserQuestion", input: { questions: [{ question: "Which accent?", multiSelect: false, options: [{ label: "green", description: "herdr accent" }, { label: "mauve" }] }] } }] } },
    { type: "assistant", uuid: "b", message: { content: [{ type: "tool_use", id: "q2", name: "ask_user_question", input: { questions: [{ question: "Multi?", multiSelect: true, options: [{ label: "a" }, { label: "b" }] }, { question: "No options", options: [] }] } }] } },
  ]);
  const first = await read(agent);
  assert.equal(first.entries.length, 3);
  const [note, ask, multi] = first.entries;
  assert.equal(note.kind, "message");
  assert.equal(ask.kind, "question");
  assert.deepEqual(ask.questions, [{ text: "Which accent?", multi: false, options: [{ label: "green", description: "herdr accent" }, { label: "mauve", description: undefined }] }]);
  assert.equal(ask.resolved, false);
  assert.equal(multi.kind, "question");
  // An option-less question keeps its position rather than being dropped: the
  // tap recipe counts positions, so removing one here would shift every later
  // question out of step with what the TUI is showing.
  assert.deepEqual(multi.questions, [
    { text: "Multi?", multi: true, options: [{ label: "a", description: undefined }, { label: "b", description: undefined }] },
    { text: "No options", multi: false, options: [] },
  ]);
  await appendFile(file, JSON.stringify({ type: "user", uuid: "r", message: { content: [{ type: "tool_result", tool_use_id: "q1", content: [{ type: "text", text: "The user chose green." }] }] } }) + "\n");
  const next = await read(agent, { after: first.cursor });
  const resolved = next.entries.find((entry) => entry.kind === "question");
  assert.equal(resolved.resolved, true);
  assert.equal(resolved.answer, "The user chose green.");
  const again = await read(agent, { after: next.cursor });
  assert.deepEqual(again.entries, []);
});

test("a question-shaped input without options stays an activity", async (t) => {
  const { agent, read } = await fixture(t, "codex", [
    { type: "response_item", payload: { type: "function_call", call_id: "q", name: "ask_user", arguments: '{"questions":"free text only"}' } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "q", output: "ok" } },
  ]);
  const result = await read(agent);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].kind, "activity");
  assert.equal(result.entries[0].status, "complete");
});

test("every ask tool family becomes a question entry when shaped", async (t) => {
  const { agent, read } = await fixture(t, "codex", [
    "AskUser", "request_user_input", "user_input", "elicit",
  ].map((name, i) => ({ type: "response_item", payload: { type: "function_call", call_id: `c${i}`, name, arguments: JSON.stringify({ questions: [{ id: `id-${i}`, header: `H${i}`, question: `Q${i}?`, options: [{ label: `L${i}` }] }] }) } })));
  const result = await read(agent);
  assert.equal(result.entries.length, 4);
  for (const [i, entry] of result.entries.entries()) {
    assert.equal(entry.kind, "question");
    assert.equal(entry.resolved, false);
    assert.equal(entry.questions[0].id, `id-${i}`);
    assert.equal(entry.questions[0].header, `H${i}`);
  }
});

test("codex request_user_input normalizes and maps shuffled keyed answers by id", async (t) => {
  const { agent, read, file } = await fixture(t, "codex", [
    { type: "response_item", payload: { type: "function_call", call_id: "c1", name: "request_user_input",
      arguments: JSON.stringify({ questions: [
        { header: "Deployment", id: "deployment", question: "Which deployment experience should we design first?",
          options: [{ label: "Own machine (Recommended)", description: "Run it on your laptop" }, { label: "Remote server" }, { label: "Both equally" }] },
        { header: "Networking", id: "networking", question: "How should the machines talk to each other?",
          options: [{ label: "Require Tailscale (Recommended)" }, { label: "Public ports" }] },
        { header: "First step", id: "first_step", question: "What is the first step after choosing?",
          options: [{ label: "One command, then browser (Recommended)" }, { label: "Full setup docs" }] },
      ] }) } },
  ]);
  const first = await read(agent);
  assert.equal(first.entries.length, 1);
  assert.equal(first.entries[0].kind, "question");
  const next = await read(agent, { after: first.cursor });
  assert.deepEqual(next.entries, []);
  // Result object order is shuffled relative to the questions: the mapping
  // must follow ids, never object order.
  const output = JSON.stringify({ answers: {
    first_step: { answers: ["One command, then browser (Recommended)"] },
    networking: { answers: ["Require Tailscale (Recommended)"] },
    deployment: { answers: ["Own machine (Recommended)"] },
  } });
  await appendFile(file, JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: "c1", output } }) + "\n");
  const resolved = (await read(agent, { after: first.cursor })).entries.find((entry) => entry.kind === "question");
  assert.equal(resolved.resolved, true);
  assert.equal(resolved.answer, undefined);
  assert.deepEqual(resolved.questions[0].answers, ["Own machine (Recommended)"]);
  assert.deepEqual(resolved.questions[1].answers, ["Require Tailscale (Recommended)"]);
  assert.deepEqual(resolved.questions[2].answers, ["One command, then browser (Recommended)"]);
  assert.deepEqual((await read(agent, { after: (await read(agent)).cursor })).entries, []);
});

test("duplicate question ids disable keyed answer mapping", async (t) => {
  const { agent, read, file } = await fixture(t, "codex", [
    { type: "response_item", payload: { type: "function_call", call_id: "c1", name: "request_user_input",
      arguments: JSON.stringify({ questions: [
        { id: "a", question: "First?", options: [{ label: "L1" }] },
        { id: "a", question: "Second?", options: [{ label: "L2" }] },
      ] }) } },
  ]);
  await appendFile(file, JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: JSON.stringify({ answers: { a: { answers: ["L1"] } } }) } }) + "\n");
  const resolved = (await read(agent)).entries.find((entry) => entry.kind === "question");
  assert.equal(resolved.resolved, true);
  assert.equal(resolved.questions[0].answers, undefined);
  assert.equal(resolved.questions[1].answers, undefined);
  assert.equal(resolved.answer, JSON.stringify({ answers: { a: { answers: ["L1"] } } }));
});

test("malformed keyed values stay absent; no match keeps the legacy text", async (t) => {
  const { agent: a1, read: r1, file: f1 } = await fixture(t, "codex", [
    { type: "response_item", payload: { type: "function_call", call_id: "c1", name: "user_input",
      arguments: JSON.stringify({ questions: [{ id: "ok", question: "A?", options: [{ label: "a" }] }, { id: "bad", question: "B?", options: [{ label: "b" }] }] }) } },
  ]);
  await appendFile(f1, JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: JSON.stringify({ answers: { ok: { answers: ["a"] }, bad: { answers: "scalar" } } }) } }) + "\n");
  const partial = (await r1(a1)).entries.find((entry) => entry.kind === "question");
  assert.deepEqual(partial.questions[0].answers, ["a"]);
  assert.equal(partial.questions[1].answers, undefined);
  assert.equal(partial.answer, undefined);

  const { agent: a2, read: r2, file: f2 } = await fixture(t, "codex", [
    { type: "response_item", payload: { type: "function_call", call_id: "c2", name: "user_input",
      arguments: JSON.stringify({ questions: [{ id: "bad", question: "B?", options: [{ label: "b" }] }] }) } },
  ]);
  await appendFile(f2, JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: "c2", output: JSON.stringify({ answers: { bad: { answers: [1, 2] } } }) } }) + "\n");
  const legacy = (await r2(a2)).entries.find((entry) => entry.kind === "question");
  assert.equal(legacy.questions[0].answers, undefined);
  assert.equal(legacy.answer, JSON.stringify({ answers: { bad: { answers: [1, 2] } } }));
});

test("failed results never populate answers", async (t) => {
  const { agent, read } = await fixture(t, "claude", [
    { type: "assistant", uuid: "a", message: { content: [{ type: "tool_use", id: "q", name: "AskUserQuestion", input: { questions: [{ id: "a", question: "A?", options: [{ label: "a" }] }] } }] } },
    { type: "user", uuid: "r", message: { content: [{ type: "tool_result", tool_use_id: "q", content: [{ type: "text", text: JSON.stringify({ answers: { a: { answers: ["a"] } } }) }], is_error: true }] } },
  ]);
  const resolved = (await read(agent)).entries.find((entry) => entry.kind === "question");
  assert.equal(resolved.resolved, true);
  assert.equal(resolved.questions[0].answers, undefined);
  assert.equal(resolved.answer, JSON.stringify({ answers: { a: { answers: ["a"] } } }));
});

test("plain text results keep the legacy answer text", async (t) => {
  const { agent, read } = await fixture(t, "codex", [
    { type: "response_item", payload: { type: "function_call", call_id: "c1", name: "request_user_input",
      arguments: JSON.stringify({ questions: [{ id: "a", question: "A?", options: [{ label: "a" }] }] }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "The user chose a." } },
  ]);
  const resolved = (await read(agent)).entries.find((entry) => entry.kind === "question");
  assert.equal(resolved.resolved, true);
  assert.equal(resolved.questions[0].answers, undefined);
  assert.equal(resolved.answer, "The user chose a.");
});
