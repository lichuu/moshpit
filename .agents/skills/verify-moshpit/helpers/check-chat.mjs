import assert from "node:assert/strict";
import { linesToConversation } from "../../../../src/lib/moshpit/chat.ts";

const two = linesToConversation([
  { text: "> y", tone: "in" },
  { text: "", tone: "plain" },
  { text: "running prisma migrate deploy", tone: "ok" },
]);
assert.equal(two.length, 2);
assert.equal(two[0].role, "user");
assert.equal(two[0].text, "> y\n");
assert.equal(two[1].role, "agent");
assert.equal(two[1].text, "running prisma migrate deploy");
assert.equal(two[1].accent, "success");

const adjacent = linesToConversation([
  { text: "> y", tone: "in" },
  { text: "", tone: "plain" },
  { text: "> n", tone: "in" },
]);
// An empty line never closes a bubble; adjacent user prompts stay one bubble.
assert.equal(adjacent.length, 1);
assert.equal(adjacent[0].role, "user");
assert.equal(adjacent[0].text, "> y\n\n> n");

const merged = linesToConversation([
  { text: "line one", tone: "plain" },
  { text: "line two", tone: "plain" },
]);
assert.equal(merged.length, 1);
assert.equal(merged[0].role, "agent");
assert.equal(merged[0].text, "line one\nline two");

const mixed = linesToConversation([
  { text: "running prisma migrate deploy", tone: "ok" },
  { text: "prisma migrate deploy", tone: "plain" },
]);
assert.equal(mixed.length, 1);
assert.equal(mixed[0].role, "agent");
assert.equal(mixed[0].text, "running prisma migrate deploy\nprisma migrate deploy");

const question = linesToConversation(
  [{ text: "Need a decision before I continue — proceed? y/n", tone: "warn" }],
  true,
);
assert.equal(question[0].role, "agent");
assert.equal(question[0].accent, "question");

const dim = linesToConversation([{ text: "codex  ·  web / db", tone: "dim" }]);
assert.equal(dim[0].role, "system");

console.log("ok   linesToConversation merge, adjacent-prompt merge, accents");
