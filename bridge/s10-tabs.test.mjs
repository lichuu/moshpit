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
const FACE = await readFixture("claude-2.1.296-tabs-face.ansi");
const WEIGHT = await readFixture("claude-2.1.296-tabs-weight.ansi");
const REVIEW = await readFixture("claude-2.1.296-tabs-review.ansi");
const PARTIAL = await readFixture("claude-2.1.296-tabs-partial.ansi");
const UNANSWERED = await readFixture("claude-2.1.296-tabs-unanswered.ansi");
const THREE = await readFixture("claude-2.1.296-three.ansi");
const THREE_CHECKED = await readFixture("claude-2.1.296-three-checked.ansi");
const THREE_REVIEW = await readFixture("claude-2.1.296-three-review.ansi");
const FACE_Q = "Which faces should the log use?";
const WEIGHT_Q = "Which weights should the log use?";

test("two tabs and a three-option card fill the same question model", () => {
  const face = inspectAnswerDialog("claude", FACE);
  const weight = inspectAnswerDialog("claude", WEIGHT);
  const review = inspectAnswerDialog("claude", REVIEW);
  const three = inspectAnswerDialog("claude", THREE);
  const checked = inspectAnswerDialog("claude", THREE_CHECKED);
  assert.equal(face.kind, "questions");
  assert.equal(face.family, "claude-ask-user-multiselect-v1");
  assert.equal(face.questions[0].header, "Face");
  assert.equal(face.questions[0].id, FACE_Q);
  assert.deepEqual(face.questions[0].options.map((option) => [option.key, option.label, option.checked]), [
    ["1", "Serif", false],
    ["2", "Mono", false],
    ["3", "Slab", false],
  ]);
  assert.deepEqual(face.actions, ["toggle", "next"]);
  assert.deepEqual(face.tabs, [
    { header: "Face", answered: false },
    { header: "Weight", answered: false },
  ]);
  assert.equal(weight.questions[0].header, "Weight");
  assert.equal(weight.questions[0].id, WEIGHT_Q);
  assert.deepEqual(weight.questions[0].options.map((option) => option.label), ["Light", "Regular", "Medium", "Bold"]);
  assert.deepEqual(weight.actions, ["toggle", "review", "prev"]);
  assert.deepEqual(weight.tabs.map((tab) => tab.header), ["Face", "Weight"]);
  assert.equal(review.phase, "review");
  assert.deepEqual(review.questions.map((question) => [question.header, question.id]), [
    ["Face", FACE_Q],
    ["Weight", WEIGHT_Q],
  ]);
  assert.deepEqual(review.answers, { [FACE_Q]: ["Serif"], [WEIGHT_Q]: ["Regular"] });
  assert.equal(review.submitKey, "1");
  assert.deepEqual(review.actions, ["submit"]);
  assert.equal(three.questions[0].header, "Face");
  assert.deepEqual(three.actions, ["toggle", "review"]);
  assert.deepEqual(three.tabs, [{ header: "Face", answered: false }]);
  assert.deepEqual(checked.answers[FACE_Q], ["Slab"]);
  assert.equal(checked.tabs[0].answered, true);
  const threeReview = inspectAnswerDialog("claude", THREE_REVIEW);
  assert.equal(threeReview.phase, "review");
  assert.deepEqual(threeReview.answers, { [FACE_Q]: ["Slab"] });
  assert.equal(threeReview.questions[0].header, "Face");
  assert.equal(threeReview.submitKey, "1");
  assert.deepEqual(planQuestionWrite(face, { op: "next" }), { key: "right" });
  assert.deepEqual(planQuestionWrite(face, { op: "toggle", questionId: FACE_Q, optionKey: "3" }), { key: "3" });
  assert.equal(planQuestionWrite(face, { op: "prev" }), null);
  assert.equal(planQuestionWrite(face, { op: "review" }), null);
  assert.deepEqual(planQuestionWrite(weight, { op: "prev" }), { key: "left" });
  assert.deepEqual(planQuestionWrite(weight, { op: "review" }), { key: "right" });
  assert.equal(planQuestionWrite(weight, { op: "next" }), null);
  assert.deepEqual(planQuestionWrite(three, { op: "review" }), { key: "right" });
  assert.equal(planQuestionWrite(three, { op: "next" }), null);
  assert.deepEqual(planQuestionWrite(review, { op: "submit" }), { key: "1" });
  assert.equal(QUESTION_CONTROLS_ENABLED, false);
  assert.equal(questionControls({ ...face, expected: { token: "t" } }), null);
  assert.deepEqual(questionControls({ ...face, expected: { token: "t" } }, true).controls.map((control) => control.op), [
    "toggle", "toggle", "toggle", "next",
  ]);
  assert.deepEqual(questionControls({ ...weight, expected: { token: "t" } }, true).controls.map((control) => control.op), [
    "toggle", "toggle", "toggle", "toggle", "review", "prev",
  ]);
  assert.deepEqual(questionControls({ ...three, expected: { token: "t" } }, true).controls.map((control) => control.op), [
    "toggle", "toggle", "toggle", "review",
  ]);
});

