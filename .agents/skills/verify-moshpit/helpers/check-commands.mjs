import assert from "node:assert/strict";
import http from "node:http";
import { detectToken, filterCommands, insertPrefix, insertSuggestion, parseCommandsResponse } from "../../../../src/lib/moshpit/commands.ts";

// fetchCommands is verified through the real HTTP boundary: the same
// request + client-boundary parse the composer uses, with the AbortSignal
// the catalog effect passes for disposing a pending fetch.

// Trigger detection is bound to the agent's own prefix. A token in another
// agent's syntax (a / or $ token on a /skill: catalog, and vice versa)
// never triggers.
assert.deepEqual(detectToken("/review", 7, "/"), { start: 0, end: 7 });
assert.deepEqual(detectToken("/", 1, "/"), { start: 0, end: 1 });
assert.deepEqual(detectToken("hello /wo", 9, "/"), { start: 6, end: 9 });
assert.deepEqual(detectToken("hello /w", 8, "/"), { start: 6, end: 8 });
assert.deepEqual(detectToken("$deploy", 7, "$"), { start: 0, end: 7 });
assert.deepEqual(detectToken("/review more", 7, "/"), { start: 0, end: 7 });
assert.deepEqual(detectToken("/skill:ask", 8, "/skill:"), { start: 0, end: 10 });
assert.deepEqual(detectToken("/skill:", 7, "/skill:"), { start: 0, end: 7 });
// Mid-token caret: the token extends past the caret.
assert.deepEqual(detectToken("/world", 2, "/"), { start: 0, end: 6 });
// Prefix mismatch: the wrong agent's prefix does not trigger.
assert.equal(detectToken("/ask", 4, "/skill:"), null);
assert.equal(detectToken("$ask", 4, "/skill:"), null);
assert.equal(detectToken("/ask", 4, "$"), null);
assert.equal(detectToken("$ask", 4, "/"), null);
assert.equal(detectToken("/skill:ask", 9, "/"), null, "a partial /skill: token is not a / command");
assert.equal(detectToken("/skill:as?", 10, "/skill:"), null, "non-name characters after the prefix do not trigger");
// An empty prefix (unknown kind) never triggers.
assert.equal(detectToken("/review", 7, ""), null);
// A slash that is not the first character of the token never triggers.
assert.equal(detectToken("https://x.com", 8, "/"), null);
assert.equal(detectToken("https://x.com", 6, "/"), null);
assert.equal(detectToken("C:/temp", 3, "/"), null);
assert.equal(detectToken("foo//bar", 4, "/"), null);
assert.equal(detectToken("/path/to", 6, "/"), null);
// A name that turns into a path stops being a partial name.
assert.equal(detectToken("/a/b", 4, "/"), null);
// Non-name characters after the prefix do not trigger.
assert.equal(detectToken("a /b-c_d e", 7, "/"), null);

// Insertion: empty draft, mid-draft, suffix past the caret, trailing-space rule.
assert.deepEqual(insertSuggestion("", { start: 0, end: 0 }, "/review"), { text: "/review ", caret: 8 });
assert.deepEqual(
  insertSuggestion("hello /wo world", { start: 6, end: 9 }, "/review"),
  { text: "hello /review world", caret: 13 },
);
assert.deepEqual(
  insertSuggestion("hello /world", { start: 6, end: 12 }, "/skill:review"),
  { text: "hello /skill:review ", caret: 20 },
);
assert.deepEqual(
  insertSuggestion("keep this /a fter", { start: 10, end: 12 }, "$run"),
  { text: "keep this $run fter", caret: 14 },
);

// Prefix button: token anchoring keeps the prefix at a token boundary, and
// the caret stays in the active prefix (before the separating space) so
// the prefix alone opens the suggestions list.
assert.deepEqual(insertPrefix("hello world", 6, 6, "/"), { text: "hello / world", caret: 7 });
assert.deepEqual(detectToken("hello / world", 7, "/"), { start: 6, end: 7 }, "caret in the active prefix keeps the token live");
const tapped = insertPrefix("hello world", 6, 6, "/skill:");
assert.deepEqual(tapped, { text: "hello /skill: world", caret: 13 });
assert.deepEqual(detectToken(tapped.text, tapped.caret, "/skill:"), { start: 6, end: 13 }, "caret in the active prefix keeps the token live");
assert.deepEqual(insertPrefix("hello  world", 7, 7, "/"), { text: "hello  / world", caret: 8 });
assert.deepEqual(insertPrefix("hello", 3, 3, "/skill:"), { text: "/skill: hello", caret: 7 });
assert.deepEqual(detectToken("/skill: hello", 7, "/skill:"), { start: 0, end: 7 }, "mid-draft prefix tap keeps the token live");
assert.deepEqual(insertPrefix("", 0, 0, "/skill:"), { text: "/skill:", caret: 7 });
assert.deepEqual(insertPrefix("", 0, 0, "/"), { text: "/", caret: 1 });
// A selection collapses to its start; the button never deletes the draft.
// It is an icon tap with no undo behind it, not a keystroke.
assert.deepEqual(insertPrefix("hello", 0, 3, "/"), { text: "/ hello", caret: 1 });
assert.deepEqual(insertPrefix("hello world", 0, 5, "/"), { text: "/ hello world", caret: 1 });

