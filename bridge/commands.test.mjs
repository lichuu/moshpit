import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, writeFile, rm, symlink, utimes } from "node:fs/promises";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
// This Node build ships no fs.mkfifo; the coreutils binary is the fallback.
const mkfifo = (file) => execFileAsync("mkfifo", [file]);
import { tmpdir } from "node:os";
import path from "node:path";
import { listAgentCommands, scanAgentCommands, ScanStoppedError } from "./commands.mjs";

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
  assert.equal(claude.coverage, "partial");
  assert.equal(pi.coverage, "partial");
  assert.deepEqual(pi.prefixes, ["/skill:", "/"]);
  assert.equal(codex.coverage, "partial");
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
  assert.deepEqual(missing, { kind: "claude", prefix: "/", prefixes: ["/"], commands: [], coverage: "partial" });
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

{
  // The result cap stops the scan, marks truncation, and reports it
  // categorically. Which 200 of 205 survive depends on directory order, so
  // assert the bound and the flag, not a specific survivor.
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
  const scan = await scanAgentCommands({ kind: "claude", home });
  assert.equal(scan.commands.length, 200);
  assert.equal(scan.truncated, true);
  assert.ok(scan.warnings.includes("cap_results"), "truncation is reported categorically");
  assert.ok(scan.commands.every((c) => c.origin === "home-skills"), "entries carry their bounded origin");
  await rm(home, { recursive: true, force: true });
}

{
  const home = await mkdtemp(path.join(tmpdir(), "moshpit-commands-entries-"));
  const wide = path.join(home, ".claude", "skills");
  await mkdir(wide, { recursive: true });
  await Promise.all(
    Array.from({ length: 1100 }, (_, i) =>
      mkdir(path.join(wide, `empty-${String(i).padStart(4, "0")}`), { recursive: true }),
    ),
  );
  const scan = await scanAgentCommands({ kind: "claude", home });
  assert.equal(scan.commands.length, 0);
  assert.equal(scan.truncated, true);
  assert.ok(scan.warnings.includes("cap_entries"), "the examined-entry cap is reported");
  await rm(home, { recursive: true, force: true });
}

{
  const home = await mkdtemp(path.join(tmpdir(), "moshpit-commands-depth-"));
  let dir = path.join(home, ".agents", "skills");
  for (let i = 0; i < 12; i += 1) dir = path.join(dir, `level-${i}`);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "SKILL.md"), "---\nname: deep\ndescription: Too deep.\n---\n");
  const scan = await scanAgentCommands({ kind: "opencode", home, configHome: path.join(home, "absent-config") });
  assert.equal(scan.commands.length, 0);
  assert.equal(scan.truncated, true);
  assert.ok(scan.warnings.includes("cap_depth"), "the depth cap is reported");
  await rm(home, { recursive: true, force: true });
}

{
  const home = await mkdtemp(path.join(tmpdir(), "moshpit-commands-bounds-"));
  const big = path.join(home, ".claude", "skills", "big");
  await mkdir(big, { recursive: true });
  await writeFile(path.join(big, "SKILL.md"), "---\nname: big\ndescription: d\n---\n" + "x".repeat(256 * 1024));
  const long = path.join(home, ".claude", "skills", "n".repeat(90));
  await mkdir(long, { recursive: true });
  await writeFile(path.join(long, "SKILL.md"), "---\nname: long\ndescription: d\n---\n");
  const ok = path.join(home, ".claude", "skills", "ok");
  await mkdir(ok, { recursive: true });
  await writeFile(path.join(ok, "SKILL.md"), "---\nname: ok\ndescription: Fine.\n---\n");
  const scan = await scanAgentCommands({ kind: "claude", home });
  assert.deepEqual(scan.commands.map((c) => c.name), ["ok"]);
  assert.ok(scan.warnings.includes("metadata_oversized"), "oversized metadata is reported");
  assert.ok(scan.warnings.includes("name_overlong"), "overlong names are reported");
  assert.ok(scan.warnings.every((w) => !w.includes(home)), "warnings carry no filesystem paths");
  await rm(home, { recursive: true, force: true });
}

