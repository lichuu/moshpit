export type CommandSuggestion = {
  name: string;
  invocation: string;
  description: string;
  /** "built-in" for the harness's own commands; a bounded source category for skills read from the host. */
  origin?: string;
};

export type CommandCoverage = "full" | "partial" | "unsupported";

export type TokenRange = { start: number; end: number };

// A token is active when it leads a whitespace-delimited token with the
// agent's exact prefix (/ for claude, $ for codex, /skill: for pi) and
// the rest of the token is a partial skill name. A token in another
// agent's syntax (a / or $ token on a /skill: catalog) never triggers,
// and a slash that is not the first character of the token (a URL, a
// path, C:/…) never triggers.
const BODY = /^[a-z0-9][a-z0-9-]*$/i;

export function detectToken(
  text: string,
  caret: number,
  prefix: string,
): TokenRange | null {
  if (!prefix) return null;
  if (caret > text.length) caret = text.length;
  let i = caret - 1;
  while (i >= 0 && !/\s/.test(text[i])) i -= 1;
  const start = i + 1;
  const token = text.slice(start, caret);
  if (!token.startsWith(prefix)) return null;
  const rest = token.slice(prefix.length);
  if (rest.length > 0 && !BODY.test(rest)) return null;
  let end = caret;
  while (end < text.length && !/\s/.test(text[end])) end += 1;
  return { start, end };
}

// Replace the whole active token, including any text typed past the caret,
// and add a trailing space unless the draft already has one there.
export function insertSuggestion(
  text: string,
  range: TokenRange,
  invocation: string,
) {
  const needsSpace =
    range.end >= text.length || !/\s/.test(text[range.end] ?? "");
  const inserted = `${invocation}${needsSpace ? " " : ""}`;
  return {
    text: text.slice(0, range.start) + inserted + text.slice(range.end),
    caret: range.start + inserted.length,
  };
}

export function insertPrefix(
  text: string,
  start: number,
  end: number,
  prefix: string,
) {
  // A selection collapses to its start rather than being replaced. This is a
  // button, not a keystroke: typing over a selection is expected, but tapping
  // an icon must never delete the draft, and there is no undo behind it.
  void end;
  const ws = (at: number) => /\s/.test(text[at] ?? "");
  // Anchor at the token start only when the caret sits *inside* a word, so a
  // prefix cannot attach to the middle of one. A caret at the end of a word
  // is the ordinary "I finished typing, now add a command" case and stays put
  // — walking back there moved the prefix in front of the user's last word.
  const inside = start > 0 && !ws(start - 1) && start < text.length && !ws(start);
  let anchor = start;
  if (inside) {
    let i = start - 1;
    while (i >= 0 && !ws(i)) i -= 1;
    anchor = i + 1;
  }
  // The prefix has to lead a whitespace-delimited token for detectToken to see
  // it, and must not swallow the character that follows.
  const lead = anchor > 0 && !ws(anchor - 1) ? " " : "";
  const trail = anchor < text.length && !ws(anchor) ? " " : "";
  const inserted = `${lead}${prefix}${trail}`;
  return {
    text: text.slice(0, anchor) + inserted + text.slice(anchor),
    // The caret stays in the active prefix (before any trailing space) so the
    // prefix alone opens the suggestions list.
    caret: anchor + lead.length + prefix.length,
  };
}

/**
 * The composer's view of an agent's commands: the harness built-ins and the
 * skills the bridge found, which can use different prefixes (codex runs
 * built-ins as /model and skills as $name). `prefixes` is longest first, so
 * /skill: is tried before /.
 */
export type DisplayCatalog = {
  prefixes: string[];
  commands: CommandSuggestion[];
  coverage: CommandCoverage;
};

/**
 * The identity of one scoped discovery request, derived from the bridge
 * snapshot the user is looking at. `project` is the equality token over the
 * existing project metadata: it is compared, never sent as a scan selector.
 */
