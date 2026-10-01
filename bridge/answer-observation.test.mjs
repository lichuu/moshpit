import test from "node:test";
import assert from "node:assert/strict";
import { createAnswerObservations } from "./answer-observation.mjs";

// Fixtures copied from prompt-answer.test.mjs (captured Codex TUI dumps).

const CODEX_FOOTER_STEP =
  "tab to add notes | enter to submit answer | ←/→ to navigate questions | esc to interrupt";
const CODEX_FOOTER_FINAL =
  "tab to add notes | enter to submit all | ←/→ to navigate questions | esc to interrupt";

const CODEX_STEP1 = [
  "Question 1/2 (2 unanswered)",
  "How should the generated file be indented?",
  "› 1. Tabs (Recommended)  Indent code with tab characters.",
  "  2. Spaces              Indent code with space characters.",
  "  3. None of the above   Optionally, add details in notes (tab).",
  "",
  CODEX_FOOTER_STEP,
].join("\n");

const CODEX_STEP2 = [
  "Question 2/2 (1 unanswered)",
  "Which indentation width should we use?",
  "› 1. 4 spaces  Use four spaces per level.",
  "  2. 8 spaces  Use eight spaces per level.",
  "  3. None of the above   Optionally, add details in notes (tab).",
  "",
  CODEX_FOOTER_FINAL,
].join("\n");

const TARGET = "pane-1";
const SESSION = "sess-1";

function makeObs() {
  let n = 0;
  return createAnswerObservations({
    randomUUID: () => `tok-${String(++n).padStart(2, "0")}`,
    now: () => 1234,
  });
}

const ARG = { target: TARGET, sessionId: SESSION, harness: "codex", dump: CODEX_STEP1 };

test("two observes of the same dump keep the token", () => {
  const obs = makeObs();
  const a = obs.observe({ ...ARG });
  const b = obs.observe({ ...ARG });
  assert.equal(b.token, a.token);
  assert.equal(b.kind, "choose");
  assert.equal(b.consumed, false);
  assert.equal(obs.peek(TARGET).token, a.token);
});

test("step 1 then step 2 mints a new token", () => {
  const obs = makeObs();
  const a = obs.observe({ ...ARG });
  const b = obs.observe({ ...ARG, dump: CODEX_STEP2 });
  assert.notEqual(b.token, a.token);
  assert.equal(b.consumed, false);
});

test("consume then identical dump stays consumed", () => {
  const obs = makeObs();
  const a = obs.observe({ ...ARG });
  assert.notEqual(obs.consume(TARGET, a.token), null);
  const b = obs.observe({ ...ARG });
  assert.equal(b.token, a.token);
  assert.equal(b.consumed, true);
  assert.equal(obs.consume(TARGET, a.token), null);
});

test("consume then a different dump is a new unconsumed token", () => {
  const obs = makeObs();
  const a = obs.observe({ ...ARG });
  assert.notEqual(obs.consume(TARGET, a.token), null);
  const b = obs.observe({ ...ARG, dump: CODEX_STEP2 });
  assert.notEqual(b.token, a.token);
  assert.equal(b.consumed, false);
  assert.notEqual(obs.consume(TARGET, b.token), null);
});

test("consume with a wrong token returns null", () => {
  const obs = makeObs();
  const a = obs.observe({ ...ARG });
  assert.equal(obs.consume(TARGET, `not-${a.token}`), null);
  assert.equal(obs.peek(TARGET).consumed, false);
});

test("a bad option key does not consume the observation", () => {
  const obs = makeObs();
  const a = obs.observe({ ...ARG });
  assert.equal(obs.consume(TARGET, a.token, "9"), null);
  assert.equal(obs.peek(TARGET).consumed, false);
  assert.notEqual(obs.consume(TARGET, a.token, "1"), null);
});

test("reset invalidates the old token", () => {
  const obs = makeObs();
  const a = obs.observe({ ...ARG });
  obs.reset();
  assert.equal(obs.consume(TARGET, a.token), null);
  assert.equal(obs.peek(TARGET), null);
});

test("a later terminal dump does not revive a consumed choose token", () => {
  const obs = makeObs();
  const a = obs.observe({ ...ARG });
  assert.notEqual(obs.consume(TARGET, a.token), null);
  const t = obs.observe({ ...ARG, harness: "claude" }); // non-codex kind → terminal
  assert.equal(t.token, a.token);
  assert.equal(t.consumed, true);
  assert.equal(obs.consume(TARGET, a.token), null);
});

test("a terminal dump drops an unconsumed choose token", () => {
  const obs = makeObs();
  const a = obs.observe({ ...ARG });
  // The card left the screen for a dialog the parser cannot read. Publishing
  // the old one would hand the phone a spendable token for a pane that has
  // moved on, and the digit would land in whatever is there now.
  const t = obs.observe({ ...ARG, harness: "claude" });
  assert.equal(t, null);
  assert.equal(obs.peek(TARGET), null);
  assert.equal(obs.consume(TARGET, a.token, "1"), null);
});

test("forget drops the panes a snapshot no longer sees", () => {
  const obs = makeObs();
  const a = obs.observe({ ...ARG });
  const b = obs.observe({ ...ARG, target: "pane-2" });
  obs.forget(["pane-2"]);
  assert.equal(obs.peek(TARGET), null);
  assert.equal(obs.consume(TARGET, a.token, "1"), null);
  assert.equal(obs.peek("pane-2").token, b.token);
});

test("revision 0 and missing revision are equivalent", () => {
  const obs = makeObs();
  const a = obs.observe({ ...ARG, revision: 0 });
  const b = obs.observe({ ...ARG, revision: undefined });
  assert.equal(b.token, a.token);
  assert.equal(a.revision, null);
  assert.equal(b.revision, null);
});

test("revision 1 after revision 0 mints a new token", () => {
  const obs = makeObs();
  const a = obs.observe({ ...ARG, revision: 0 });
  const b = obs.observe({ ...ARG, revision: 1 });
  assert.notEqual(b.token, a.token);
  assert.equal(b.consumed, false);
});

test("missing target throws", () => {
  const obs = makeObs();
  assert.throws(() => obs.observe({ ...ARG, target: undefined }), TypeError);
});
