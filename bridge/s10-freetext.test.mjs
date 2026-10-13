import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { inspectAnswerDialog, planQuestionWrite, questionText } from "./prompt.mjs";
import { createHerdr } from "./herdr.mjs";
import { QUESTION_CONTROLS_ENABLED, questionControls } from "../src/lib/moshpit/question-controls.mjs";
import { boundaryEnv, bridgeCommand, freePort, isolatedEnv, pairDevice, passwordEnv } from "./test-support.mjs";

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../tests/fixtures/s10");
const readFixture = (name) => readFile(path.join(fixtureDir, name), "utf8");
const EMPTY = await readFixture("claude-2.1.296-other-empty.ansi");
const PINE = await readFixture("claude-2.1.296-other-pine.ansi");
const LEFT = await readFixture("claude-2.1.296-other-left.ansi");
const REVIEW = await readFixture("claude-2.1.296-other-review.ansi");
const SPACE = await readFixture("claude-2.1.296-other-space.ansi");
const SELECT = await readFixture("claude-2.1.296-multiselect-select.ansi");
const QUESTION = "Which capabilities should the renderer keep?";
const PINEAPPLE = PINE.replace("❯ 3. [✔] pine", "❯ 3. [✔] pineapple");

test("the captured other slot is empty only while Type something is focused", () => {
  const empty = inspectAnswerDialog("claude", EMPTY);
  const pine = inspectAnswerDialog("claude", PINE);
  const space = inspectAnswerDialog("claude", SPACE);
  const left = inspectAnswerDialog("claude", LEFT);
  const review = inspectAnswerDialog("claude", REVIEW);
  assert.equal(empty.kind, "questions");
  assert.deepEqual(empty.focus, { kind: "other", key: "3" });
  assert.deepEqual(empty.actions, ["text"]);
  assert.deepEqual(empty.questions[0].other, { key: "3", label: "Type something", text: "", multiline: false });
  assert.deepEqual(empty.answers, { [QUESTION]: [] });
  assert.deepEqual(pine.questions[0].other.text, "pine");
  assert.deepEqual(pine.actions, []);
  assert.deepEqual(pine.answers[QUESTION], ["pine"]);
  assert.deepEqual(space.questions[0].other.text, "red oak");
  assert.deepEqual(left.focus, { kind: "option", key: "2" });
  assert.deepEqual(left.actions, ["toggle", "review"]);
  assert.equal(review.phase, "review");
  assert.deepEqual(review.answers[QUESTION], ["pine"]);
  assert.equal(review.submitKey, "1");
  assert.deepEqual(planQuestionWrite(empty, { op: "text", questionId: QUESTION, text: "pine" }), { text: "pine" });
  assert.deepEqual(planQuestionWrite(empty, { op: "text", questionId: QUESTION, text: "red oak" }), { text: "red oak" });
  assert.equal(planQuestionWrite(pine, { op: "text", questionId: QUESTION, text: "more" }), null);
  assert.equal(planQuestionWrite(empty, { op: "text", questionId: QUESTION, text: " pine" }), null);
  assert.equal(planQuestionWrite(empty, { op: "review" }), null);
  assert.equal(questionText("Type something"), null);
  assert.equal(inspectAnswerDialog("claude", EMPTY.replace("ctrl+g to edit in Vim · ", "")).kind, "terminal");
  assert.equal(inspectAnswerDialog("claude", SELECT.replace("❯ 1. [ ] Color output", "  1. [ ] Color output").replace("  4. Chat about this", "❯ 4. Chat about this")).kind, "terminal");
  assert.equal(QUESTION_CONTROLS_ENABLED, false);
  assert.equal(questionControls({ ...empty, expected: { token: "t" } }), null);
  assert.deepEqual(questionControls({ ...empty, expected: { token: "t" } }, true).controls, [
    { op: "text", questionId: QUESTION, label: "Type something" },
  ]);
});

