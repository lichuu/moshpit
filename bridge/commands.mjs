import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open, opendir, realpath } from "node:fs/promises";
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
const skills = (...dir) => ({ base: "home", dir, layout: "skill", origin: "home-skills" });
const SOURCES = {
  claude: { prefix: "/", scans: [skills(".claude", "skills")] },
  // The bridge demo labels the same agent "claude-code"; real herdr says "claude".
  "claude-code": { prefix: "/", scans: [skills(".claude", "skills")] },
  // Pi is pluggable: besides skills it loads prompt templates from
  // ~/.pi/agent/prompts (direct .md children, docs/prompt-templates.md) and
  // extensions that register commands in code. Extension commands exist only
  // inside the running pi, so pi is partial.
  pi: {
    prefix: "/skill:",
    scans: [
      { base: "home", dir: [".pi", "agent", "prompts"], layout: "template", prefix: "/", origin: "home-templates" },
      skills(".pi", "agent", "skills"),
    ],
  },
  codex: { prefix: "$", scans: [skills(".codex", "skills")] },
  // Grok offers a skill as `/<name>` only when its frontmatter sets
  // user-invocable: true, so only those are listed. Project skills are not
  // read (no per-project scope yet), so grok stays partial.
  grok: { prefix: "/", invocable: true, scans: [skills(".grok", "skills")] },
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
    scans: [
      { base: "config", dir: ["opencode", "command"], layout: "command", origin: "config-commands" },
      { base: "config", dir: ["opencode", "commands"], layout: "command", origin: "config-commands" },
      { base: "config", dir: ["opencode", "skill"], layout: "skill-tree", origin: "config-skills" },
      { base: "config", dir: ["opencode", "skills"], layout: "skill-tree", origin: "config-skills" },
      { base: "home", dir: [".claude", "skills"], layout: "skill-tree", origin: "shared-skills" },
      { base: "home", dir: [".agents", "skills"], layout: "skill-tree", origin: "shared-skills" },
    ],
  },
};
const LIMIT = 200;
const ENTRY_LIMIT = 1000;
const NAME_LIMIT = 80;
const DESCRIPTION_LIMIT = 300;
// Deep enough for any hand-written nesting, and a hard stop on a wild tree.
const MAX_DEPTH = 8;
const FILE_LIMIT = 256 * 1024;
const WARNING_LIMIT = 8;
export const DEFAULT_DEADLINE_MS = 2000;

const W = {
  missing: "source_missing",
  unreadable: "source_unreadable",
  oversized: "metadata_oversized",
  incomplete: "metadata_incomplete",
  overlong: "name_overlong",
  invalid: "name_invalid",
  capResults: "cap_results",
  capEntries: "cap_entries",
  capDepth: "cap_depth",
};

export class ScanStoppedError extends Error {
  constructor(reason) {
    super(`command scan stopped (${reason})`);
    this.name = "ScanStoppedError";
    this.code = "scan_stopped";
    this.reason = reason;
  }
}

export class CommandScopeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CommandScopeError";
    this.code = code;
  }
}

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

function createScanState({ signal, deadlineMs = DEFAULT_DEADLINE_MS, now = Date.now }) {
  const started = now();
  const state = {
    signal,
    deadlineMs,
    now,
    started,
    commands: [],
    seen: new Set(),
    examined: 0,
    truncated: false,
    warnings: new Set(),
    fingerprint: new Set(),
  };
  state.stopped = () => {
    if (signal?.aborted) throw new ScanStoppedError("aborted");
    if (now() - started > deadlineMs) throw new ScanStoppedError("deadline");
  };
  state.note = (code) => {
    if (state.warnings.size < WARNING_LIMIT) state.warnings.add(code);
  };
  state.examine = () => {
    if (state.examined >= ENTRY_LIMIT) {
      state.truncated = true;
      state.note(W.capEntries);
      return false;
    }
    state.examined += 1;
    return true;
  };
  state.full = () => {
    if (state.commands.length >= LIMIT) {
      state.truncated = true;
      state.note(W.capResults);
      return true;
    }
    return false;
  };
  return state;
}

