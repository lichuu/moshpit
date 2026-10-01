import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { herdrInput, latestModel } from "./herdr.mjs";

const dir = mkdtempSync(path.join(tmpdir(), "moshpit-model-"));
const file = path.join(dir, "session.jsonl");
writeFileSync(
  file,
  [
    JSON.stringify({ type: "session", id: "x", model: null }),
    JSON.stringify({ type: "message", message: { role: "assistant", model: "a/b" } }),
    JSON.stringify({ type: "message", message: { role: "assistant", model: "c/d:off" } }),
  ].join("\n") + "\n",
);

assert.equal(await latestModel(file), "c/d:off");
assert.equal(await latestModel(path.join(dir, "missing.jsonl")), null);
assert.equal(await latestModel("/nonexistent/whatever.txt"), null);

const big = path.join(dir, "big.jsonl");
const pad = JSON.stringify({ type: "message", message: { role: "assistant", model: "old/model" } }) + "\n";
writeFileSync(big, pad.repeat(30000) + JSON.stringify({ type: "message", message: { role: "assistant", model: "new/model" } }) + "\n");
assert.equal(await latestModel(big), "new/model");

// The (size, mtime) cache: repeat calls are hits, an append re-reads.
const cache = new Map();
assert.equal(await latestModel(file, cache), "c/d:off");
assert.equal(cache.size, 1);
assert.equal(await latestModel(file, cache), "c/d:off");
const append = (await import("node:fs/promises")).appendFile;
await append(file, JSON.stringify({ type: "message", message: { role: "assistant", model: "final/model" } }) + "\n");
await new Promise((resolve) => setTimeout(resolve, 15));
assert.equal(await latestModel(file, cache), "final/model");


rmSync(dir, { recursive: true, force: true });
console.log("herdr model tests ok");

// Every key name the app can put on the wire has to land as a named key.
// A name that falls through to text is typed into the pane verbatim, which
// is how "alt+enter" once reached a prompt as six literal characters.
// Sources: keyBar() and parsePaneKey() in src (terminal.tsx, keys.ts).
for (const name of [
  "esc", "tab", "shift+tab", "alt+enter", "enter",
  "ctrl+a", "ctrl+b", "ctrl+c", "ctrl+d", "ctrl+l",
  "up", "down", "left", "right",
]) {
  assert.deepEqual(herdrInput(name), { kind: "keys", value: name }, `${name} must be a named key`);
}
// Raw bytes the pane keyboard sends still fold onto their names.
assert.deepEqual(herdrInput("\r"), { kind: "keys", value: "enter" });
assert.deepEqual(herdrInput("\t"), { kind: "keys", value: "tab" });
assert.deepEqual(herdrInput("\x7f"), { kind: "keys", value: "backspace" });
assert.deepEqual(herdrInput("\x1b"), { kind: "keys", value: "esc" });
// A plain string is a key name or one character. Anything longer is refused
// rather than guessed at, so an unknown name is never typed as a word.
for (const raw of ["home", "end", "pageup", "delete", "f1", "ctrl+enter", "Enter", "ENTER", "alt+entering", "shift+tab now", "", "\x00"]) {
  assert.throws(() => herdrInput(raw), { code: "key_unsupported", status: 400 }, JSON.stringify(raw));
}
// Literal text is marked, and stays text even when it reads like a key name.
assert.deepEqual(herdrInput({ text: "enter" }), { kind: "text", value: "enter" });
assert.deepEqual(herdrInput({ text: "Tabs (Recommended)" }), { kind: "text", value: "Tabs (Recommended)" });
assert.deepEqual(herdrInput({ text: "10" }), { kind: "text", value: "10" });
assert.deepEqual(herdrInput("a"), { kind: "text", value: "a" });
assert.deepEqual(herdrInput("é"), { kind: "text", value: "é" });
for (const raw of [{}, { text: "" }, { text: 1 }, { text: "x", keys: "enter" }, { text: "x".repeat(4097) }, ["enter"], null, 7]) {
  assert.throws(() => herdrInput(raw), { code: "key_unsupported" }, JSON.stringify(raw));
}
console.log("herdr key name tests ok");