async function pane(t, card = EMPTY) {
  const dir = await mkdtemp(path.join(tmpdir(), "moshpit-s10-text-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const screen = path.join(dir, "screen");
  const writes = path.join(dir, "writes.jsonl");
  const session = path.join(dir, "session");
  const sessionNext = path.join(dir, "session-next");
  const fail = path.join(dir, "fail");
  const reactions = path.join(dir, "reactions.json");
  const bin = path.join(dir, "herdr-fixture");
  await writeFile(screen, card);
  await writeFile(writes, "");
  await writeFile(session, "session");
  await writeFile(reactions, "{}");
  await writeFile(bin, `#!${process.execPath}
import {appendFileSync, existsSync, readFileSync, writeFileSync} from 'node:fs';
const a=process.argv.slice(2);
const sessionFile=${JSON.stringify(session)};
const next=${JSON.stringify(sessionNext)};
if(a[0]==='api') {
  const session=readFileSync(sessionFile,'utf8').trim();
  console.log(JSON.stringify({result:{snapshot:{agents:[{pane_id:'pane',agent:'claude',agent_status:'blocked',agent_session:{kind:'id',value:session},cwd:'/tmp',revision:3}]}}}));
} else if(a[1]==='list') console.log(JSON.stringify({result:{panes:[{pane_id:'pane',terminal_id:'pane'}]}}));
else if(a[1]==='read') process.stdout.write(readFileSync(${JSON.stringify(screen)},'utf8'));
else if(a[1]==='send-text'||a[1]==='send-keys') {
  appendFileSync(${JSON.stringify(writes)}, JSON.stringify(a)+'\\n');
  if(existsSync(${JSON.stringify(fail)})) process.exit(1);
  if(a[1]==='send-text' && existsSync(next)) writeFileSync(sessionFile, readFileSync(next,'utf8'));
  const map=JSON.parse(readFileSync(${JSON.stringify(reactions)},'utf8'));
  const name=(a[1]==='send-text'?'text:':'keys:')+a[3];
  if(map[name]) writeFileSync(${JSON.stringify(screen)}, readFileSync(map[name]));
  console.log('{}');
} else console.log('{}');
`, { mode: 0o700 });
  await writeFile(path.join(dir, "package.json"), '{"type":"module"}');
  return {
    herdr: createHerdr({ bin }),
    react: (map) => writeFile(reactions, JSON.stringify(map)),
    fail: () => writeFile(fail, "1"),
    swapSession: (id) => writeFile(sessionNext, id),
    sent: async () => (await readFile(writes, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)),
    file: (name, text) => writeFile(path.join(dir, name), text).then(() => path.join(dir, name)),
  };
}

async function tokenOf(env) {
  const dialog = (await env.herdr.snapshot()).agents[0].blockedDialog;
  return { dialog, token: dialog.expected.token };
}

const pineChain = async (env) => {
  const pine = await env.file("pine.ansi", PINE);
  const left = await env.file("left.ansi", LEFT);
  const review = await env.file("review.ansi", REVIEW);
  const done = await env.file("done.ansi", SELECT);
  await env.react({ "text:pine": pine, "keys:up": left, "keys:right": review, "text:1": done });
};

test("free text inserts, checks the field, then submits with the probed keys", async (t) => {
  const env = await pane(t);
  await pineChain(env);
  const { token } = await tokenOf(env);
  const result = await env.herdr.answerQuestion("pane", token, { op: "text", questionId: QUESTION, text: "pine" });
  assert.equal(result.outcome, "delivered");
  assert.deepEqual(await env.sent(), [
    ["pane", "send-text", "pane", "pine"],
    ["pane", "send-keys", "pane", "up"],
    ["pane", "send-keys", "pane", "right"],
    ["pane", "send-text", "pane", "1"],
  ]);
  await assert.rejects(env.herdr.answerQuestion("pane", token, { op: "text", questionId: QUESTION, text: "pine" }), /no longer on screen/);
});

test("a field that is not the empty placeholder gets no insert and no commit", async (t) => {
  const env = await pane(t, PINE);
  const { token } = await tokenOf(env);
  await assert.rejects(env.herdr.answerQuestion("pane", token, { op: "text", questionId: QUESTION, text: "more" }), /no longer on screen/);
  assert.deepEqual(await env.sent(), []);
});

test("an insert that does not show the exact text sends no commit key", async (t) => {
  const env = await pane(t);
  const wrong = await env.file("wrong.ansi", PINEAPPLE);
  await env.react({ "text:pine": wrong });
  const { token } = await tokenOf(env);
  const result = await env.herdr.answerQuestion("pane", token, { op: "text", questionId: QUESTION, text: "pine" });
  assert.equal(result.outcome, "unknown");
  assert.deepEqual(await env.sent(), [["pane", "send-text", "pane", "pine"]]);
  await assert.rejects(env.herdr.answerQuestion("pane", token, { op: "text", questionId: QUESTION, text: "pine" }), /no longer on screen/);
});

test("a session change after the insert sends no commit key", async (t) => {
  const env = await pane(t);
  await pineChain(env);
  await env.swapSession("other-session");
  const { token } = await tokenOf(env);
  const result = await env.herdr.answerQuestion("pane", token, { op: "text", questionId: QUESTION, text: "pine" });
  assert.equal(result.outcome, "unknown");
  assert.deepEqual(await env.sent(), [["pane", "send-text", "pane", "pine"]]);
});

test("a failed insert stays unknown and cannot be replayed", async (t) => {
  const env = await pane(t);
  await env.fail();
  const { token } = await tokenOf(env);
  const result = await env.herdr.answerQuestion("pane", token, { op: "text", questionId: QUESTION, text: "pine" });
  assert.equal(result.outcome, "unknown");
  assert.deepEqual(await env.sent(), [["pane", "send-text", "pane", "pine"]]);
  await assert.rejects(env.herdr.answerQuestion("pane", token, { op: "text", questionId: QUESTION, text: "pine" }), /no longer on screen/);
});

test("the text action over HTTP delivers pine and refuses a control character", async (t) => {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const dir = await mkdtemp(path.join(tmpdir(), "moshpit-s10-text-http-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const screen = path.join(dir, "screen");
  const writes = path.join(dir, "writes.jsonl");
  const reactions = path.join(dir, "reactions.json");
  const bin = path.join(dir, "herdr-fixture");
  const files = { pine: path.join(dir, "pine.ansi"), left: path.join(dir, "left.ansi"), review: path.join(dir, "review.ansi"), done: path.join(dir, "done.ansi") };
  await writeFile(screen, EMPTY);
  await writeFile(files.pine, PINE);
  await writeFile(files.left, LEFT);
  await writeFile(files.review, REVIEW);
  await writeFile(files.done, SELECT);
  await writeFile(writes, "");
  await writeFile(reactions, JSON.stringify({ "text:pine": files.pine, "keys:up": files.left, "keys:right": files.review, "text:1": files.done }));
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
  const refused = await post({ kind: "answer", target: "pane", token, question: { op: "text", questionId: QUESTION, text: "pine\n" } });
  assert.equal(refused.status, 400);
  assert.equal((await readFile(writes, "utf8")).trim(), "");
  const sent = await post({ kind: "answer", target: "pane", token, question: { op: "text", questionId: QUESTION, text: "pine" } });
  assert.equal(sent.status, 200);
  assert.deepEqual(await sent.json(), { ok: true, outcome: "delivered" });
  assert.deepEqual((await readFile(writes, "utf8")).trim().split("\n").map((line) => JSON.parse(line)), [
    ["pane", "send-text", "pane", "pine"],
    ["pane", "send-keys", "pane", "up"],
    ["pane", "send-keys", "pane", "right"],
    ["pane", "send-text", "pane", "1"],
  ]);
});