test("unanswered reviews, a third tab, and a fifth option stay terminal", () => {
  assert.equal(inspectAnswerDialog("claude", PARTIAL).kind, "terminal");
  assert.equal(inspectAnswerDialog("claude", UNANSWERED).kind, "terminal");
  const third = FACE.replace("←  ☐ Face  ☐ Weight  ✔ Submit  →", "←  ☐ Face  ☐ Weight  ☐ Width  ✔ Submit  →");
  assert.equal(inspectAnswerDialog("claude", third).kind, "terminal");
  const fifth = THREE
    .replace("  3. [ ] Slab", "  3. [ ] Slab\n         A slab face.\n  4. [ ] Display\n         A display face.\n  5. [ ] Script\n         A script face.")
    .replace("         A slab face.\n  4. [ ] Type something", "  6. [ ] Type something")
    .replace("  5. Chat about this", "  7. Chat about this");
  assert.equal(inspectAnswerDialog("claude", fifth).kind, "terminal");
  assert.equal(inspectAnswerDialog("claude", FACE.replace("     Next", "     Later")).kind, "terminal");
});

async function pane(t, card = FACE) {
  const dir = await mkdtemp(path.join(tmpdir(), "moshpit-s10-tabs-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const screen = path.join(dir, "screen");
  const writes = path.join(dir, "writes.jsonl");
  const reactions = path.join(dir, "reactions.json");
  const bin = path.join(dir, "herdr-fixture");
  await writeFile(screen, card);
  await writeFile(writes, "");
  await writeFile(reactions, "{}");
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
  return {
    herdr: createHerdr({ bin }),
    react: (map) => writeFile(reactions, JSON.stringify(map)),
    sent: async () => (await readFile(writes, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)),
    file: (name, text) => writeFile(path.join(dir, name), text).then(() => path.join(dir, name)),
  };
}

async function tokenOf(env) {
  return (await env.herdr.snapshot()).agents[0].blockedDialog.expected.token;
}

test("next and prev send right and left, and a refused prev spends nothing", async (t) => {
  const env = await pane(t);
  const weight = await env.file("weight.ansi", WEIGHT);
  const face = await env.file("face.ansi", FACE);
  await env.react({ "keys:right": weight });
  const token = await tokenOf(env);
  await assert.rejects(env.herdr.answerQuestion("pane", token, { op: "prev" }), /no longer on screen/);
  assert.deepEqual(await env.sent(), []);
  const moved = await env.herdr.answerQuestion("pane", token, { op: "next" });
  assert.equal(moved.outcome, "delivered");
  assert.deepEqual(await env.sent(), [["pane", "send-keys", "pane", "right"]]);
  await env.react({ "keys:left": face });
  const back = await tokenOf(env);
  const returned = await env.herdr.answerQuestion("pane", back, { op: "prev" });
  assert.equal(returned.outcome, "delivered");
  assert.deepEqual(await env.sent(), [
    ["pane", "send-keys", "pane", "right"],
    ["pane", "send-keys", "pane", "left"],
  ]);
});

test("a next that does not change the tab stays unknown and cannot be replayed", async (t) => {
  const env = await pane(t);
  const token = await tokenOf(env);
  const stuck = await env.herdr.answerQuestion("pane", token, { op: "next" });
  assert.equal(stuck.outcome, "unknown");
  assert.deepEqual(await env.sent(), [["pane", "send-keys", "pane", "right"]]);
  await assert.rejects(env.herdr.answerQuestion("pane", token, { op: "next" }), /no longer on screen/);
});

test("a three-option toggle, review, and submit send the printed digit, right, and the submit digit", async (t) => {
  const env = await pane(t, THREE);
  const checked = await env.file("checked.ansi", THREE_CHECKED);
  const weightChecked = WEIGHT.replace("[ ] Regular", "[✔] Regular");
  const gone = await env.file("gone.ansi", "working\n");
  await env.react({ "text:3": checked });
  const token = await tokenOf(env);
  const toggled = await env.herdr.answerQuestion("pane", token, { op: "toggle", questionId: FACE_Q, optionKey: "3" });
  assert.equal(toggled.outcome, "delivered");
  const weight = await pane(t, weightChecked);
  const reviewFile = await weight.file("review.ansi", REVIEW);
  await weight.react({ "keys:right": reviewFile });
  const reviewedResult = await weight.herdr.answerQuestion("pane", await tokenOf(weight), { op: "review" });
  assert.equal(reviewedResult.outcome, "delivered");
  const submitEnv = await pane(t, REVIEW);
  await submitEnv.react({ "text:1": gone });
  const submitted = await submitEnv.herdr.answerQuestion("pane", await tokenOf(submitEnv), { op: "submit" });
  assert.equal(submitted.outcome, "delivered");
  assert.deepEqual(await env.sent(), [["pane", "send-text", "pane", "3"]]);
  assert.deepEqual(await weight.sent(), [["pane", "send-keys", "pane", "right"]]);
  assert.deepEqual(await submitEnv.sent(), [["pane", "send-text", "pane", "1"]]);
});

test("next over HTTP sends right and an extra field is refused", async (t) => {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const dir = await mkdtemp(path.join(tmpdir(), "moshpit-s10-tabs-http-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const screen = path.join(dir, "screen");
  const writes = path.join(dir, "writes.jsonl");
  const weight = path.join(dir, "weight.ansi");
  const bin = path.join(dir, "herdr-fixture");
  await writeFile(screen, FACE);
  await writeFile(weight, WEIGHT);
  await writeFile(writes, "");
  await writeFile(bin, `#!${process.execPath}
import {appendFileSync, readFileSync, writeFileSync} from 'node:fs';
const a=process.argv.slice(2);
if(a[0]==='api') console.log(JSON.stringify({result:{snapshot:{agents:[{pane_id:'pane',agent:'claude',agent_status:'blocked',agent_session:{kind:'id',value:'session'},cwd:'/tmp',revision:3}]}}}));
else if(a[1]==='list') console.log(JSON.stringify({result:{panes:[{pane_id:'pane',terminal_id:'pane'}]}}));
else if(a[1]==='read') process.stdout.write(readFileSync(${JSON.stringify(screen)},'utf8'));
else if(a[1]==='send-text'||a[1]==='send-keys') {
  appendFileSync(${JSON.stringify(writes)}, JSON.stringify(a)+'\\n');
  if(a[3]==='right') writeFileSync(${JSON.stringify(screen)}, readFileSync(${JSON.stringify(weight)},'utf8'));
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
  const refused = await post({ kind: "answer", target: "pane", token, question: { op: "next", extra: true } });
  assert.equal(refused.status, 400);
  assert.equal((await readFile(writes, "utf8")).trim(), "");
  const sent = await post({ kind: "answer", target: "pane", token, question: { op: "next" } });
  assert.equal(sent.status, 200);
  assert.deepEqual(await sent.json(), { ok: true, outcome: "delivered" });
  assert.deepEqual((await readFile(writes, "utf8")).trim().split("\n").map((line) => JSON.parse(line)), [
    ["pane", "send-keys", "pane", "right"],
  ]);
});
