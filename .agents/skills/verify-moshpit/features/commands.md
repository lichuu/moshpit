# Command and skill suggestions

Inline composer suggestions backed by a host-side inventory of the agent's
skill directories (fixed home/XDG sources), bound to the pane, its exact
native session, and its project. Implemented in this slice.

## Sub-features

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
- Discovery is scoped: the composer sends `GET /api/commands?target=<pane>&sessionId=<native-id>`
  (only those two parameters; the project equality token stays client-side).
  The bridge resolves the pane and its exact native session from a fresh
  herdr snapshot before scanning and re-checks pane, session, kind, cwd and
  worktree root from another fresh snapshot after; drift returns
  `409 command_scope_changed`, an unknown pane `404`. One shared two-second
  deadline covers both snapshots, the targeted fresh project lookup and the
  scan; a stop publishes nothing. A pane without a usable native session or
  cwd gets no scoped read at all (discovery unavailable), never a kind-only
  fallback.
- The bridge lists fixed home/XDG sources only (claude `~/.claude/skills`,
  claude-code `~/.claude/skills`, pi `~/.pi/agent/skills` plus
  `~/.pi/agent/prompts` templates, codex `~/.codex/skills`, grok
  `~/.grok/skills`; OpenCode reads commands and skills from its XDG config
  directory, plus `~/.claude/skills` and `~/.agents/skills`). Every supported
  catalog is `partial`: project resources, extensions and per-session
  settings are not on those directories. Scanning is bounded jointly (200
  results, 1,000 examined entries, depth 8, 256 KiB per metadata file) and
  reports truncation and categorical warnings without paths. The catalog
  carries scope, a revision over inspected source identity/stat metadata,
  coverage, truncation, prefixes and entries with bounded origin labels.
- An unsupported kind answers with empty prefixes and commands; the client
  shows the unavailable state (no Retry) and manual typing stays usable.
- Discovery never starts an agent. The old spawned-Pi RPC list is gone; a pi
  pane gets the partial disk catalog and no `pi` process is spawned.
- The kind-only route `GET /api/commands?agent=<kind>` remains for
  pre-scoped clients in its old shape, explicitly `partial`; a scoped client
  never accepts a legacy response as scoped.
- A catalog can carry more than one prefix: codex lists `/` built-ins beside
  its `$` skills. A skill with the same invocation as a built-in replaces it.
  Every match is listed (the list scrolls); there is no eight-row cap.
- Discovery state is keyed by host, pane, native session, kind, project and
  refresh generation. A state from another identity is hidden the moment the
  key changes (failures included), replaced requests are aborted, and late
  responses are ignored.
- Only a project/cwd change preserves the editor instance; a host, native
  session, or view change remounts it, and the saved draft persists through
  the remount.
- Status is shown independently of the match list: loading, unavailable,
  empty/no-match, partial/truncated, and failed with a Retry that rescans
  without touching the draft. Manual typing stays usable in every state.
- Typing the agent's own prefix at a token boundary opens the list above
  the composer; a partial name filters it. Arrow keys move the selection.
  Tab or Enter inserts without sending. Escape dismisses. A later Enter
  submits. Only advertised prefixes trigger suggestions. Pi accepts `/`
  for built-ins, templates, and extension commands, plus `/skill:` for
  skills. A slash inside a URL
  or path never triggers. IME composition suppresses matching. Dismissal
  stays dismissed until the token changes.
- Tapping a result replaces the whole active token (including text typed
  past the caret) with the command's invocation plus a trailing space
  through `saved.update`; it never sends. A tap is bound to the discovery
  key, draft revision, and token range it began under at pointerdown; a
  completion after a scope or draft drift is rejected rather than written.
  The tappable prefix button
  inserts the agent's prefix at the token start with the caret left in
  the active prefix, so the list opens immediately.

## How to get to it (user POV)

- Open an agent in Chat or Terminal.
- Type the agent's prefix (`/`, `$`, or `/skill:`) at a token boundary, or
  tap the prefix button in the composer.
- Filter by typing a partial name; arrow or scroll to a result.
- Press Tab/Enter, or tap a result, to insert it into the draft.
- Press Enter again to send, or keep typing.

## Driving it with drive.mjs

This feature uses dedicated checks:

- `node helpers/check-commands.mjs` — pure client helpers (token detection,
  insertion, prefix-tap caret, scoped response validation) plus a
  scanner-to-parser round trip for the unsupported variant. Runs in Node
  against source.
- `helpers/check-commands-ui.mjs` — phone viewport against an isolated
  loopback bridge on probed free ports (strict bind ownership: the bridge
  and vite refuse a taken port), in front of the real read-only herdr
  snapshot. It connects a real host and checks the composer suggestions end
  to end: the agent's own prefix opens the real skill catalog (claude
  `~/.claude/skills` as `/<name>`, pi `~/.pi/agent/skills` as
  `/skill:<name>`), a token in another agent's prefix never triggers,
  partial-name filtering, tap-to-insert (replaces the token, adds a trailing
  space, never sends — it counts every `/api/submit` and `/api/action`
  request and asserts zero), dismissal until the token changes, URL/path
  non-triggering, and agent switching (a claude-exclusive skill never
  appears on a pi agent). It refuses an ambiguous agent-card match instead
  of guessing. It writes no input to any pane.
- `MOSHPIT_TEST_PORT=4197 MOSHPIT_DEV_PORT=5197 npx playwright test tests/bridge/commands.spec.ts --project=phone --project=desktop --output=/tmp/moshpit-commands-results --reporter=list`
  checks the scoped route (exact scope binding, parameter refusals, 404/409,
  legacy shape, no-Pi-spawn, 504 deadline), the composer's stale-response
  and Retry behavior, a held tap across a scope change, keyboard and touch
  insertion of the ninth result with zero sends, and the unsupported-kind
  unavailable state.

## Gotchas

- The catalog is a host-side inventory of skill directories: it reflects
  what is on disk, not the agent's per-session settings (e.g. pi's
  `enableSkillCommands` toggle, project-level skill settings, or name
  collisions can change what a running agent actually registers). Per-harness
  project/config sources and full installed-catalog comparison remain open
  S8 work; this surface is bounded partial discovery.
- The demo host has no bridge, so it shows built-ins only; discovery is
  unavailable there, which is not a failure state.
- Phones use Back to return to the agent list; wide layouts keep the list
  beside the detail, so agent switching selects directly.
- Clipboard and touch checks dispatch browser events; a physical phone and
  assistive-technology runs of the input/listbox pattern remain device
  checks.
