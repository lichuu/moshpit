import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { inspectAnswerDialog, planQuestionWrite } from "./prompt.mjs";
import { createHerdr } from "./herdr.mjs";
import { QUESTION_CONTROLS_ENABLED, questionControls } from "../src/lib/moshpit/question-controls.mjs";
import { boundaryEnv, bridgeCommand, freePort, isolatedEnv, pairDevice, passwordEnv } from "./test-support.mjs";

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../tests/fixtures/s10");
const readFixture = (name) => readFile(path.join(fixtureDir, name), "utf8");
const SELECT = await readFixture("claude-2.1.296-multiselect-select.ansi");
const CHECKED = await readFixture("claude-2.1.296-multiselect-checked.ansi");
const REVIEW = await readFixture("claude-2.1.296-multiselect-review.ansi");
const QUESTION = "Which capabilities should the renderer keep?";

const SINGLE = [
  "☐ Indent", "", "How should the generated file be indented?", "",
  "  1. Tabs (Recommended)", "     Indent code with tab characters.",
  "❯ 2. Spaces", "     Indent code with space characters.",
  "  3. Type something.", "", "  4. Chat about this", "",
  "Enter to select · ↑/↓ to navigate · Esc to cancel",
].join("\n");
const CODEX = [
  "Question 1/2 (2 unanswered)",
  "How should the generated file be indented?",
  "› 1. Tabs (Recommended)  Indent code with tab characters.",
  "  2. Spaces              Indent code with space characters.",
  "",
  "tab to add notes | enter to submit answer | ←/→ to navigate questions | esc to interrupt",
].join("\n");

function movedFocus(dump) {
  return dump
    .replace("❯ 1. [ ] Color output", "  1. [ ] Color output")
    .replace("  2. [ ] Nerd Font", "❯ 2. [ ] Nerd Font");
}

test("captured select, checked, and review screens fill the question model", async () => {
  const select = inspectAnswerDialog("claude", SELECT);
  const checked = inspectAnswerDialog("claude", CHECKED);
  const review = inspectAnswerDialog("claude", REVIEW);
  assert.equal(select.kind, "questions");
  assert.equal(select.family, "claude-ask-user-multiselect-v1");
  assert.equal(select.phase, "select");
  assert.equal(select.questions[0].id, QUESTION);
  assert.equal(select.questions[0].header, "Caps");
  assert.equal(select.questions[0].multiSelect, true);
  assert.deepEqual(select.questions[0].options.map((option) => [option.key, option.label, option.checked]), [
    ["1", "Color output", false],
    ["2", "Nerd Font", false],
  ]);
  assert.deepEqual(select.questions[0].other, { key: "3", label: "Type something", text: "", multiline: false });
  assert.deepEqual(select.answers, { [QUESTION]: [] });
  assert.deepEqual(select.focus, { kind: "option", key: "1" });
  assert.deepEqual(checked.answers[QUESTION], ["Nerd Font"]);
  assert.equal(checked.questions[0].options[1].checked, true);
  assert.notEqual(checked.signature, select.signature);
  assert.equal(review.phase, "review");
  assert.equal(review.questions[0].other, null);
  assert.deepEqual(review.questions[0].options, []);
  assert.equal(review.submitKey, "1");
  assert.deepEqual(review.focus, { kind: "submit", key: "1" });
  assert.deepEqual(planQuestionWrite(select, { op: "toggle", questionId: QUESTION, optionKey: "2" }), { key: "2" });
  assert.deepEqual(planQuestionWrite(checked, { op: "toggle", questionId: QUESTION, optionKey: "2" }), { key: "2" });
  assert.deepEqual(planQuestionWrite(select, { op: "review" }), { key: "right" });
  assert.deepEqual(planQuestionWrite(review, { op: "submit" }), { key: "1" });
  assert.equal(planQuestionWrite(review, { op: "toggle", questionId: QUESTION, optionKey: "1" }), null);
});