export type CommandScope = {
  target: string;
  sessionId: string;
  project: string;
};

/** A scoped catalog the bridge answered for one exact scope. */
export type RemoteCatalog = {
  scope: CommandScope;
  revision: string;
  truncated: boolean;
  warnings: string[];
  catalog: DisplayCatalog;
};

/**
 * The scope a pane can be discovered under, or null when the snapshot has no
 * usable native identity or cwd: discovery is then unavailable, never
 * downgraded to a kind-only read.
 */
export function commandScope(agent: {
  id: string;
  sessionId?: string;
  cwd: string;
  projectRoot?: string;
}): CommandScope | null {
  if (!agent.sessionId || !agent.cwd) return null;
  return {
    target: agent.id,
    sessionId: agent.sessionId,
    project: JSON.stringify([agent.projectRoot ?? null, agent.cwd]),
  };
}

/**
 * How a harness settles a skill and a built-in with one name. Claude and
 * codex are listed skill-first (the skill's text is what the user wrote).
 * Grok keeps the built-in and moves the skill to a scoped name such as
 * /user:commit (grok-build docs, slash commands); pi's built-ins shadow a
 * template outright.
 */
export type CollisionPolicy =
  | { builtinsWin: false }
  | { builtinsWin: true; skillPrefix?: string };

export function mergeCatalog(
  builtins: CommandSuggestion[],
  remote: DisplayCatalog | undefined,
  policy: CollisionPolicy = { builtinsWin: false },
): DisplayCatalog | undefined {
  const commands: CommandSuggestion[] = [];
  const seen = new Set<string>();
  const extra: string[] = [];
  const add = (command: CommandSuggestion) => {
    if (seen.has(command.invocation)) return false;
    seen.add(command.invocation);
    commands.push(command);
    return true;
  };
  if (policy.builtinsWin) {
    builtins.forEach(add);
    for (const command of remote?.commands ?? []) {
      if (add(command) || !policy.skillPrefix) continue;
      // Collided with a built-in: still reachable under its scoped name.
      add({ ...command, invocation: `${policy.skillPrefix}${command.name}` });
      extra.push(policy.skillPrefix);
    }
  } else {
    [...(remote?.commands ?? []), ...builtins].forEach(add);
  }
  const prefixes = [...new Set([
    ...(remote?.prefixes ?? []),
    ...(builtins.length ? ["/"] : []),
    ...extra,
  ])].sort((a, b) => b.length - a.length);
  if (!prefixes.length) return undefined;
  // A hand-kept built-in list is never the whole catalog.
  const coverage: CommandCoverage = builtins.length
    ? "partial"
    : remote?.coverage ?? "unsupported";
  commands.sort((a, b) => a.invocation.localeCompare(b.invocation));
  return { prefixes, commands, coverage };
}

/** The command token at the caret, under whichever advertised prefix it uses. */
export function detectCommandToken(
  text: string,
  caret: number,
  prefixes: string[],
): (TokenRange & { prefix: string }) | null {
  for (const prefix of prefixes) {
    const range = detectToken(text, caret, prefix);
    if (range) return { ...range, prefix };
  }
  return null;
}

/**
 * Commands a token could mean: those invoked with its prefix whose name, or
 * invocation past the prefix, contains what was typed. Matching the
 * invocation lets "/sk" find pi's /skill: entries.
 */
export function matchCommands(
  commands: CommandSuggestion[],
  prefix: string,
  query: string,
) {
  const q = query.toLowerCase();
  return commands.filter(
    (command) =>
      command.invocation.startsWith(prefix) &&
      (command.name.toLowerCase().includes(q) ||
        command.invocation.slice(prefix.length).toLowerCase().includes(q)),
  );
}

export function filterCommands(
  commands: CommandSuggestion[],
  query: string,
) {
  const q = query.toLowerCase();
  return commands.filter((command) => command.name.toLowerCase().includes(q));
}

