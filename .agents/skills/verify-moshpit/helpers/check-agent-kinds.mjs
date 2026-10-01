import assert from "node:assert/strict";
import { agentKind } from "../../../../bridge/herdr.mjs";
import { findAgentIcon } from "../../../../src/lib/moshpit/icon-lookup.ts";
import { readdir } from "node:fs/promises";

for (const kind of ["codex", "pi", "opencode", "grok", "hermes", "gemini", "cursor", "copilot", "amp", "cline"]) {
  assert.equal(agentKind(kind), kind);
}
assert.equal(agentKind("Claude"), "Claude");
assert.equal(agentKind("claude-code"), "claude-code");
assert.equal(agentKind("grok-cli"), "grok-cli");
assert.equal(agentKind("hermes-agent"), "hermes-agent");
for (const name of ["new-agent", "toString", "__proto__"]) assert.equal(agentKind(name), name);
for (const name of [undefined, null, "", "  ", 4]) assert.equal(agentKind(name), "unknown");
const files = await readdir(new URL("../../../../node_modules/@lobehub/icons-static-svg/icons/", import.meta.url));
const catalog = new Map(files.filter(file => /^[a-z0-9]+\.svg$/.test(file)).map(file => [file.slice(0, -4), file]));
for (const name of ["Claude Code", "codex", "pi", "grok-cli", "hermes", "gemini-cli", "cursor-agent", "GitHub Copilot", "deepseek", "windsurf"]) {
  assert.ok(findAgentIcon(catalog, name), `${name} resolves from the installed catalog`);
}
assert.equal(findAgentIcon(catalog, "claude"), "claudecode.svg", "herdr's \"claude\" is Claude Code");
assert.equal(findAgentIcon(catalog, "Claude Code"), "claudecode.svg");
for (const name of ["new-agent", "toString", "__proto__", ""]) assert.equal(findAgentIcon(catalog, name), undefined);
console.log(`ok   herdr names preserved; dynamic lookup across ${catalog.size} local logos; neutral fallback`);
