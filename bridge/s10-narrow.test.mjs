import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectAnswerDialog, planQuestionWrite } from "./prompt.mjs";

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../tests/fixtures/s10");
const readFixture = (name) => readFile(path.join(fixtureDir, name), "utf8");
const N40 = await readFixture("claude-2.1.296-narrow-40.ansi");
const N45 = await readFixture("claude-2.1.296-narrow-45.ansi");
const N46 = await readFixture("claude-2.1.296-narrow-46.ansi");
const N50 = await readFixture("claude-2.1.296-narrow-50.ansi");
const UP40 = await readFixture("claude-2.1.296-narrow-up-40.ansi");
const UP46 = await readFixture("claude-2.1.296-narrow-up-46.ansi");
const ED40 = await readFixture("claude-2.1.296-narrow-editor-40.ansi");
const ED46 = await readFixture("claude-2.1.296-narrow-editor-46.ansi");
const ED50 = await readFixture("claude-2.1.296-narrow-editor-50.ansi");
const THREE = await readFixture("claude-2.1.296-three.ansi");
const FACE_Q = "Which faces should the log use?";

test("a wrapped Tab/Arrow footer at 40, 45, 46, and 50 columns is the same Face card", () => {
  for (const dump of [N40, N45, N46, N50]) {
    const dialog = inspectAnswerDialog("claude", dump);
    assert.equal(dialog.kind, "questions");
    assert.equal(dialog.questions[0].header, "Face");
    assert.equal(dialog.questions[0].id, FACE_Q);
    assert.deepEqual(dialog.questions[0].options.map((option) => option.label), ["Serif", "Mono", "Slab"]);
    assert.deepEqual(dialog.actions, ["toggle", "next"]);
    assert.deepEqual(planQuestionWrite(dialog, { op: "next" }), { key: "right" });
  }
  for (const dump of [UP40, UP46]) {
    const dialog = inspectAnswerDialog("claude", dump);
    assert.equal(dialog.kind, "questions");
    assert.deepEqual(dialog.actions, ["toggle", "review"]);
    assert.deepEqual(planQuestionWrite(dialog, { op: "review" }), { key: "right" });
  }
  for (const dump of [ED40, ED46, ED50]) {
    const dialog = inspectAnswerDialog("claude", dump);
    assert.equal(dialog.focus.kind, "other");
    assert.deepEqual(dialog.actions, ["text"]);
    assert.deepEqual(planQuestionWrite(dialog, { op: "text", questionId: FACE_Q, text: "alder" }), { text: "alder" });
  }
  const broken = N40.replace("navigate · Esc to cancel", "navigate · Esc to");
  assert.equal(inspectAnswerDialog("claude", broken).kind, "terminal");
  const unmeasured = N40.replace(
    "Enter to select · Tab/Arrow keys to\nnavigate · Esc to cancel",
    "Enter to select · Tab/Arrow keys to navigate ·\nctrl+g to edit in Vim · Esc to cancel",
  );
  assert.equal(inspectAnswerDialog("claude", unmeasured).kind, "terminal");
  assert.equal(inspectAnswerDialog("claude", THREE).kind, "questions");
});
