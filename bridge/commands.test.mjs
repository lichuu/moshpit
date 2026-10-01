import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { listAgentCommands } from "./commands.mjs";

function skillHome(name, skills) {
  return Promise.all(
    Object.entries(skills).map(([dir, list]) =>
      Promise.all(
        list.map(([skill, body]) => {
          const directory = path.join(name, dir, skill);
          return mkdir(directory, { recursive: true })
            .then(() => writeFile(path.join(directory, "SKILL.md"), body));
        }),
      ),
    ),
  );
}

{
  const home = await mkdtemp(path.join(tmpdir(), "moshpit-commands-"));
  await skillHome(home, {
    ".claude/skills": [
      ["review", "---\nname: review\ndescription: Review the diff.\n---\nbody\n"],
      ["loose", "no frontmatter at all\n"],
      ["quoted", "---\nname: quoted\ndescription: \"Quoted description.\"\n---\n"],
      ["empty", ""],
    ],
    ".pi/agent/skills": [
      ["ask", "---\nname: ask\ndescription: Ask the user.\n---\n"],
      // Pi resolves the command name from the frontmatter (it may differ
      // from the directory name).
      ["ask-dir", "---\nname: renamed\ndescription: Frontmatter name wins.\n---\n"],
      // Pi does not load a SKILL.md without a description, so it registers
      // no /skill: command and must not be listed as an enabled one.
      ["undescribed", "---\nname: undescribed\n---\n"],
    ],
    ".codex/skills": [["deploy", "---\nname: deploy\ndescription: Deploy the service.\n---\n"]],
  });
  // A stray file at the top level is not a skill.
  await writeFile(path.join(home, ".claude/skills", "stray.txt"), "x");
  const claude = await listAgentCommands("claude", home);
  assert.equal(claude.prefix, "/");
  assert.deepEqual(
    claude.commands.map((c) => [c.name, c.invocation, c.description]),
    [
      ["empty", "/empty", ""],
      ["loose", "/loose", ""],
      ["quoted", "/quoted", "Quoted description."],
      ["review", "/review", "Review the diff."],
    ],
  );
  const pi = await listAgentCommands("pi", home);
  assert.equal(pi.prefix, "/skill:");
  assert.deepEqual(pi.commands, [
    { name: "ask", invocation: "/skill:ask", description: "Ask the user." },
    { name: "renamed", invocation: "/skill:renamed", description: "Frontmatter name wins." },
  ]);
  const codex = await listAgentCommands("codex", home);
  assert.equal(codex.prefix, "$");
  assert.deepEqual(codex.commands, [{ name: "deploy", invocation: "$deploy", description: "Deploy the service." }]);
  assert.equal(claude.coverage, "full");
  // Extension commands exist only inside the running pi, so pi is partial.
  assert.equal(pi.coverage, "partial");
  assert.deepEqual(pi.prefixes, ["/skill:", "/"]);
  assert.equal(codex.coverage, "full");
  // opencode 2.0 promotes the shared ~/.claude skill tree to slash commands,
  // so this home yields the two entries whose frontmatter carries both a name
  // and a description. The config directory is passed explicitly so a real
  // XDG_CONFIG_HOME on the host cannot leak into the fixture.
  const shared = await listAgentCommands("opencode", home, path.join(home, "absent-config"));
  assert.equal(shared.prefix, "/");
  assert.equal(shared.coverage, "partial");
  assert.deepEqual(shared.commands.map((c) => c.name), ["quoted", "review"]);
  assert.deepEqual(await listAgentCommands("toString", home), { kind: "toString", prefix: "", prefixes: [], commands: [], coverage: "unsupported" });
  assert.deepEqual(await listAgentCommands(4, home), { kind: "", prefix: "", prefixes: [], commands: [], coverage: "unsupported" });
  const missing = await listAgentCommands("claude", path.join(home, "absent"));
  assert.deepEqual(missing, { kind: "claude", prefix: "/", prefixes: ["/"], commands: [], coverage: "full" });
  // A frontmatter name never shadows the directory name for claude; the description is capped.
  await skillHome(home, { ".claude/skills": [["capped", "---\nname: other\ndescription: " + "d".repeat(999) + "\n---\n"]] });
  const capped = await listAgentCommands("claude", home);
  const entry = capped.commands.find((c) => c.name === "capped");
  assert.equal(entry.description.length, 300);
  // A symlinked skill directory is a real skill; a broken link is not.
  await mkdir(path.join(home, ".claude", "real"), { recursive: true });
  await writeFile(path.join(home, ".claude", "real", "SKILL.md"), "---\nname: linked\ndescription: Linked skill.\n---\n");
  await symlink(path.join(home, ".claude", "real"), path.join(home, ".claude", "skills", "linked"));
  await symlink(path.join(home, ".claude", "absent-target"), path.join(home, ".claude", "skills", "broken"));
  const withLinks = await listAgentCommands("claude", home);
  assert.ok(withLinks.commands.some((c) => c.name === "linked" && c.description === "Linked skill."), "symlinked skill resolves");
  assert.ok(!withLinks.commands.some((c) => c.name === "broken"), "broken symlink is skipped");
  await rm(home, { recursive: true, force: true });
}
  const home = await mkdtemp(path.join(tmpdir(), "moshpit-commands-cap-"));
  await Promise.all(
    Array.from({ length: 205 }, (_, i) => {
      const directory = path.join(home, ".claude/skills", `skill-${String(i).padStart(3, "0")}`);
      return mkdir(directory, { recursive: true }).then(() =>
        writeFile(path.join(directory, "SKILL.md"), `---\nname: s${i}\ndescription: d${i}\n---\n`));
    }),
  );
  const capped = await listAgentCommands("claude", home);
  assert.equal(capped.commands.length, 200);
  assert.equal(capped.coverage, "partial");
  assert.deepEqual(capped.commands[0].name, "skill-000");
  await rm(home, { recursive: true, force: true });

