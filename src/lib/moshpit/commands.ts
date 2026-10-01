export type CommandSuggestion = {
  name: string;
  invocation: string;
  description: string;
  /** "built-in" for the harness's own commands; unset for skills read from the host. */
  origin?: "built-in";
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
export type CommandCatalog = {
  prefixes: string[];
  commands: CommandSuggestion[];
  coverage: CommandCoverage;
};

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
  remote: { prefix: string; prefixes?: string[]; commands: CommandSuggestion[]; coverage: CommandCoverage } | undefined,
  policy: CollisionPolicy = { builtinsWin: false },
): CommandCatalog | undefined {
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
    ...(remote?.prefixes ?? (remote?.prefix ? [remote.prefix] : [])),
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

// Client-boundary validation for GET /api/commands.
const KNOWN_PREFIXES = ["/", "$", "/skill:"] as const;

export function parseCommandsResponse(value: unknown): {
  kind: string;
  prefix: "" | "/" | "$" | "/skill:";
  prefixes: string[];
  commands: CommandSuggestion[];
  coverage: CommandCoverage;
} {
  if (!value || typeof value !== "object") throw new Error("invalid commands");
  const body = value as Record<string, unknown>;
  const prefix = body.prefix;
  if (prefix !== "" && prefix !== "/" && prefix !== "$" && prefix !== "/skill:")
    throw new Error("invalid commands");
  if (!Array.isArray(body.commands)) throw new Error("invalid commands");
  // A catalog may invoke sources with different prefixes (pi: /skill: skills
  // beside / templates). An older bridge sends only `prefix`.
  let prefixes: string[] = prefix ? [prefix] : [];
  if (body.prefixes !== undefined) {
    if (!Array.isArray(body.prefixes) || body.prefixes.some((p) => !(KNOWN_PREFIXES as readonly unknown[]).includes(p)))
      throw new Error("invalid commands");
    prefixes = [...new Set([...prefixes, ...(body.prefixes as string[])])];
  }
  const coverage =
    body.coverage === "full" || body.coverage === "partial" || body.coverage === "unsupported"
      ? body.coverage
      : prefix === ""
        ? "unsupported"
        : "full";
  const commands: CommandSuggestion[] = [];
  for (const entry of body.commands.slice(0, 200)) {
    if (!entry || typeof entry !== "object") continue;
    const command = entry as Record<string, unknown>;
    const name = typeof command.name === "string" ? command.name.slice(0, 80) : "";
    if (!name) continue;
    const invocation =
      typeof command.invocation === "string" ? command.invocation.slice(0, 100) : "";
    // A catalog whose invocations do not carry its own prefix would suggest
    // tokens that agent cannot run; reject the response instead.
    if (!invocation || (prefix !== "" && !prefixes.some((p) => invocation.startsWith(p))))
      throw new Error("invalid commands");
    const description =
      typeof command.description === "string"
        ? command.description.slice(0, 300)
        : "";
    commands.push({ name, invocation, description });
  }
  return {
    kind: typeof body.kind === "string" ? body.kind : "",
    prefix: prefix,
    prefixes,
    commands,
    coverage: commands.length === 200 && coverage === "full" ? "partial" : coverage,
  };
}
