import { readdir, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Real per-agent command directories on the host. The kind is validated
// against this fixed map: clients can never steer this reader at an
// arbitrary path, and kinds herdr does not catalog simply have no list.
// The prefix is the agent's real invocation syntax: claude skills are
// `/<name>`, codex `$<name>`, and pi registers skills as `/skill:<name>`
// (pi docs/skills.md; dist registers the command as `skill:${skill.name}`).
//
// A scan names a base -- the home directory, or the XDG config directory --
// a directory under it, and a layout:
//   skill       one directory per command holding SKILL.md, named by the
//               directory (pi instead prefers the frontmatter name)
//   command     one markdown file per command at any depth, named by its
//               path under the scanned directory with the extension dropped
//   skill-tree  SKILL.md at any depth, named by its frontmatter, which is
//               required along with a description
//   template    one markdown file per command, direct children only, named
//               by the file (pi prompt templates)
//
// A scan may carry its own prefix when the harness invokes that source
// differently: pi runs skills as /skill:<name> but templates as /<name>.
const skills = (...dir) => ({ base: "home", dir, layout: "skill" });
const SOURCES = {
  claude: { prefix: "/", coverage: "full", scans: [skills(".claude", "skills")] },
  // The bridge demo labels the same agent "claude-code"; real herdr says "claude".
  "claude-code": { prefix: "/", coverage: "full", scans: [skills(".claude", "skills")] },
  // Pi is pluggable: besides skills it loads prompt templates from
  // ~/.pi/agent/prompts (direct .md children, docs/prompt-templates.md) and
  // extensions that register commands in code. Extension commands can only
  // be listed by the running pi (its RPC get_commands), so pi is partial.
  pi: {
    prefix: "/skill:",
    coverage: "partial",
    scans: [
      { base: "home", dir: [".pi", "agent", "prompts"], layout: "template", prefix: "/" },
      skills(".pi", "agent", "skills"),
    ],
  },
  codex: { prefix: "$", coverage: "full", scans: [skills(".codex", "skills")] },
  // Grok offers a skill as `/<name>` only when its frontmatter sets
  // user-invocable: true, so only those are listed. Project skills are not
  // read (no per-project scope yet), so grok stays partial.
  grok: { prefix: "/", coverage: "partial", invocable: true, scans: [skills(".grok", "skills")] },
  // opencode keeps user commands as markdown under the XDG config directory,
  // named by path with the extension dropped, so commands/git/commit.md is
  // `/git/commit`. Both spellings count: its loader globs
  // `{command,commands}/**/*.md` (src/config/command.ts, entry-name.ts).
  //
  // 2.0 also promotes skills to slash commands -- its own `{skill,skills}`
  // directories plus the shared ~/.claude and ~/.agents trees -- taking each
  // name from SKILL.md frontmatter (src/skill/index.ts, src/command/index.ts).
  // Those are listed so the catalog is right when 2.0 lands; on 1.x the same
  // files are reached through a tool call and have no slash form, which is
  // part of why opencode coverage is partial. Built-ins (/init, /review) and
  // MCP prompts are not on disk, so they are never listed.
  opencode: {
    prefix: "/",
    coverage: "partial",
    scans: [
      { base: "config", dir: ["opencode", "command"], layout: "command" },
      { base: "config", dir: ["opencode", "commands"], layout: "command" },
      { base: "config", dir: ["opencode", "skill"], layout: "skill-tree" },
      { base: "config", dir: ["opencode", "skills"], layout: "skill-tree" },
      { base: "home", dir: [".claude", "skills"], layout: "skill-tree" },
      { base: "home", dir: [".agents", "skills"], layout: "skill-tree" },
    ],
  },
};
const LIMIT = 200;
const NAME_LIMIT = 80;
const DESCRIPTION_LIMIT = 300;
// Deep enough for any hand-written nesting, and a hard stop on a wild tree.
const MAX_DEPTH = 8;

// Minimal frontmatter reader: name/description from the leading --- block,
// one field per line, optional quotes.
function headerMeta(raw) {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return {};
  const meta = {};
  for (const line of lines.slice(1)) {
    if (line.trim() === "---") break;
    const match = line.match(/^(name|description|user-invocable):\s*(.*)$/);
    if (match) {
      let value = match[2].trim();
      const quoted = value.match(/^"(.*)"$/) ?? value.match(/^'(.*)'$/);
      if (quoted) value = quoted[1];
      meta[match[1]] = value;
    }
  }
  return meta;
}

// The nested layouts put commands at any depth, so this walks the tree.
// Skill trees are routinely symlink farms -- a ~/.claude/skills entry linked
// into ~/.agents/skills is the common shape -- and the agents follow those,
// so this does too. Each directory's real path is remembered, so a link
// pointing back up the tree stops instead of looping.
async function walk(root, relative, depth, wanted, out, visited) {
  if (depth > MAX_DEPTH || out.length > LIMIT) return;
  const here = path.join(root, relative);
  let real;
  try {
    real = await realpath(here);
  } catch {
    return; // A broken link resolves to nothing and holds no commands.
  }
  if (visited.has(real)) return;
  visited.add(real);
  let entries;
  try {
    entries = await readdir(here, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const next = relative ? `${relative}/${entry.name}` : entry.name;
    // A symlink reports as neither file nor directory until it is followed,
    // so try both: the descent no-ops on a file, the match on a directory.
    if (entry.isDirectory() || entry.isSymbolicLink()) await walk(root, next, depth + 1, wanted, out, visited);
    if (!entry.isDirectory() && wanted(entry.name)) out.push(next);
  }
}

async function candidates(scan, bases) {
  const root = path.join(bases[scan.base], ...scan.dir);
  if (scan.layout === "template") {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md"))
      .map((entry) => ({ at: entry.name, file: path.join(root, entry.name) }));
  }
  if (scan.layout === "skill") {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      return [];
    }
    // Skill directories are commonly symlinked; readFile follows the link,
    // and a broken one simply skips the entry.
    return entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => ({ at: entry.name, file: path.join(root, entry.name, "SKILL.md") }));
  }
  const found = [];
  const wanted = scan.layout === "command" ? (name) => name.endsWith(".md") : (name) => name === "SKILL.md";
  // A fresh visited set per scan: two scans reaching one real directory by
  // different links should each report it, and the name dedupe settles it.
  await walk(root, "", 0, wanted, found, new Set());
  return found.map((at) => ({ at, file: path.join(root, at) }));
}