const KNOWN_PREFIXES = ["/", "$", "/skill:"] as const;
const SCOPE_LIMIT = 4096;
const REVISION_LIMIT = 128;
const NAME_LIMIT = 80;
const INVOCATION_LIMIT = 100;
const DESCRIPTION_LIMIT = 300;
const ORIGIN_LIMIT = 32;
const WARNING_LIMIT = 16;
const COMMAND_LIMIT = 200;
const isBoundedString = (value: unknown, limit: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= limit;

export function parseScopedCommandsResponse(value: unknown, expected: CommandScope): RemoteCatalog {
  if (!value || typeof value !== "object") throw new Error("invalid commands");
  const body = value as Record<string, unknown>;
  const scope = body.scope;
  if (!scope || typeof scope !== "object") throw new Error("invalid commands");
  const s = scope as Record<string, unknown>;
  if (s.target !== expected.target || s.sessionId !== expected.sessionId || s.project !== expected.project)
    throw new Error("invalid commands");
  if (!isBoundedString(s.target, SCOPE_LIMIT) || !isBoundedString(s.sessionId, SCOPE_LIMIT) || !isBoundedString(s.project, SCOPE_LIMIT))
    throw new Error("invalid commands");
  if (!isBoundedString(body.revision, REVISION_LIMIT)) throw new Error("invalid commands");
  if (body.coverage !== "full" && body.coverage !== "partial" && body.coverage !== "unsupported")
    throw new Error("invalid commands");
  if (typeof body.truncated !== "boolean") throw new Error("invalid commands");
  if (!Array.isArray(body.prefixes)) throw new Error("invalid commands");
  // The unsupported variant is the unavailable state: no prefixes, no
  // commands. Supported catalogs must advertise at least one prefix.
  const unsupported = body.coverage === "unsupported";
  if (unsupported ? body.prefixes.length !== 0 : body.prefixes.length === 0)
    throw new Error("invalid commands");
  const prefixes = [...new Set(body.prefixes as string[])];
  if (prefixes.some((p) => !(KNOWN_PREFIXES as readonly unknown[]).includes(p)))
    throw new Error("invalid commands");
  if (!Array.isArray(body.commands) || body.commands.length > COMMAND_LIMIT)
    throw new Error("invalid commands");
  if (unsupported && body.commands.length !== 0) throw new Error("invalid commands");
  const warnings = Array.isArray(body.warnings)
    ? (body.warnings as unknown[]).filter((w): w is string => typeof w === "string" && w.length <= 64).slice(0, WARNING_LIMIT)
    : [];
  const commands: CommandSuggestion[] = [];
  for (const entry of body.commands) {
    if (!entry || typeof entry !== "object") throw new Error("invalid commands");
    const command = entry as Record<string, unknown>;
    const name = command.name;
    const invocation = command.invocation;
    const description = command.description;
    const origin = command.origin;
    if (!isBoundedString(name, NAME_LIMIT) || !isBoundedString(invocation, INVOCATION_LIMIT))
      throw new Error("invalid commands");
    if (/\s/.test(name) || /\s/.test(invocation)) throw new Error("invalid commands");
    if (typeof description !== "string" || description.length > DESCRIPTION_LIMIT)
      throw new Error("invalid commands");
    if (!isBoundedString(origin, ORIGIN_LIMIT)) throw new Error("invalid commands");
    if (!prefixes.some((p) => invocation.startsWith(p))) throw new Error("invalid commands");
    commands.push({ name, invocation, description, origin });
  }
  return {
    scope: { target: expected.target, sessionId: expected.sessionId, project: expected.project },
    revision: body.revision as string,
    truncated: body.truncated,
    warnings,
    catalog: {
      prefixes: prefixes.sort((a, b) => b.length - a.length),
      commands,
      coverage: body.coverage as CommandCoverage,
    },
  };
}