test("lookalikes, partial screens, extra rows, and unprobed pointers stay out of the family", () => {
  assert.equal(inspectAnswerDialog("claude", SINGLE).family, "claude-ask-user-question-v1");
  assert.equal(inspectAnswerDialog("codex", CODEX).family, "codex-request-user-input-v1");
  assert.equal(inspectAnswerDialog("claude", "Allow this tool?\n❯ 1. Yes\n  2. No").kind, "terminal");
  assert.equal(inspectAnswerDialog("claude", SELECT.split("\n").slice(0, -2).join("\n")).kind, "terminal");
  assert.equal(inspectAnswerDialog("claude", SELECT.replace("❯ 1. [ ] Color output", "  1. [ ] Color output").replace("  3. [ ] Type something", "❯ 3. [ ] Type something")).kind, "terminal");
  assert.equal(inspectAnswerDialog("claude", SELECT.replace("❯ 1. [ ] Color output", "  1. [ ] Color output").replace("  4. Chat about this", "❯ 4. Chat about this")).kind, "terminal");
  assert.equal(inspectAnswerDialog("claude", SELECT.replace("  3. [ ] Type something", "❯ 3. [✔] Type something")).kind, "terminal");
  assert.equal(inspectAnswerDialog("claude", SELECT.replace("  2. [ ] Nerd Font", "  2. [ ] Nerd Font\n  3. [ ] Extra\n         More.").replace("  3. [ ] Type something", "  4. [ ] Type something").replace("  4. Chat about this", "  5. Chat about this")).kind, "terminal");
  assert.equal(inspectAnswerDialog("claude", SELECT.replace("←  ☐ Caps  ✔ Submit  →", "←  ☐ Caps  ✔ Submit  →\n←  ☐ Width  ✔ Submit  →")).kind, "terminal");
  assert.equal(inspectAnswerDialog("claude", REVIEW.replace("   → Nerd Font", "   → Nerd Font\n ● Second question?\n   → Other")).kind, "terminal");
  assert.equal(inspectAnswerDialog("claude", movedFocus(SELECT)).kind, "questions");
  assert.notEqual(inspectAnswerDialog("claude", movedFocus(SELECT)).signature, inspectAnswerDialog("claude", SELECT).signature);
});

test("phone controls stay off unless a caller turns the gate on", () => {
  const dialog = inspectAnswerDialog("claude", SELECT);
  assert.equal(QUESTION_CONTROLS_ENABLED, false);
  assert.equal(questionControls({ ...dialog, expected: { token: "t" } }), null);
  const shown = questionControls({ ...dialog, expected: { token: "t" } }, true);
  assert.equal(shown.token, "t");
  assert.deepEqual(shown.controls.map((control) => control.op), ["toggle", "toggle", "review"]);
  assert.equal(questionControls({ ...dialog, expected: { token: "t" }, phase: "review", actions: ["submit"], submitKey: "1" }, true).controls[0].op, "submit");
});