// A template's text after its frontmatter block, if it has one.
function templateBody(raw) {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return raw;
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  return end === -1 ? "" : lines.slice(end + 1).join("\n");
}

function commandName(kind, scan, at, meta) {
  const named = typeof meta.name === "string" && meta.name ? meta.name : "";
  // opencode 2.0 keys a skill by its frontmatter name alone.
  if (scan.layout === "skill-tree") return named;
  // A pi prompt template is named by its file alone.
  if (scan.layout === "template") return at.replace(/\.md$/, "");
  // A markdown command is named by its path, but opencode spreads the
  // frontmatter over that, so a name field there still wins.
  if (scan.layout === "command") return named || at.replace(/\.md$/, "");
  // Pi resolves the skill name from the frontmatter, falling back to the
  // directory name.
  return kind === "pi" && named ? named : at;
}

export async function listAgentCommands(
  kind,
  home = os.homedir(),
  // opencode resolves its config directory through xdg-basedir, so an
  // XDG_CONFIG_HOME pointing elsewhere moves the whole catalog. It is read
  // from the host environment here and never from anything a client sends.
  configHome = process.env.XDG_CONFIG_HOME || path.join(home, ".config"),
) {
  const source =
    typeof kind === "string" && Object.hasOwn(SOURCES, kind)
      ? SOURCES[kind]
      : undefined;
  if (!source) return { kind: typeof kind === "string" ? kind : "", prefix: "", prefixes: [], commands: [], coverage: "unsupported" };
  const bases = { home, config: configHome };
  const commands = [];
  const seen = new Set();
  for (const scan of source.scans) {
    for (const candidate of await candidates(scan, bases)) {
      let raw;
      try {
        raw = await readFile(candidate.file, "utf8");
      } catch {
        continue; // An entry without a readable markdown file is not a command.
      }
      const meta = headerMeta(raw);
      let description = typeof meta.description === "string" ? meta.description : "";
      // Pi falls back to the template's first non-empty line, cut at 60.
      if (!description && scan.layout === "template") {
        const line = templateBody(raw).split(/\r?\n/).find((l) => l.trim()) ?? "";
        description = line.length > 60 ? `${line.slice(0, 60)}...` : line;
      }
      description = description.slice(0, DESCRIPTION_LIMIT);
      // Grok lists a skill as a command only when it opts in.
      if (source.invocable && meta["user-invocable"] !== "true") continue;
      // Pi does not load a SKILL.md without a description -- such an entry
      // registers no /skill: command -- and opencode 2.0 drops a skill whose
      // frontmatter is missing either field. Neither is listed.
      if ((kind === "pi" || scan.layout === "skill-tree") && !description) continue;
      const name = commandName(kind, scan, candidate.at, meta).slice(0, NAME_LIMIT);
      const invocation = `${scan.prefix ?? source.prefix}${name}`;
      // An invocation an earlier scan claimed wins, matching how the agents
      // resolve their own precedence: commands before skills, config before
      // home. Keyed by invocation, since pi's /ask and /skill:ask coexist.
      if (!name || seen.has(invocation)) continue;
      seen.add(invocation);
      commands.push({ name, invocation, description });
    }
  }
  commands.sort((a, b) => a.name.localeCompare(b.name));
  const truncated = commands.length > LIMIT;
  return {
    kind,
    prefix: source.prefix,
    // Every prefix this catalog's invocations use, so a client can match
    // each; `prefix` stays the primary one for older clients.
    prefixes: [...new Set([source.prefix, ...source.scans.map((scan) => scan.prefix).filter(Boolean)])],
    commands: commands.slice(0, LIMIT),
    coverage: truncated && source.coverage === "full" ? "partial" : source.coverage,
  };
}

export const COMMANDS_SOURCES = SOURCES;
