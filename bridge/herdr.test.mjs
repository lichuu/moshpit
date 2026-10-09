import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { ESCAPE_KEYS, herdrInput, latestModel } from "./herdr.mjs";

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
for (const raw of ["Home", "pgup", "f13", "ctrl+enter", "Enter", "ENTER", "alt+entering", "shift+tab now", "", "\x00"]) {
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

// The shared matrix (tests/fixtures/key-matrix.json) is also what the browser
// parser test checks: every delivered key must reach the bridge as the
// operation and bytes the matrix lists. The matrix writes the bytes out; it
// does not derive them from the bridge's table.
const matrix = JSON.parse(readFileSync(new URL("../tests/fixtures/key-matrix.json", import.meta.url), "utf8"));
for (const row of matrix.rows.filter((candidate) => candidate.bridge)) {
  const { kind, value } = herdrInput(row.parsed.value);
  assert.deepEqual({ kind, value }, row.bridge, row.name);
}
// A name that is neither a send-keys name nor in the escape table is refused.
for (const raw of matrix.unknown) assert.throws(() => herdrInput(raw), { code: "key_unsupported", status: 400 }, JSON.stringify(raw));
// The six keys send-keys rejects, with their bytes written here independently.
for (const [name, bytes] of [["delete", "\x1b[3~"], ["home", "\x1b[H"], ["end", "\x1b[F"], ["pageup", "\x1b[5~"], ["pagedown", "\x1b[6~"], ["insert", "\x1b[2~"]]) {
  assert.deepEqual(herdrInput(name), { kind: "text", value: bytes, key: name });
}
// 6 editing keys + 12 function keys + 4 arrows x 7 Ctrl/Alt/Shift mixes.
assert.equal(ESCAPE_KEYS.size, 6 + 12 + 28);
assert.equal(new Set(ESCAPE_KEYS.values()).size, ESCAPE_KEYS.size, "no two names share bytes");
// A key has one route: an escape name is never also a send-keys name.
for (const name of ESCAPE_KEYS.keys()) assert.equal(herdrInput(name).kind, "text", name);
// Literal text that merely spells an escape name stays text, with no key name.
assert.deepEqual(herdrInput({ text: "home" }), { kind: "text", value: "home" });
console.log("herdr escape key tests ok");