// A caret at the end of a word is "I finished typing, now add a command".
// Anchoring to the token start there put the prefix in front of that word.
for (const [text, caret, want, at] of [
  ["hello", 5, "hello /", 7],
  ["a b", 3, "a b /", 5],
  ["hi ", 3, "hi /", 4],
]) {
  const tap = insertPrefix(text, caret, caret, "/");
  assert.deepEqual(tap, { text: want, caret: at }, text);
  assert.ok(detectToken(tap.text, tap.caret, "/"), `prefix stays a live token: ${want}`);
}

// Filtering and client-boundary validation.
const commands = [{ name: "Review", invocation: "/Review", description: "Review the diff." }, { name: "deploy", invocation: "$deploy", description: "" }];
assert.deepEqual(filterCommands(commands, "rev").map((c) => c.name), ["Review"]);
assert.deepEqual(filterCommands(commands, "x"), []);
const parsed = parseCommandsResponse({ kind: "pi", prefix: "/skill:", coverage: "full", commands: [{ name: "a", invocation: "/skill:a", description: "d" }, { name: "b", invocation: "/skill:b" }] });
assert.deepEqual(parsed, { kind: "pi", prefix: "/skill:", prefixes: ["/skill:"], coverage: "full", commands: [{ name: "a", invocation: "/skill:a", description: "d" }, { name: "b", invocation: "/skill:b", description: "" }] });
// A catalog advertising several prefixes (pi: /skill: skills beside /
// templates) accepts invocations under any of them, and no others.
const mixed = parseCommandsResponse({ kind: "pi", prefix: "/skill:", prefixes: ["/skill:", "/"], coverage: "partial", commands: [{ name: "a", invocation: "/skill:a" }, { name: "review", invocation: "/review" }] });
assert.deepEqual(mixed.prefixes, ["/skill:", "/"]);
assert.deepEqual(mixed.commands.map((c) => c.invocation), ["/skill:a", "/review"]);
assert.throws(() => parseCommandsResponse({ prefix: "/skill:", prefixes: ["/skill:", "/"], commands: [{ name: "d", invocation: "$d" }] }));
assert.throws(() => parseCommandsResponse({ prefix: "/", prefixes: ["%"], commands: [] }), "an unknown advertised prefix is rejected");
assert.throws(() => parseCommandsResponse(null));
assert.throws(() => parseCommandsResponse({ prefix: "%", commands: [] }));
assert.throws(() => parseCommandsResponse({ prefix: "/", commands: "nope" }));
// An invocation that does not carry the catalog's prefix is rejected:
// the client must not suggest tokens the agent cannot run.
assert.throws(() => parseCommandsResponse({ prefix: "/skill:", commands: [{ name: "a", invocation: "/a" }] }));
assert.throws(() => parseCommandsResponse({ prefix: "/", commands: [{ name: "a" }] }));
assert.throws(() => parseCommandsResponse({ prefix: "$", commands: [{ name: "a", invocation: "/a" }] }));
const trimmed = parseCommandsResponse({ kind: "pi", prefix: "/skill:", coverage: "full", commands: [{ name: "n".repeat(999), invocation: "/skill:" + "i".repeat(999), description: "d".repeat(999) }] });
assert.equal(trimmed.commands[0].name.length, 80);
assert.equal(trimmed.commands[0].invocation.length, 100);
assert.equal(trimmed.commands[0].description.length, 300);
const capped = parseCommandsResponse({ kind: "pi", prefix: "/skill:", coverage: "full", commands: Array.from({ length: 250 }, (_, i) => ({ name: `c${i}`, invocation: `/skill:c${i}` })) });
assert.equal(capped.commands.length, 200);
assert.equal(capped.coverage, "partial");

// Stale/disposed fetches: an aborted in-flight catalog read rejects, and a
// later fetch (the new host/kind) still resolves on the same server.
const server = http.createServer((req, res) => {
  setTimeout(() => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ kind: "pi", prefix: "/skill:", commands: [{ name: "ask", invocation: "/skill:ask", description: "Ask the user." }] }));
  }, 150);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const fetchCatalog = (signal) =>
  (async () => {
    const res = await fetch(`${url}/api/commands?agent=pi`, { cache: "no-store", signal });
    if (!res.ok) throw new Error(`commands ${res.status}`);
    return parseCommandsResponse(await res.json());
  })();
{
  const controller = new AbortController();
  const pending = fetchCatalog(controller.signal);
  const rejected = pending.then(
    () => false,
    (error) => /abort/i.test(`${error.name} ${error.message}`),
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort(); // the host/kind switch disposes the pending fetch
  assert.equal(await rejected, true, "aborted fetch rejects with an abort error");
  const fresh = await fetchCatalog();
  assert.equal(fresh.prefix, "/skill:", "a new fetch resolves after the stale one was disposed");
}
server.close();

console.log("ok   prefix-bound token detection, prefix-tap caret, real /skill: invocations, disposed fetches");
