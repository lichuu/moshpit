import test from "node:test";
import assert from "node:assert/strict";
import { inspectAnswerDialog } from "./prompt.mjs";

const CODEX_FOOTER_STEP =
  "tab to add notes | enter to submit answer | ←/→ to navigate questions | esc to interrupt";
const CODEX_FOOTER_FINAL =
  "tab to add notes | enter to submit all | ←/→ to navigate questions | esc to interrupt";

// Question 1/2 with a `›` pointer on the first option.
const CODEX_STEP1 = [
  "Question 1/2 (2 unanswered)",
  "How should the generated file be indented?",
  "› 1. Tabs (Recommended)  Indent code with tab characters.",
  "  2. Spaces              Indent code with space characters.",
  "  3. None of the above   Optionally, add details in notes (tab).",
  "",
  CODEX_FOOTER_STEP,
].join("\n");

// Final step 2/2; footer switches to "submit all".
const CODEX_STEP2 = [
  "Question 2/2 (1 unanswered)",
  "Which indentation width should we use?",
  "› 1. 4 spaces  Use four spaces per level.",
  "  2. 8 spaces  Use eight spaces per level.",
  "  3. None of the above   Optionally, add details in notes (tab).",
  "",
  CODEX_FOOTER_FINAL,
].join("\n");

// Heavy `❯` pointer (the Codex pointer is `›`).
const CODEX_HEAVY_POINTER = CODEX_STEP1.replace("› 1. Tabs (Recommended)", "❯ 1. Tabs (Recommended)");

// Notes-focused footer replaces the answer footer.
const CODEX_NOTES_FOOTER = CODEX_STEP1.replace(CODEX_FOOTER_STEP, "tab or esc to clear notes | enter to submit answer");

// A `› Add notes` row.
const CODEX_ADD_NOTES_ROW = CODEX_STEP1.replace(CODEX_FOOTER_STEP, "› Add notes\n" + CODEX_FOOTER_STEP);

// A checkbox row.
const CODEX_CHECKBOX_ROW = CODEX_STEP1.replace(CODEX_FOOTER_STEP, "▢ yes   ▢ no   ▢ ask\n" + CODEX_FOOTER_STEP);

// Missing the full header.
const CODEX_NO_HEADER = CODEX_STEP1
  .split("\n")
  .slice(1)
  .join("\n");

// Missing the footer.
const CODEX_NO_FOOTER = CODEX_STEP1
  .split("\n")
  .slice(0, -2)
  .join("\n");

// Duplicate keys: two option 1.
const CODEX_DUP_KEY = CODEX_STEP1.replace(
  "  2. Spaces              Indent code with space characters.",
  "  1. Spaces              Indent code with space characters.",
);

// Nonconsecutive keys: 1 then 3.
const CODEX_GAPPED_KEY = CODEX_STEP1.replace(
  "  2. Spaces              Indent code with space characters.",
  "  3. Spaces              Indent code with space characters.",
);

// Multi-digit key: option 12.
const CODEX_MULTI_DIGIT_KEY = CODEX_STEP1.replace(
  "  2. Spaces              Indent code with space characters.",
  "  12. Spaces              Indent code with space characters.",
);

// No light `›` pointer on any option row.
const CODEX_NO_POINTER = CODEX_STEP1.replace(
  "› 1. Tabs (Recommended)",
  " 1. Tabs (Recommended)",
);

// Light `›` pointer on both option 1 and option 2.
const CODEX_DOUBLE_POINTER = CODEX_STEP1.replace(
  "  2. Spaces              Indent code with space characters.",
  "› 2. Spaces              Indent code with space characters.",
);

// Unknown trailing text after the footer.
const CODEX_UNKNOWN_TRAIL = CODEX_STEP1 + "\nzzz qqq xyz";

// Oversized inputs.
const TOO_MANY_LINES = Array.from({ length: 130 }, (_, i) => `row ${i} of the dump`).join("\n");
const TOO_BIG_BYTES = CODEX_STEP1 + "\n" + "x".repeat(32 * 1024);
if (Buffer.byteLength(TOO_BIG_BYTES, "utf8") <= 32 * 1024) throw new Error("fixture must exceed 32 KiB");
if (TOO_MANY_LINES.split("\n").length <= 128) throw new Error("fixture must exceed 128 lines");

const KIND_CLAUDE = "claude";
const KIND_CHOOSE = "choose";
const KIND_TERMINAL = "terminal";
const FAMILY_CODEX = "codex-request-user-input-v1";

test("prompt-answer: codex step 1/2 → kind choose, family, exact question, step object, exact options, 64-hex signature", () => {
  const r = inspectAnswerDialog("codex", CODEX_STEP1);
  assert.equal(r.kind, KIND_CHOOSE);
  assert.equal(r.family, FAMILY_CODEX);
  assert.equal(r.question, "How should the generated file be indented?");
  assert.deepEqual(r.step, { index: 0, total: 2 });
  assert.deepEqual(r.options, [
    { key: "1", label: "Tabs (Recommended)", description: "Indent code with tab characters." },
    { key: "2", label: "Spaces", description: "Indent code with space characters." },
    { key: "3", label: "None of the above", description: "Optionally, add details in notes (tab)." },
  ]);
  assert.match(r.signature, /^[0-9a-f]{64}$/);
});

test("prompt-answer: codex step 2/2 → step {index:1,total:2}, submit-all footer, signature", () => {
  const r = inspectAnswerDialog("codex", CODEX_STEP2);
  assert.equal(r.kind, KIND_CHOOSE);
  assert.equal(r.family, FAMILY_CODEX);
  assert.equal(r.question, "Which indentation width should we use?");
  assert.deepEqual(r.step, { index: 1, total: 2 });
  assert.deepEqual(r.options, [
    { key: "1", label: "4 spaces", description: "Use four spaces per level." },
    { key: "2", label: "8 spaces", description: "Use eight spaces per level." },
    { key: "3", label: "None of the above", description: "Optionally, add details in notes (tab)." },
  ]);
  assert.match(r.signature, /^[0-9a-f]{64}$/);
});

const NEGATIVES = [
  ["non-codex kind with a valid codex card", KIND_CLAUDE, CODEX_STEP1],
  ["heavy ❯ pointer", "codex", CODEX_HEAVY_POINTER],
  ["notes-focused footer", "codex", CODEX_NOTES_FOOTER],
  ["› Add notes row", "codex", CODEX_ADD_NOTES_ROW],
  ["checkbox rows", "codex", CODEX_CHECKBOX_ROW],
  ["missing full header", "codex", CODEX_NO_HEADER],
  ["missing footer", "codex", CODEX_NO_FOOTER],
  ["duplicate keys", "codex", CODEX_DUP_KEY],
  ["nonconsecutive keys", "codex", CODEX_GAPPED_KEY],
  ["no light pointer", "codex", CODEX_NO_POINTER],
  ["light pointer on two options", "codex", CODEX_DOUBLE_POINTER],
  ["multi-digit key", "codex", CODEX_MULTI_DIGIT_KEY],
  ["unknown trailing text", "codex", CODEX_UNKNOWN_TRAIL],
  ["more than 128 lines", "codex", TOO_MANY_LINES],
  ["more than 32 KiB", "codex", TOO_BIG_BYTES],
];

for (const [name, kind, dump] of NEGATIVES) {
  test(`prompt-answer: negative ${name} → kind terminal`, () => {
    const r = inspectAnswerDialog(kind, dump);
    assert.equal(r.kind, KIND_TERMINAL);
  });
}