// The wait settles on the abort or the deadline even while the filesystem
// call is still pending: Node cannot cancel a pending fs request, so the
// caller owns whatever the late result produces (a descriptor to close).
// A stop that lands before the race arms still observes the started
// operation first: its late rejection must not surface as unhandled.
function raceSettled(pending, state) {
  const elapsed = state.now() - state.started;
  if (state.signal?.aborted || elapsed >= state.deadlineMs) {
    pending.catch(() => {});
    return Promise.reject(new ScanStoppedError(state.signal?.aborted ? "aborted" : "deadline"));
  }
  const remaining = state.deadlineMs - elapsed;
  return new Promise((resolve, reject) => {
    let timer;
    const onAbort = () => {
      cleanup();
      reject(new ScanStoppedError("aborted"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      state.signal?.removeEventListener("abort", onAbort);
    };
    timer = setTimeout(() => {
      cleanup();
      reject(new ScanStoppedError("deadline"));
    }, remaining);
    timer.unref?.();
    state.signal?.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

// A close outlives the stop when it waits behind pending filesystem work:
// the caller must not wait on it, but the late result stays observed so it
// cannot surface as an unhandled rejection.
async function closeSettled(close, state) {
  const pending = close.catch(() => {});
  try {
    await raceSettled(pending, state);
  } catch {
    // The stop won the race; the close settles on its own, observed.
  }
}

const MISSING_CODES = new Set(["ENOENT", "ENOTDIR"]);

function noteFsError(state, error) {
  if (error instanceof ScanStoppedError) throw error;
  state.note(MISSING_CODES.has(error.code) ? W.missing : W.unreadable);
}

// O_NONBLOCK keeps a FIFO or device at a metadata path from holding the
// request: the descriptor is checked before any read, and a handle that
// arrives after cancellation is closed.
async function openRegular(file, state) {
  const pending = open(file, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  let fd;
  try {
    fd = await raceSettled(pending, state);
  } catch (error) {
    pending.then((late) => late.close().catch(() => {}), () => {});
    throw error;
  }
  try {
    const stats = await raceSettled(fd.stat(), state);
    if (!stats.isFile()) {
      await closeSettled(fd.close(), state);
      return { stats, regular: false };
    }
    return { fd, stats, regular: true };
  } catch (error) {
    await closeSettled(fd.close(), state);
    throw error;
  }
}

async function openDir(dir, state) {
  const pending = opendir(dir);
  try {
    return await raceSettled(pending, state);
  } catch (error) {
    pending.then((late) => late.close().catch(() => {}), () => {});
    throw error;
  }
}

async function readBounded(file, at, scan, state) {
  let opened;
  try {
    opened = await openRegular(file, state);
  } catch (error) {
    noteFsError(state, error);
    return null;
  }
  if (!opened.regular) {
    state.note(W.unreadable);
    return null;
  }
  const { fd, stats } = opened;
  state.fingerprint.add(`${scan.origin}:${at}:${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}`);
  try {
    if (stats.size > FILE_LIMIT) {
      state.truncated = true;
      state.note(W.oversized);
      return null;
    }
    const buf = Buffer.alloc(stats.size);
    let offset = 0;
    while (offset < stats.size) {
      state.stopped();
      let read;
      try {
        read = await raceSettled(fd.read(buf, offset, stats.size - offset, offset), state);
      } catch (error) {
        noteFsError(state, error);
        return null;
      }
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    if (offset < stats.size) {
      state.note(W.incomplete);
      return null;
    }
    return { raw: buf.toString("utf8"), stats };
  } finally {
    await closeSettled(fd.close(), state);
  }
}

// Whitespace or control character: a name the client parser would refuse.
const INVALID_NAME = (name) =>
  [...name].some((ch) => {
    const c = ch.codePointAt(0);
    return (
      c <= 0x20 ||
      c === 0x7f ||
      c === 0xa0 ||
      c === 0x1680 ||
      (c >= 0x2000 && c <= 0x200a) ||
      (c >= 0x2028 && c <= 0x2029) ||
      c === 0x202f ||
      c === 0x205f ||
      c === 0x3000 ||
      c === 0xfeff
    );
  });

function addCommand(at, raw, stats, scan, state) {
  const meta = headerMeta(raw);
  let description = typeof meta.description === "string" ? meta.description : "";
  // Pi falls back to the template's first non-empty line, cut at 60.
  if (!description && scan.layout === "template") {
    const line = templateBody(raw).split(/\r?\n/).find((l) => l.trim()) ?? "";
    description = line.length > 60 ? `${line.slice(0, 60)}...` : line;
  }
  description = description.slice(0, DESCRIPTION_LIMIT);
  if (scan.source.invocable && meta["user-invocable"] !== "true") return;
  if ((scan.kind === "pi" || scan.layout === "skill-tree") && !description) return;
  const name = commandName(scan.kind, scan, at, meta);
  if (!name) return;
  if (name.length > NAME_LIMIT) {
    state.note(W.overlong);
    return;
  }
  if (INVALID_NAME(name)) {
    state.note(W.invalid);
    return;
  }
  const invocation = `${scan.prefix ?? scan.source.prefix}${name}`;
  if (state.seen.has(invocation)) return;
  state.seen.add(invocation);
  state.commands.push({ name, invocation, description, origin: scan.origin });
}

async function readCandidate(file, at, scan, state) {
  state.stopped();
  const read = await readBounded(file, at, scan, state);
  if (read) addCommand(at, read.raw, read.stats, scan, state);
}

// The nested layouts put commands at any depth, so this walks the tree.
// Skill trees are routinely symlink farms -- a ~/.claude/skills entry linked
// into ~/.agents/skills is the common shape -- and the agents follow those,
// so this does too. Each directory's real path is remembered, so a link
// pointing back up the tree stops instead of looping.
async function walk(dir, relative, depth, wanted, scan, state, visited) {
  state.stopped();
  if (state.full()) return;
  if (depth > MAX_DEPTH) {
    state.truncated = true;
    state.note(W.capDepth);
    return;
  }
  let handle;
  try {
    handle = await openDir(dir, state);
  } catch (error) {
    noteFsError(state, error);
    return;
  }
  let real;
  try {
    real = await raceSettled(realpath(dir), state);
  } catch (error) {
    await closeSettled(handle.close(), state);
    noteFsError(state, error);
    return;
  }
  if (visited.has(real)) {
    await closeSettled(handle.close(), state);
    return;
  }
  visited.add(real);
  // The explicit next() keeps the directory read on the shared stop: a
  // for-await loop would await the read and the iterator cleanup without
  // racing either.
  const entries = handle[Symbol.asyncIterator]();
  try {
    for (;;) {
      state.stopped();
      let step;
      try {
        step = await raceSettled(entries.next(), state);
      } catch (error) {
        // A stop propagates; an unreadable directory notes its source and
        // the walk stops there, leaving siblings and other sources intact.
        noteFsError(state, error);
        return;
      }
      if (step.done) break;
      const entry = step.value;
      if (state.full()) return;
      if (!state.examine()) return;
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      // A symlink reports as neither file nor directory until it is followed,
      // so try both: the descent no-ops on a file, the match on a directory.
      if (entry.isDirectory() || entry.isSymbolicLink())
        await walk(path.join(dir, entry.name), next, depth + 1, wanted, scan, state, visited);
      if (!entry.isDirectory() && wanted(entry.name)) await readCandidate(path.join(dir, entry.name), next, scan, state);
    }
  } finally {
    await closeSettled(handle.close(), state);
  }
}

async function scanLevel(root, keep, sub, scan, state) {
  state.stopped();
  if (state.full()) return;
  let handle;
  try {
    handle = await openDir(root, state);
  } catch (error) {
    noteFsError(state, error);
    return;
  }
  const entries = handle[Symbol.asyncIterator]();
  try {
    for (;;) {
      state.stopped();
      let step;
      try {
        step = await raceSettled(entries.next(), state);
      } catch (error) {
        // A stop propagates; an unreadable source notes itself and the level
        // ends, leaving the remaining sources intact.
        noteFsError(state, error);
        return;
      }
      if (step.done) break;
      const entry = step.value;
      if (state.full()) return;
      if (!state.examine()) return;
      if (!keep(entry)) continue;
      const at = entry.name;
      const file = sub ? path.join(root, entry.name, sub) : path.join(root, entry.name);
      await readCandidate(file, at, scan, state);
    }
  } finally {
    await closeSettled(handle.close(), state);
  }
}

async function scanSource(scan, bases, state) {
  const root = path.join(bases[scan.base], ...scan.dir);
  state.stopped();
  let real;
  try {
    real = await raceSettled(realpath(root), state);
  } catch (error) {
    if (error instanceof ScanStoppedError) throw error;
    const missing = Boolean(error?.code) && MISSING_CODES.has(error.code);
    state.note(missing ? W.missing : W.unreadable);
    state.fingerprint.add(`${missing ? "missing" : "unreadable"}:${scan.origin}:${scan.base}/${scan.dir.join("/")}`);
    return;
  }
  state.fingerprint.add(`root:${scan.origin}:${real}`);
  if (scan.layout === "template") {
    await scanLevel(root, (entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md"), null, scan, state);
    return;
  }
  if (scan.layout === "skill") {
    await scanLevel(root, (entry) => entry.isDirectory() || entry.isSymbolicLink(), "SKILL.md", scan, state);
    return;
  }
  const wanted = scan.layout === "command" ? (name) => name.endsWith(".md") : (name) => name === "SKILL.md";
  await walk(root, "", 0, wanted, scan, state, new Set());
}

function revisionFor(fingerprint, warnings) {
  const lines = [...fingerprint].sort();
  lines.push(`warnings:${[...warnings].sort().join(",")}`);
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

export async function scanAgentCommands({
  kind,
  home = os.homedir(),
  configHome = process.env.XDG_CONFIG_HOME || path.join(home, ".config"),
  signal,
  deadlineMs = DEFAULT_DEADLINE_MS,
  now = Date.now,
}) {
  return scanKind({ kind, home, configHome }, createScanState({ signal, deadlineMs, now }));
}

async function scanKind({ kind, home, configHome }, state) {
  const source =
    typeof kind === "string" && Object.hasOwn(SOURCES, kind)
      ? SOURCES[kind]
      : undefined;
  state.stopped();
  if (!source) {
    return {
      kind: typeof kind === "string" ? kind : "",
      coverage: "unsupported",
      truncated: false,
      prefixes: [],
      commands: [],
      warnings: [],
      revision: revisionFor(new Set(), new Set()),
    };
  }
  const bases = { home, config: configHome };
  for (const scan of source.scans) {
    state.stopped();
    if (state.full()) break;
    await scanSource({ ...scan, source, kind }, bases, state);
  }
  state.stopped();
  state.commands.sort((a, b) => a.name.localeCompare(b.name));
  const truncated = state.truncated || state.commands.length > LIMIT;
  return {
    kind,
    coverage: "partial",
    truncated,
    prefixes: [...new Set([source.prefix, ...source.scans.map((scan) => scan.prefix).filter(Boolean)])].sort(
      (a, b) => b.length - a.length,
    ),
    commands: state.commands.slice(0, LIMIT),
    warnings: [...state.warnings],
    revision: revisionFor(state.fingerprint, state.warnings),
  };
}

export async function listAgentCommands(
  kind,
  home = os.homedir(),
  configHome = process.env.XDG_CONFIG_HOME || path.join(home, ".config"),
) {
  const result = await scanAgentCommands({ kind, home, configHome });
  return {
    kind: result.kind,
    prefix: result.prefixes[0] ?? "",
    prefixes: result.prefixes,
    commands: result.commands.map(({ name, invocation, description }) => ({ name, invocation, description })),
    coverage: result.coverage,
  };
}

export function projectToken(agent) {
  return JSON.stringify([agent.projectRoot ?? null, agent.cwd]);
}

async function stoppedAwait(promise, state) {
  try {
    return await promise;
  } catch (error) {
    state.stopped();
    throw error;
  }
}

export async function scopedCatalog({
  snapshot,
  target,
  sessionId,
  signal,
  deadlineMs = DEFAULT_DEADLINE_MS,
  home = os.homedir(),
  configHome = process.env.XDG_CONFIG_HOME || path.join(home, ".config"),
  now = Date.now,
}) {
  const state = createScanState({ signal, deadlineMs, now });
  state.stopped();
  const before = await stoppedAwait(snapshot({ freshProjectFor: target, signal, targeted: true }), state);
  state.stopped();
  const beforeAgent = (before.agents ?? []).find((candidate) => candidate.id === target);
  if (!beforeAgent) throw new CommandScopeError("command_target_unknown", "Unknown agent.");
  if (beforeAgent.sessionId !== sessionId)
    throw new CommandScopeError("command_scope_changed", "The command scope changed.");
  if (!beforeAgent.cwd)
    throw new CommandScopeError("command_scope_changed", "The command scope changed.");
  const scan = await scanKind({ kind: beforeAgent.kind, home, configHome }, state);
  const after = await stoppedAwait(snapshot({ freshProjectFor: target, signal, targeted: true }), state);
  state.stopped();
  const afterAgent = (after.agents ?? []).find((candidate) => candidate.id === target);
  if (
    !afterAgent ||
    afterAgent.sessionId !== sessionId ||
    afterAgent.kind !== beforeAgent.kind ||
    afterAgent.cwd !== beforeAgent.cwd ||
    afterAgent.projectRoot !== beforeAgent.projectRoot
  )
    throw new CommandScopeError("command_scope_changed", "The command scope changed.");
  return {
    scope: { target, sessionId, project: projectToken(afterAgent) },
    revision: scan.revision,
    coverage: scan.coverage,
    truncated: scan.truncated,
    prefixes: scan.prefixes,
    commands: scan.commands,
    warnings: scan.warnings,
  };
}

export const COMMANDS_SOURCES = SOURCES;
