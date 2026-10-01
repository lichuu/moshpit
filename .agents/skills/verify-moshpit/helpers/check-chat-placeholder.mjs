import assert from "node:assert/strict";
import { filterChatChrome, linesToConversation } from "../../../../src/lib/moshpit/chat.ts";

const messages = [
  { role: "user", text: "Fix the bug\n› Ask Codex to do anything" },
  { role: "agent", text: "Fixed the bug." },
  { role: "user", text: "  Ask Codex to do anything  " },
  { role: "agent", text: 'The placeholder says "Ask Codex to do anything".' },
  { role: "agent", text: "Ask Codex to do anything with this file." },
];
const before = structuredClone(messages);
assert.deepEqual(filterChatChrome(messages), [
  { role: "user", text: "Fix the bug" },
  messages[1], messages[3], messages[4],
]);
assert.deepEqual(messages, before, "Filtering Chat must not change raw Output data");
assert.deepEqual(filterChatChrome([{ role: "agent", text: "❯ Ask Codex to do anything…" }]), []);
console.log("ok   placeholder removed from merged turns and fallback text; quoted mentions and raw data preserved");
const chrome = "─".repeat(172) + "\n   \n" + "─".repeat(172) + "\n~/projects/moshpit (master)\n↑411k ↓2.5k 13.4%/262k (auto)          (llamacpp) qwen3.8-27b-mxfp4 • medium\n bg 1 done · Shift↓ · /bg-clear · ⬆ v2.5.0 /bg-update  ○ 🐴 ponytail: ⚡ FULL";
assert.deepEqual(filterChatChrome([{ role: "agent", text: chrome }]), []);
assert.deepEqual(filterChatChrome([{ role: "agent", text: "Here is the answer.\n" + chrome }]), [{ role: "agent", text: "Here is the answer." }]);
for (const text of ["```text\n" + chrome + "\n```", "~~~text\nAsk Codex to do anything\n~~~", "~/projects/moshpit (master)", "─".repeat(172)]) {
  assert.deepEqual(filterChatChrome([{ role: "agent", text }]), [{ role: "agent", text }]);
}
assert.deepEqual(filterChatChrome([{ role: "user", text: chrome }]), [{ role: "user", text: chrome }]);
assert.deepEqual(filterChatChrome(linesToConversation(chrome.split("\n").map(text => ({ text, tone: "plain" })))), []);
const multilineCode = "```typescript\nconst first = 1;\n\nconst second = 2;\n```";
assert.equal(linesToConversation(multilineCode.split("\n").map(text => ({ text, tone: "plain" })))[0].text, multilineCode);
console.log("ok   Pi footer removed; user quotes, fences, standalone paths and diagrams preserved");
