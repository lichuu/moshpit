import type { CollisionPolicy, CommandSuggestion } from "./commands";

// Built-in slash commands per harness, as documented for recent releases.
// These are not read from the host: a harness adds and renames commands
// between versions, and the bridge has no registry to ask. So the list is a
// starting point, never the whole truth, and every catalog that includes it
// reports itself as partial. Typing a command that is not listed still works.
//
// Kinds are herdr's pane names; the demo says "claude-code" for "claude".
// Grok and pi are taken from their own docs (grok-build user guide, slash
// commands; pi docs/slash-commands.md), primary names only.
type Builtin = [name: string, description: string];

const CLAUDE: Builtin[] = [
  ["add-dir", "Add a working directory"],
  ["agents", "Manage subagents"],
  ["clear", "Clear the conversation"],
  ["compact", "Summarize the conversation to free context"],
  ["config", "Open settings"],
  ["context", "Show context usage"],
  ["cost", "Show token usage and cost"],
  ["doctor", "Check the installation"],
  ["export", "Export the conversation"],
  ["help", "List commands"],
  ["hooks", "Manage hooks"],
  ["init", "Write a CLAUDE.md for this project"],
  ["mcp", "Manage MCP servers"],
  ["memory", "Edit memory files"],
  ["model", "Choose the model"],
  ["permissions", "View or change permissions"],
  ["resume", "Resume an earlier conversation"],
  ["review", "Review a pull request"],
  ["rewind", "Rewind the conversation or code"],
  ["status", "Show version, model and account"],
  ["usage", "Show plan usage limits"],
];

const CODEX: Builtin[] = [
  ["approvals", "Choose what runs without asking"],
  ["compact", "Summarize the conversation to free context"],
  ["diff", "Show the git diff"],
  ["init", "Write an AGENTS.md for this project"],
  ["mcp", "List MCP tools"],
  ["mention", "Mention a file"],
  ["model", "Choose the model and reasoning effort"],
  ["new", "Start a new chat"],
  ["quit", "Exit Codex"],
  ["review", "Review the current changes"],
  ["status", "Show session settings and token usage"],
];

const OPENCODE: Builtin[] = [
  ["compact", "Summarize the session"],
  ["details", "Toggle tool details"],
  ["editor", "Compose in an external editor"],
  ["exit", "Exit opencode"],
  ["export", "Export the conversation"],
  ["help", "Show help"],
  ["init", "Write an AGENTS.md for this project"],
  ["models", "List models"],
  ["new", "Start a new session"],
  ["redo", "Redo an undone message"],
  ["sessions", "List sessions"],
  ["share", "Share the session"],
  ["themes", "List themes"],
  ["undo", "Undo the last message"],
];

// Grok Build. Aliases (/clear for /new, /exit for /quit) are left out: the
// menu searches descriptions too, and one row per command stays scannable.
const GROK: Builtin[] = [
  ["always-approve", "Skip permission prompts"],
  ["auto", "Let a classifier approve safe tools"],
  ["compact", "Compress history to free context"],
  ["context", "Show context window usage"],
  ["copy", "Copy the last response"],
  ["deep-research", "Start a background research workflow"],
  ["doctor", "Check for terminal and system issues"],
  ["effort", "Set reasoning effort"],
  ["export", "Export the conversation"],
  ["fork", "Branch the session into a new agent"],
  ["goal", "Set or check an autonomous goal"],
  ["hooks", "Manage hooks"],
  ["login", "Log in or re-authenticate"],
  ["loop", "Run a prompt on an interval"],
  ["mcps", "Manage MCP servers"],
  ["memory", "Browse saved memories"],
  ["model", "Switch models"],
  ["new", "Start a fresh session (/clear)"],
  ["plan", "Enter plan mode"],
  ["plugins", "Manage plugins"],
  ["quit", "Quit (/exit)"],
  ["remember", "Save a note to memory"],
  ["rename", "Rename the session"],
  ["resume", "Reload a previous session"],
  ["rewind", "Roll back to an earlier turn (/undo)"],
  ["session-info", "Show session details (/status)"],
  ["settings", "Open settings (/config)"],
  ["skills", "Manage skills"],
  ["usage", "View credit usage (/cost)"],
];

// Pi ships few commands on purpose: most arrive from extensions, prompt
// templates and skills, which the bridge lists where it can read them.
const PI: Builtin[] = [
  ["changelog", "Show changelog entries"],
  ["clone", "Duplicate the session here"],
  ["compact", "Compact the context"],
  ["copy", "Copy the last assistant message"],
  ["export", "Export the session as HTML or JSONL"],
  ["fork", "New session from an earlier message"],
  ["hotkeys", "Show keyboard shortcuts"],
  ["login", "Add provider authentication"],
  ["model", "Select a model"],
  ["name", "Set the session name"],
  ["new", "Start a new session"],
  ["quit", "Quit pi"],
  ["reload", "Reload extensions, skills and templates"],
  ["resume", "Switch to another saved session"],
  ["scoped-models", "Models used by cycling"],
  ["session", "Show session information"],
  ["settings", "Open settings"],
  ["share", "Upload the session and get a link"],
  ["thinking", "Set the thinking level"],
  ["tree", "Navigate the session tree"],
];

const BY_KIND: Record<string, Builtin[]> = {
  grok: GROK,
  pi: PI,
  claude: CLAUDE,
  "claude-code": CLAUDE,
  codex: CODEX,
  opencode: OPENCODE,
};

export function builtinCommands(kind: string | undefined): CommandSuggestion[] {
  const list = kind && Object.hasOwn(BY_KIND, kind) ? BY_KIND[kind] : [];
  return list.map(([name, description]) => ({
    name,
    invocation: `/${name}`,
    description,
    origin: "built-in",
  }));
}

/** How each harness settles a skill and a built-in that share a name. */
export function collisionPolicy(kind: string | undefined): CollisionPolicy {
  if (kind === "grok") return { builtinsWin: true, skillPrefix: "/user:" };
  if (kind === "pi") return { builtinsWin: true };
  return { builtinsWin: false };
}