async function pane(t, card = SELECT) {
  const dir = await mkdtemp(path.join(tmpdir(), "moshpit-s10-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const screen = path.join(dir, "screen");
  const writes = path.join(dir, "writes.jsonl");
  const reads = path.join(dir, "reads");
  const reactions = path.join(dir, "reactions.json");
  const session = path.join(dir, "session");
  const fail = path.join(dir, "fail");
  const bin = path.join(dir, "herdr-fixture");
  await writeFile(screen, card);
  await writeFile(writes, "");
  await writeFile(reads, "");
  await writeFile(reactions, "{}");
  await writeFile(session, "session");
  await writeFile(bin, `#!${process.execPath}
import {appendFileSync, existsSync, readFileSync, writeFileSync} from 'node:fs';
const a=process.argv.slice(2);
const session=readFileSync(${JSON.stringify(session)},'utf8').trim();
if(a[0]==='api') console.log(JSON.stringify({result:{snapshot:{agents:[{pane_id:'pane',agent:'claude',agent_status:'blocked',agent_session:{kind:'id',value:session},cwd:'/tmp',revision:3}]}}}));
else if(a[1]==='list') console.log(JSON.stringify({result:{panes:[{pane_id:'pane',terminal_id:'pane'}]}}));
else if(a[1]==='read') { appendFileSync(${JSON.stringify(reads)}, '1'); process.stdout.write(readFileSync(${JSON.stringify(screen)},'utf8')); }
else if(a[1]==='send-text'||a[1]==='send-keys') {
  appendFileSync(${JSON.stringify(writes)}, JSON.stringify(a)+'\\n');
  if(existsSync(${JSON.stringify(fail)})) process.exit(1);
  const map=JSON.parse(readFileSync(${JSON.stringify(reactions)},'utf8'));
  const name=(a[1]==='send-text'?'text:':'keys:')+a[3];
  if(map[name]) writeFileSync(${JSON.stringify(screen)}, readFileSync(map[name]));
  console.log('{}');
} else console.log('{}');
`, { mode: 0o700 });
  await writeFile(path.join(dir, "package.json"), '{"type":"module"}');
  return {
    herdr: createHerdr({ bin }),
    show: (text) => writeFile(screen, text),
    session: (id) => writeFile(session, id),
    react: (map) => writeFile(reactions, JSON.stringify(map)),
    fail: () => writeFile(fail, "1"),
    sent: async () => (await readFile(writes, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)),
    reads: async () => (await readFile(reads, "utf8")).length,
    file: (name, text) => {
      const target = path.join(dir, name);
      return writeFile(target, text).then(() => target);
    },
  };
}

async function dialogOf(env) {
  return (await env.herdr.snapshot()).agents[0].blockedDialog;
}

test("a blocked multi-select publishes questions and no positional inbox keys", async (t) => {
  const env = await pane(t);
  const dialog = await dialogOf(env);
  const agent = (await env.herdr.snapshot()).agents[0];
  assert.equal(dialog.kind, "questions");
  assert.equal(dialog.phase, "select");
  assert.deepEqual(agent.blockedOptions, []);
  assert.equal(agent.blockedPrompt, QUESTION);
});

test("toggle, review, and submit send the captured key and nothing else", async (t) => {
  const env = await pane(t);
  const checked = await env.file("checked.ansi", SELECT.replace("[ ] Color output", "[✔] Color output"));
  const review = await env.file("review.ansi", REVIEW);
  const gone = await env.file("gone.ansi", "working\n");
  await env.react({ "text:1": checked, "keys:right": review, "text:1-submit": gone });
  const select = await dialogOf(env);
  await env.react({ "text:1": checked });
  const toggled = await env.herdr.answerQuestion("pane", select.expected.token, { op: "toggle", questionId: QUESTION, optionKey: "1" });
  assert.equal(toggled.outcome, "delivered");
  await env.show(CHECKED);
  const reviewToken = (await dialogOf(env)).expected.token;
  await env.react({ "keys:right": review });
  const reviewed = await env.herdr.answerQuestion("pane", reviewToken, { op: "review" });
  assert.equal(reviewed.outcome, "delivered");
  await env.show(REVIEW);
  const submitToken = (await dialogOf(env)).expected.token;
  await env.react({ "text:1": gone });
  const submitted = await env.herdr.answerQuestion("pane", submitToken, { op: "submit" });
  assert.equal(submitted.outcome, "delivered");
  assert.deepEqual(await env.sent(), [
    ["pane", "send-text", "pane", "1"],
    ["pane", "send-keys", "pane", "right"],
    ["pane", "send-text", "pane", "1"],
  ]);
});

test("review compares the answer set, and submit uses the printed digit when focus is on Cancel", async (t) => {
  const both = SELECT
    .replace("[ ] Color output", "[✔] Color output")
    .replace("[ ] Nerd Font", "[✔] Nerd Font");
  const swapped = REVIEW.replace("→ Nerd Font", "→ Nerd Font, Color output");
  const env = await pane(t, both);
  const reviewFile = await env.file("swapped.ansi", swapped);
  await env.react({ "keys:right": reviewFile });
  const token = (await dialogOf(env)).expected.token;
  assert.equal((await env.herdr.answerQuestion("pane", token, { op: "review" })).outcome, "delivered");
  const cancelFocus = REVIEW.replace("❯ 1. Submit answers", "  1. Submit answers").replace("  2. Cancel", "❯ 2. Cancel");
  await env.show(cancelFocus);
  const submit = await dialogOf(env);
  assert.equal(submit.focus.kind, "cancel");
  const gone = await env.file("gone.ansi", "noted\n");
  await env.react({ "text:1": gone });
  assert.equal((await env.herdr.answerQuestion("pane", submit.expected.token, { op: "submit" })).outcome, "delivered");
  assert.deepEqual(await env.sent(), [
    ["pane", "send-keys", "pane", "right"],
    ["pane", "send-text", "pane", "1"],
  ]);
});

test("a stale screen, a focus change, a session change, and a replay send nothing", async (t) => {
  const env = await pane(t);
  const token = (await dialogOf(env)).expected.token;
  await env.show(movedFocus(SELECT));
  await assert.rejects(env.herdr.answerQuestion("pane", token, { op: "toggle", questionId: QUESTION, optionKey: "1" }), /no longer on screen/);
  await env.show(SELECT);
  await env.session("other-session");
  await env.herdr.snapshot();
  await assert.rejects(env.herdr.answerQuestion("pane", token, { op: "toggle", questionId: QUESTION, optionKey: "1" }), /no longer on screen/);
  await env.session("session");
  const fresh = (await dialogOf(env)).expected.token;
  const checked = await env.file("one.ansi", SELECT.replace("[ ] Color output", "[✔] Color output"));
  await env.react({ "text:1": checked });
  await env.herdr.answerQuestion("pane", fresh, { op: "toggle", questionId: QUESTION, optionKey: "1" });
  await assert.rejects(env.herdr.answerQuestion("pane", fresh, { op: "toggle", questionId: QUESTION, optionKey: "1" }), /no longer on screen/);
  assert.deepEqual(await env.sent(), [["pane", "send-text", "pane", "1"]]);
});

test("an unchanged screen is unknown, spends the token, and is not a replay", async (t) => {
  const env = await pane(t);
  const token = (await dialogOf(env)).expected.token;
  const result = await env.herdr.answerQuestion("pane", token, { op: "toggle", questionId: QUESTION, optionKey: "1" });
  assert.equal(result.outcome, "unknown");
  assert.equal(await env.reads(), 10);
  const again = await dialogOf(env);
  assert.equal(again.expected.token, token);
  await assert.rejects(env.herdr.answerQuestion("pane", token, { op: "toggle", questionId: QUESTION, optionKey: "1" }), /no longer on screen/);
  assert.deepEqual(await env.sent(), [["pane", "send-text", "pane", "1"]]);
});

test("a write that fails after dispatch is unknown and is not retried", async (t) => {
  const env = await pane(t);
  const token = (await dialogOf(env)).expected.token;
  await env.fail();
  assert.equal((await env.herdr.answerQuestion("pane", token, { op: "review" })).outcome, "unknown");
  await assert.rejects(env.herdr.answerQuestion("pane", token, { op: "review" }), /no longer on screen/);
  assert.deepEqual(await env.sent(), [["pane", "send-keys", "pane", "right"]]);
});

test("a choose answer cannot spend a multi-select token", async (t) => {
  const env = await pane(t);
  const token = (await dialogOf(env)).expected.token;
  await assert.rejects(env.herdr.answer("pane", token, "1"), /no longer on screen/);
  assert.deepEqual(await env.sent(), []);
  const checked = await env.file("one.ansi", SELECT.replace("[ ] Color output", "[✔] Color output"));
  await env.react({ "text:1": checked });
  assert.equal((await env.herdr.answerQuestion("pane", token, { op: "toggle", questionId: QUESTION, optionKey: "1" })).outcome, "delivered");
});

test("the question action returns an outcome and refuses a mixed body", async (t) => {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const dir = await mkdtemp(path.join(tmpdir(), "moshpit-s10-http-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const screen = path.join(dir, "screen");
  const writes = path.join(dir, "writes.jsonl");
  const reactions = path.join(dir, "reactions.json");
  const checked = path.join(dir, "checked.ansi");
  const bin = path.join(dir, "herdr-fixture");
  await writeFile(screen, SELECT);
  await writeFile(checked, SELECT.replace("[ ] Color output", "[✔] Color output"));
  await writeFile(writes, "");
  await writeFile(reactions, JSON.stringify({ "text:1": checked }));
  await writeFile(bin, `#!${process.execPath}
import {appendFileSync, readFileSync, writeFileSync} from 'node:fs';
const a=process.argv.slice(2);
if(a[0]==='api') console.log(JSON.stringify({result:{snapshot:{agents:[{pane_id:'pane',agent:'claude',agent_status:'blocked',agent_session:{kind:'id',value:'session'},cwd:'/tmp',revision:3}]}}}));
else if(a[1]==='list') console.log(JSON.stringify({result:{panes:[{pane_id:'pane',terminal_id:'pane'}]}}));
else if(a[1]==='read') process.stdout.write(readFileSync(${JSON.stringify(screen)},'utf8'));
else if(a[1]==='send-text'||a[1]==='send-keys') {
  appendFileSync(${JSON.stringify(writes)}, JSON.stringify(a)+'\\n');
  const map=JSON.parse(readFileSync(${JSON.stringify(reactions)},'utf8'));
  const name=(a[1]==='send-text'?'text:':'keys:')+a[3];
  if(map[name]) writeFileSync(${JSON.stringify(screen)}, readFileSync(map[name]));
  console.log('{}');
} else console.log('{}');
`, { mode: 0o700 });
  await writeFile(path.join(dir, "package.json"), '{"type":"module"}');
  const child = spawn(...bridgeCommand(), {
    env: {
      ...isolatedEnv(),
      ...boundaryEnv(port),
      MOSHPIT_BIND: "127.0.0.1",
      ...await passwordEnv(dir),
      MOSHPIT_STATE_DIR: path.join(dir, "state"),
      MOSHPIT_HERDR_BIN: bin,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    child.kill();
    await once(child, "exit").catch(() => {});
  });
  await once(child.stdout, "data");
  const login = await fetch(`${url}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: url },
    body: JSON.stringify({ password: "review-pass" }),
  }).then((res) => res.json());
  const headers = {
    "content-type": "application/json",
    origin: url,
    authorization: `Bearer ${login.token}`,
    "x-moshpit-device": "review",
  };
  headers["x-moshpit-device"] = await pairDevice(url, headers, { stateDir: path.join(dir, "state") });
  const post = (body) => fetch(`${url}/api/action`, { method: "POST", headers, body: JSON.stringify(body) });
  const snap = await fetch(`${url}/api/snapshot`, { headers }).then((res) => res.json());
  const token = snap.agents[0].blockedDialog.expected.token;
  const mixed = await post({
    kind: "answer",
    target: "pane",
    token,
    optionKey: "1",
    question: { op: "toggle", questionId: QUESTION, optionKey: "1" },
  });
  assert.equal(mixed.status, 400);
  assert.equal((await readFile(writes, "utf8")).trim(), "");
  const toggled = await post({
    kind: "answer",
    target: "pane",
    token,
    question: { op: "toggle", questionId: QUESTION, optionKey: "1" },
  });
  assert.equal(toggled.status, 200);
  assert.deepEqual(await toggled.json(), { ok: true, outcome: "delivered" });
  assert.deepEqual(JSON.parse((await readFile(writes, "utf8")).trim()), ["pane", "send-text", "pane", "1"]);
});