{
  // opencode: markdown commands under the XDG config directory, both
  // spellings, nested paths, plus the skill trees 2.0 promotes to commands.
  const home = await mkdtemp(path.join(tmpdir(), "moshpit-opencode-"));
  const config = path.join(home, "xdg");
  const write = async (file, body) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body);
  };
  const oc = path.join(config, "opencode");
  await write(path.join(oc, "command", "test.md"), "---\ndescription: Run tests.\n---\nrun them\n");
  await write(path.join(oc, "commands", "git", "commit.md"), "---\ndescription: Commit.\n---\n");
  await write(path.join(oc, "commands", "aliased.md"), "---\nname: renamed\ndescription: Frontmatter name wins.\n---\n");
  await write(path.join(oc, "commands", "notes.txt"), "not a command\n");
  await write(path.join(oc, "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: Ship it.\n---\n");
  await write(path.join(oc, "skill", "nested", "deep", "SKILL.md"), "---\nname: deep\ndescription: Nested skill.\n---\n");
  await write(path.join(oc, "skills", "nameless", "SKILL.md"), "---\nname: nameless\n---\n");
  await write(path.join(home, ".agents", "skills", "shared", "SKILL.md"), "---\nname: shared\ndescription: From ~/.agents.\n---\n");
  // A command and a skill claiming one name: the command scan runs first.
  await write(path.join(oc, "command", "deploy.md"), "---\ndescription: The command, not the skill.\n---\n");

  const list = await listAgentCommands("opencode", home, config);
  assert.equal(list.prefix, "/");
  assert.equal(list.coverage, "partial");
  assert.deepEqual(
    list.commands.map((c) => [c.name, c.invocation, c.description]),
    [
      ["deep", "/deep", "Nested skill."],
      ["deploy", "/deploy", "The command, not the skill."],
      ["git/commit", "/git/commit", "Commit."],
      ["renamed", "/renamed", "Frontmatter name wins."],
      ["shared", "/shared", "From ~/.agents."],
      ["test", "/test", "Run tests."],
    ],
  );
  // A skill whose frontmatter has no description is not a command in 2.0.
  assert.ok(!list.commands.some((c) => c.name === "nameless"), "undescribed skill is skipped");
  // The config directory is what moves the catalog, not the home directory.
  const elsewhere = await listAgentCommands("opencode", home, path.join(home, "absent-config"));
  assert.deepEqual(elsewhere.commands.map((c) => c.name), ["shared"]);

  // Skill trees are symlink farms in practice: ~/.claude/skills entries link
  // into ~/.agents/skills, and opencode globs with symlink: true. A tree that
  // links back into itself must still terminate.
  await write(path.join(home, ".agents", "skills", "linked", "SKILL.md"), "---\nname: linked\ndescription: Behind a link.\n---\n");
  await mkdir(path.join(home, ".claude", "skills"), { recursive: true });
  await symlink(path.join(home, ".agents", "skills", "linked"), path.join(home, ".claude", "skills", "linked"));
  await symlink(path.join(home, ".agents", "skills"), path.join(home, ".agents", "skills", "loop"));
  await symlink(path.join(home, "absent-target"), path.join(home, ".agents", "skills", "broken"));
  const linked = await listAgentCommands("opencode", home, config);
  assert.ok(linked.commands.some((c) => c.name === "linked" && c.description === "Behind a link."), "symlinked skill resolves");
  // The cycle is visited once, so the name appears once and the walk returns.
  assert.equal(linked.commands.filter((c) => c.name === "linked").length, 1);
  assert.ok(!linked.commands.some((c) => c.name === "broken"), "broken link is skipped");
  await rm(home, { recursive: true, force: true });
}