{
  const home = await mkdtemp(path.join(tmpdir(), "moshpit-commands-revision-"));
  await skillHome(home, { ".claude/skills": [["one", "---\nname: one\ndescription: One.\n---\n"]] });
  const first = await scanAgentCommands({ kind: "claude", home });
  const again = await scanAgentCommands({ kind: "claude", home });
  assert.equal(first.revision, again.revision, "an unchanged home revises identically");
  assert.match(first.revision, /^[0-9a-f]{64}$/);
  await skillHome(home, { ".claude/skills": [["two", "---\nname: two\ndescription: Two.\n---\n"]] });
  const changed = await scanAgentCommands({ kind: "claude", home });
  assert.notEqual(changed.revision, first.revision, "a changed source revises");
  const absent = await scanAgentCommands({ kind: "claude", home: path.join(home, "absent") });
  assert.equal(absent.commands.length, 0);
  assert.ok(absent.warnings.includes("source_missing"), "a missing root is reported");
  assert.notEqual(absent.revision, first.revision);
  await rm(home, { recursive: true, force: true });
}

{
  const home = await mkdtemp(path.join(tmpdir(), "moshpit-commands-stop-"));
  await skillHome(home, { ".claude/skills": [["one", "---\nname: one\ndescription: One.\n---\n"]] });
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    scanAgentCommands({ kind: "claude", home, signal: aborted.signal }),
    (error) => error instanceof ScanStoppedError && error.reason === "aborted",
  );
  let clock = 0;
  const slow = await (async () => {
    try {
      await scanAgentCommands({
        kind: "claude",
        home,
        deadlineMs: 5,
        now: () => {
          clock += 10;
          return clock;
        },
      });
      return null;
    } catch (error) {
      return error;
    }
  })();
  assert.ok(slow instanceof ScanStoppedError && slow.reason === "deadline", "the deadline stops the scan");
  await rm(home, { recursive: true, force: true });
}

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

{
  // A FIFO at a metadata path must not hold the scan: the non-blocking open
  // refuses it before any read, and a symlink to a regular file still loads.
  const home = await mkdtemp(path.join(tmpdir(), "moshpit-commands-fifo-"));
  const skillsDir = path.join(home, ".claude", "skills");
  const probe = path.join(skillsDir, "probe");
  await mkdir(probe, { recursive: true });
  await mkfifo(path.join(probe, "SKILL.md"));
  await mkdir(path.join(skillsDir, "ok"), { recursive: true });
  await writeFile(path.join(skillsDir, "ok", "SKILL.md"), "---\nname: ok\ndescription: Fine.\n---\n");
  const linkedDir = path.join(skillsDir, "linkeddir");
  await mkdir(linkedDir, { recursive: true });
  await writeFile(path.join(home, "real-skill.md"), "---\nname: linked-file\ndescription: Behind a file link.\n---\n");
  await symlink(path.join(home, "real-skill.md"), path.join(linkedDir, "SKILL.md"));
  const startedAt = Date.now();
  const scan = await scanAgentCommands({ kind: "claude", home, signal: AbortSignal.timeout(100) });
  assert.ok(Date.now() - startedAt < 1000, "a FIFO metadata path did not hold the scan");
  assert.deepEqual(scan.commands.map((c) => c.name), ["linkeddir", "ok"]);
  assert.ok(scan.warnings.includes("source_unreadable"), "the FIFO is reported categorically");
  await rm(home, { recursive: true, force: true });
}

{
  // A whitespace- or control-bearing scanner name is refused categorically
  // and never invalidates the neighboring valid commands.
  const home = await mkdtemp(path.join(tmpdir(), "moshpit-commands-invalid-"));
  await skillHome(home, {
    ".claude/skills": [
      ["bad skill", "---\nname: bad skill\ndescription: Spaced.\n---\n"],
      ["ok", "---\nname: ok\ndescription: Fine.\n---\n"],
    ],
    ".pi/agent/skills": [["ctl", "---\nname: bad\u0001name\ndescription: Control.\n---\n"]],
  });
  const scan = await scanAgentCommands({ kind: "claude", home });
  assert.deepEqual(scan.commands.map((c) => c.name), ["ok"]);
  assert.ok(scan.warnings.includes("name_invalid"), "the invalid name is reported categorically");
  assert.ok(scan.commands.every((c) => !/\s/.test(c.invocation)), "no invocation carries whitespace");
  const pi = await scanAgentCommands({ kind: "pi", home });
  assert.equal(pi.commands.length, 0);
  assert.ok(pi.warnings.includes("name_invalid"), "a control-bearing frontmatter name is refused");
  await rm(home, { recursive: true, force: true });
}

