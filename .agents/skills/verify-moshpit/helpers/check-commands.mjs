import assert from "node:assert/strict";
import { detectToken, filterCommands, insertPrefix, insertSuggestion, parseScopedCommandsResponse, commandScope } from "../../../../src/lib/moshpit/commands.ts";
import { scanAgentCommands } from "../../../../bridge/commands.mjs";

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

const scope = { target: "w1:p1", sessionId: "sess-1", project: JSON.stringify([null, "/repo/app"]) };
const wire = (over = {}) => ({
  scope,
  revision: "a".repeat(64),
  coverage: "partial",
  truncated: false,
  prefixes: ["/skill:", "/"],
  commands: [
    { name: "ask", invocation: "/skill:ask", description: "Ask the user.", origin: "home-skills" },
    { name: "review", invocation: "/review", description: "", origin: "home-templates" },
  ],
  warnings: [],
  ...over,
});
const parsed = parseScopedCommandsResponse(wire(), scope);
assert.deepEqual(parsed.scope, scope);
assert.deepEqual(parsed.catalog.prefixes, ["/skill:", "/"]);
assert.deepEqual(parsed.catalog.commands.map((c) => [c.invocation, c.origin]), [
  ["/skill:ask", "home-skills"],
  ["/review", "home-templates"],
]);
assert.equal(parsed.catalog.coverage, "partial");
assert.equal(parsed.truncated, false);
const scopedThrows = (value) => {
  try {
    parseScopedCommandsResponse(value, scope);
    return false;
  } catch {
    return true;
  }
};
assert.equal(scopedThrows(wire({ scope: { ...scope, target: "w9:p9" } })), true, "a foreign target is refused");
assert.equal(scopedThrows(wire({ scope: { ...scope, sessionId: "other" } })), true, "a foreign session is refused");
assert.equal(scopedThrows(wire({ scope: { ...scope, project: JSON.stringify([null, "/repo/other"]) } })), true, "a foreign project is refused");
assert.equal(scopedThrows(wire({ revision: "" })), true, "a missing revision is refused");
assert.equal(scopedThrows(wire({ coverage: "maybe" })), true, "an unknown coverage is refused");
assert.equal(scopedThrows(wire({ prefixes: ["%"] })), true, "an unknown advertised prefix is refused");
assert.equal(
  scopedThrows(wire({ commands: [{ name: "a", invocation: "/" + "i".repeat(101), description: "", origin: "home-skills" }] })),
  true,
  "an overlong invocation is refused, not clipped",
);
assert.equal(
  scopedThrows(wire({ commands: [{ name: "a", invocation: "/a b", description: "", origin: "home-skills" }] })),
  true,
  "a whitespace invocation is refused",
);
assert.equal(scopedThrows(wire({ commands: [{ name: "a", invocation: "$a", description: "", origin: "home-skills" }] })), true, "an invocation outside the advertised prefixes is refused");
assert.equal(scopedThrows(wire({ commands: [{ name: "a", invocation: "/a", description: "" }] })), true, "a missing origin is refused");
// The scanner's unsupported variant (empty prefixes, empty commands) must
// parse as the unavailable state, not a failure.
const unsupported = await scanAgentCommands({ kind: "moshpit-unknown-kind", home: "/nonexistent-moshpit-home" });
assert.equal(unsupported.coverage, "unsupported");
assert.deepEqual(unsupported.prefixes, []);
assert.deepEqual(unsupported.commands, []);
const unsupportedWire = {
  scope,
  revision: unsupported.revision,
  coverage: unsupported.coverage,
  truncated: unsupported.truncated,
  prefixes: unsupported.prefixes,
  commands: unsupported.commands,
  warnings: unsupported.warnings,
};
const parsedUnsupported = parseScopedCommandsResponse(unsupportedWire, scope);
assert.deepEqual(parsedUnsupported.catalog, { prefixes: [], commands: [], coverage: "unsupported" });
assert.equal(scopedThrows(wire({ coverage: "unsupported", prefixes: [], commands: [{ name: "a", invocation: "/a", description: "", origin: "home-skills" }] })), true, "an unsupported catalog with commands is refused");
assert.equal(scopedThrows(wire({ coverage: "partial", prefixes: [] })), true, "a supported catalog without prefixes is refused");
assert.deepEqual(commandScope({ id: "w1:p1", sessionId: "sess-1", cwd: "/repo/app", projectRoot: "/repo" }), {
  target: "w1:p1",
  sessionId: "sess-1",
  project: JSON.stringify(["/repo", "/repo/app"]),
});
assert.equal(commandScope({ id: "w1:p1", cwd: "/repo/app" }), null);
assert.equal(commandScope({ id: "w1:p1", sessionId: "sess-1", cwd: "" }), null);

console.log("ok   prefix-bound token detection, prefix-tap caret, real /skill: invocations");
console.log("ok   scoped catalog validation: exact scope, bounded metadata, no clipping, unavailable scopes");
console.log("ok   scanner-to-parser round trip: the unsupported variant parses as unavailable");