{
  // Pi prompt templates: direct .md children of ~/.pi/agent/prompts become
  // /<file> commands beside /skill: skills. The description is the
  // frontmatter's, else the first non-empty line cut at 60.
  const home = await mkdtemp(path.join(tmpdir(), "moshpit-commands-"));
  const prompts = path.join(home, ".pi/agent/prompts");
  await mkdir(path.join(prompts, "nested"), { recursive: true });
  await writeFile(path.join(prompts, "review.md"), "---\ndescription: Review staged changes\nargument-hint: \"[focus]\"\n---\nReview ${1:-all}.\n");
  await writeFile(path.join(prompts, "fix.md"), "\n\n" + "Fix the failing tests and explain each change you make along the way please\n");
  await writeFile(path.join(prompts, "notes.txt"), "not a template");
  await writeFile(path.join(prompts, "nested", "deep.md"), "Only direct children load.");
  await skillHome(home, { ".pi/agent/skills": [["ask", "---\nname: ask\ndescription: Ask the user.\n---\n"]] });
  const pi = await listAgentCommands("pi", home);
  assert.deepEqual(
    pi.commands.map((c) => [c.invocation, c.description]),
    // Sorted by name, as every catalog is.
    [
      ["/skill:ask", "Ask the user."],
      ["/fix", "Fix the failing tests and explain each change you make along..."],
      ["/review", "Review staged changes"],
    ],
  );

  // Grok lists a skill only when its frontmatter sets user-invocable: true.
  await skillHome(home, {
    ".grok/skills": [
      ["commit", "---\nname: commit\ndescription: Commit.\nuser-invocable: true\n---\n"],
      ["helper", "---\nname: helper\ndescription: Model-only.\n---\n"],
      ["off", "---\nname: off\ndescription: Off.\nuser-invocable: false\n---\n"],
    ],
  });
  const grok = await listAgentCommands("grok", home);
  assert.deepEqual(grok.commands.map((c) => c.invocation), ["/commit"]);
  await rm(home, { recursive: true, force: true });
}

console.log("ok   per-kind skill catalogs, /skill: pi invocations, frontmatter, unknown kinds, caps");
console.log("ok   opencode command files, both spellings, nesting, and 2.0 skill trees");