{
  if (process.getuid?.() !== 0) {
    // Unreadable metadata under an accessible root is source_unreadable, not
    // source_missing, and does not stop the rest of the scan.
    const home = await mkdtemp(path.join(tmpdir(), "moshpit-commands-unreadable-"));
    await skillHome(home, {
      ".claude/skills": [
        ["secret", "---\nname: secret\ndescription: Hidden.\n---\n"],
        ["ok", "---\nname: ok\ndescription: Fine.\n---\n"],
      ],
    });
    await chmod(path.join(home, ".claude", "skills", "secret", "SKILL.md"), 0o000);
    const scan = await scanAgentCommands({ kind: "claude", home });
    assert.deepEqual(scan.commands.map((c) => c.name), ["ok"]);
    assert.ok(scan.warnings.includes("source_unreadable"), "inaccessible metadata is reported");
    assert.ok(!scan.warnings.includes("source_missing"), "an inaccessible file is not a missing source");
    await chmod(path.join(home, ".claude", "skills", "secret", "SKILL.md"), 0o644);
    await rm(home, { recursive: true, force: true });
  }
}

{
  // The revision carries descriptor identity: a metadata symlink swapped
  // between same-size, same-mtime targets revises.
  const home = await mkdtemp(path.join(tmpdir(), "moshpit-commands-swap-"));
  const real = path.join(home, "real");
  await mkdir(real, { recursive: true });
  const a = path.join(real, "a.md");
  const b = path.join(real, "b.md");
  await writeFile(a, "---\nname: one\ndescription: A.\n---\n");
  await writeFile(b, "---\nname: one\ndescription: B.\n---\n");
  const stamp = new Date(1700000000000);
  await utimes(a, stamp, stamp);
  await utimes(b, stamp, stamp);
  const skillDir = path.join(home, ".claude", "skills", "probe");
  await mkdir(skillDir, { recursive: true });
  const link = path.join(skillDir, "SKILL.md");
  await symlink(a, link);
  const first = await scanAgentCommands({ kind: "claude", home });
  await rm(link);
  await symlink(b, link);
  const second = await scanAgentCommands({ kind: "claude", home });
  assert.notEqual(second.revision, first.revision, "a same-size same-mtime symlink swap revises");
  await rm(home, { recursive: true, force: true });
}

{
  // The revision associates each fingerprint with its source: the same
  // relative name in two sources revises when only one changes.
  const home = await mkdtemp(path.join(tmpdir(), "moshpit-commands-xsource-"));
  const claudeX = path.join(home, ".claude", "skills", "x", "SKILL.md");
  const agentsX = path.join(home, ".agents", "skills", "x", "SKILL.md");
  await mkdir(path.dirname(claudeX), { recursive: true });
  await mkdir(path.dirname(agentsX), { recursive: true });
  await writeFile(claudeX, "---\nname: x\ndescription: One.\n---\n");
  await writeFile(agentsX, "---\nname: x\ndescription: One.\n---\n");
  const first = await scanAgentCommands({ kind: "opencode", home, configHome: path.join(home, "absent-config") });
  await writeFile(agentsX, "---\nname: x\ndescription: A longer description.\n---\n");
  const second = await scanAgentCommands({ kind: "opencode", home, configHome: path.join(home, "absent-config") });
  assert.notEqual(second.revision, first.revision, "a cross-source same-name change revises");
  await rm(home, { recursive: true, force: true });
}

console.log("ok   per-kind skill catalogs, /skill: pi invocations, frontmatter, unknown kinds, caps");
console.log("ok   opencode command files, both spellings, nesting, and 2.0 skill trees");
console.log("ok   bounded scan: entry/depth/size caps, overlong names, categorical warnings, revision");
console.log("ok   deadline and abort stop the scan without publishing");
console.log("ok   FIFO refusal, invalid names, unreadable sources, descriptor-identity revision");
