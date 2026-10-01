# Command and skill suggestions

Inline composer suggestions backed by the agent's real skill catalog.

- Suggestions work in Chat and in the Terminal input. In Terminal the prefix
  button sits in the key bar (beside Quick replies and `Aa`); in Chat it is in
  the composer panel. The Terminal input only inserts: Send delivers the text
  and Enter to the pane as before.
- Built-in commands ship with the client (`src/lib/moshpit/builtin-commands.ts`)
  for claude/claude-code, codex, opencode, grok, and pi, invoked with `/` and
  tagged "built-in" in the list. They need no bridge, so the demo host has
  them too. They are hand-kept from each harness's docs, so any catalog that
  includes them reports `partial`.
- Collisions follow each harness: claude and codex list the skill; grok keeps
  the built-in and lists the skill as `/user:<name>`; pi's built-in shadows a
  same-named template.
- Grok skills are listed only when their frontmatter sets
  `user-invocable: true`.
- Pi is pluggable. The bridge lists its prompt templates
  (`~/.pi/agent/prompts/*.md`, direct children, as `/<file>`) and skills
  (`/skill:<name>`) from disk, which is usable at once. For a pi pane the
  composer then asks `GET /api/commands?agent=pi&target=<pane>`: the bridge
  resolves the pane's directory from herdr's snapshot (never from the
  client), runs `pi --mode rpc --no-session --offline` there, sends one
  `get_commands`, and stops it (`bridge/pi-commands.mjs`, `MOSHPIT_PI_BIN`
  overrides the binary). That list includes extension commands and project
  resources under pi's own trust rules. It is cached per directory for five
  minutes, one run at a time, with a ten-second timeout; on any failure the
  disk list stays.
- A catalog can carry more than one prefix: codex lists `/` built-ins beside
  its `$` skills. A skill with the same invocation as a built-in replaces it.
  Every match is listed (the list scrolls); there is no eight-row cap.
- The bridge exposes `GET /api/commands?agent=<kind>` (trusted-gated like every
  other `/api/*` route). The client sends the agent kind only; the bridge
  resolves it to a fixed skill directory (claude `~/.claude/skills`,
  claude-code `~/.claude/skills`, pi `~/.pi/agent/skills`, codex
  `~/.codex/skills`, grok `~/.grok/skills`, opencode `~/.opencode/skills`)
  and returns `{ kind, prefix, commands, coverage }` where each command
  carries its full invocation: claude `/<name>`, codex `$<name>`,
  pi `/skill:<name>` (pi's real skill command syntax; the skill name comes
  from the SKILL.md frontmatter, falling back to the directory name, and a
  SKILL.md without a description is not a loadable pi skill so it is not
  listed). `coverage` is `full`, `partial`, or `unsupported`. Grok and
  OpenCode are `partial`. Unknown kinds are `unsupported` with an empty
  prefix. Manual typing stays usable.
- Typing the agent's own prefix at a token boundary opens the list above
  the composer; a partial name filters it. Arrow keys move the selection.
  Tab or Enter inserts without sending. Escape dismisses. A later Enter
  submits. A token in another agent's syntax (a `/` or `$` token on a
  `/skill:` catalog, and vice versa) never triggers. A slash inside a URL
  or path never triggers. IME composition suppresses matching. Dismissal
  stays dismissed until the token changes.
- Tapping a result replaces the whole active token (including text typed
  past the caret) with the command's invocation plus a trailing space
  through `saved.update`; it never sends. The tappable prefix button
  inserts the agent's prefix at the token start with the caret left in
  the active prefix, so the list opens immediately.
- Switching host or agent kind clears the previous catalog immediately,
  aborts its in-flight read, and guards the response with a generation
  counter, so a stale catalog never appears on the new agent; the cache
  is keyed by (origin, kind).

The catalog is a host-side inventory of skill directories: it reflects
what is on disk, not the agent's per-session settings (e.g. pi's
`enableSkillCommands` toggle, project-level skill settings, or name
collisions can change what a running agent actually registers).

Verify with `helpers/check-commands.mjs` (pure helpers, in `npm test`) and
`helpers/check-commands-ui.mjs` (phone viewport, isolated bridge, real
catalogs, zero sends).
