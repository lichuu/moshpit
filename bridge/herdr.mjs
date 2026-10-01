import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { open as openFile, stat as statFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { extractPrompt, inspectAnswerDialog } from "./prompt.mjs";
import { createAnswerObservations } from "./answer-observation.mjs";
import { parseConversation } from "./conversation.mjs";
import { createProjectResolver } from "./projects.mjs";
import { nativeCapabilities, submitNative } from "./native-input.mjs";

export const HERDR_KINDS = [
  "pi",
  "claude",
  "codex",
  "gemini",
  "cursor",
  "devin",
  "agy",
  "cline",
  "omp",
  "mastracode",
  "opencode",
  "copilot",
  "kimi",
  "kiro",
  "droid",
  "amp",
  "grok",
  "hermes",
  "kilo",
  "qodercli",
  "qwen",
  "maki",
];
const KIND_SET = new Set(HERDR_KINDS);

export function isHerdrKind(name) {
  return KIND_SET.has(name);
}

// pi writes the model into every assistant entry; the newest one is the
// current model. Scan the file tail backwards so a long session stays cheap.
// ponytail: 256KB tail; a model set long ago with many turns since is missed.
// The (size, mtime) cache makes a 2s poll one stat per agent; the tail is
// re-read only when pi actually appends.
export async function latestModel(file, cache) {
  if (!file || !file.endsWith(".jsonl")) return null;
  let stat;
  try {
    stat = await statFile(file);
  } catch {
    /* session not written until the first prompt */
    return null;
  }
  const key = `${stat.size}:${stat.mtimeMs}`;
  const hit = cache?.get(file);
  if (hit && hit.key === key) return hit.model;
  let model = null;
  try {
    const fd = await openFile(file, "r");
    try {
      const size = Math.min(stat.size, 262144);
      const buf = Buffer.alloc(size);
      await fd.read(buf, 0, size, stat.size - size);
      const lines = buf.toString("utf8").split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const s = lines[i].trim();
        if (!s) continue;
        try {
          const entry = JSON.parse(s);
          // pi writes the model on the assistant message, nested under message.
          const candidate = entry.model ?? entry.message?.model;
          if (typeof candidate === "string" && candidate) {
            model = candidate;
            break;
          }
        } catch {
          /* cut-off first line or non-JSON row */
        }
      }
    } finally {
      await fd.close();
    }
  } catch {
    /* read raced the session file being truncated */
  }
  cache?.set(file, { key, model });
  return model;
}

function defaultAccess(file) {
  try {
    accessSync(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function pathKinds(pathEnv = process.env.PATH ?? "", accessFile = defaultAccess) {
  const dirs = String(pathEnv).split(path.delimiter).filter(Boolean);
  const found = [];
  for (const kind of HERDR_KINDS) {
    if (dirs.some((dir) => accessFile(path.join(dir, kind)))) found.push(kind);
  }
  return found;
}

function agentName(kind) {
  return `${kind}-${randomBytes(3).toString("hex")}`;
}

const now = () => Date.now();

// Every refusal on the answer path says the same thing: which guard tripped is
// the bridge's business, and the phone's move is the same either way.
const GONE = "That question is no longer on screen.";

function line(text, tone = "plain") {
  return { text, tone };
}

function demoQuestions() {
  return [
    {
      text: "Which deployment experience should we design first?",
      options: [
        { label: "Own machine (Recommended)", description: "Run it on your laptop" },
        { label: "Remote server" },
        { label: "Both equally" },
      ],
    },
    {
      text: "How should the machines talk to each other?",
      options: [
        { label: "Require Tailscale (Recommended)" },
        { label: "Public ports" },
      ],
    },
    {
      text: "What is the first step after choosing?",
      options: [
        { label: "One command, then browser (Recommended)" },
        { label: "Full setup docs" },
      ],
    },
  ];
}

function demoDialog(agentId, questions, index) {
  const question = questions[index];
  if (!question) return undefined;
  return {
    kind: "choose",
    family: "codex-request-user-input-v1",
    sessionId: `demo:${agentId}`,
    expected: {
      token: `demo-${agentId}-token-${index}`,
      signature: `demo-${agentId}-signature-${index}`,
      revision: null,
    },
    question: question.text,
    step: { index, total: questions.length },
    options: question.options.map((option, optionIndex) => ({
      key: String(optionIndex + 1),
      label: option.label,
      description: option.description,
    })),
  };
}

function seedAgents() {
  const t = now();
  const wizard = demoQuestions();
  return [
    {
      id: "migrate",
      name: "migrate",
      kind: "codex",
      status: "blocked",
      workspace: "web",
      tab: "db",
      paneId: "w1:p2",
      cwd: "~/src/web",
      branch: "main",
      lastOutput: "Should I run prisma migrate? y/n",
      attention: true,
      statusChangedAt: t,
      workTicks: 0,
      ticks: 0,
      nextStatus: null,
      blockedPrompt: "Should I run prisma migrate? y/n",
      lines: [
        line("codex  ·  web / db", "dim"),
        line(""),
        line("Should I run prisma migrate? y/n", "warn"),
      ],
    },
    {
      id: "accent",
      name: "postcard-ui",
      kind: "opencode",
      status: "blocked",
      workspace: "side-quest",
      tab: "ui",
      paneId: "w3:p1",
      cwd: "~/src/postcard",
      branch: "visuals",
      lastOutput: wizard[0].text,
      attention: true,
      statusChangedAt: t,
      workTicks: 0,
      ticks: 0,
      nextStatus: null,
      blockedPrompt: wizard[0].text,
      question: wizard,
      blockedDialog: demoDialog("accent", wizard, 0),
      lines: [
        line("opencode  ·  side-quest / ui", "dim"),
        line("Drafting the mark and tokens."),
        line(wizard[0].text, "warn"),
      ],
    },
    {
      id: "auth",
      name: "auth-rewrite",
      kind: "claude-code",
      status: "working",
      workspace: "web",
      tab: "auth",
      paneId: "w1:p1",
      cwd: "~/src/web",
      branch: "session-refresh",
      lastOutput: "rewriting refresh tokens",
      attention: false,
      statusChangedAt: t,
      workTicks: 4,
      ticks: 0,
      nextStatus: "done",
      blockedPrompt: null,
      lines: [line("claude-code  ·  web / auth", "dim"), line("rewriting refresh tokens")],
    },
  ];
}

function append(agent, text, tone = "plain") {
  const lines = [...agent.lines, { text, tone }].slice(-120);
  return { ...agent, lines, lastOutput: text.trim() ? text : agent.lastOutput };
}

function setStatus(agent, status) {
  return {
    ...agent,
    status,
    statusChangedAt: now(),
    attention: status === "blocked",
    ticks: 0,
  };
}

// The key names the bridge knows how to send. A plain string is either one of
// these, exactly, or a single character; literal text of any length arrives
// marked as { text }. Before that split, an unknown name such as "home" was
// typed into the pane as a word, and an option labelled "Enter" was pressed.
const KEY_NAMES = new Set([
  "esc", "escape", "tab", "shift+tab", "enter", "alt+enter", "return", "space", "backspace", "up", "down", "left", "right",
  ...Array.from({ length: 26 }, (_, i) => `ctrl+${String.fromCharCode(97 + i)}`),
]);
export const MAX_TEXT_INPUT = 4096;

export class KeyInputError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
    this.code = "key_unsupported";
  }
}

/**
 * What one input element sends: { kind: "keys" } for a named key, or
 * { kind: "text" } for literal text. Anything else throws KeyInputError, so a
 * refused element dispatches nothing.
 */
export function herdrInput(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const keys = Object.keys(raw);
    if (keys.length !== 1 || keys[0] !== "text" || typeof raw.text !== "string" || !raw.text || raw.text.length > MAX_TEXT_INPUT)
      throw new KeyInputError(`Text input is { text } with 1 to ${MAX_TEXT_INPUT} characters.`);
    return { kind: "text", value: raw.text };
  }
  if (typeof raw !== "string" || !raw) throw new KeyInputError("A key is a non-empty string or { text }.");
  if (KEY_NAMES.has(raw)) return { kind: "keys", value: raw };
  if ([...raw].length !== 1) throw new KeyInputError(`${JSON.stringify(raw.slice(0, 32))} is not a key this bridge can send; send text as { text }.`);
  const c = raw.charCodeAt(0);
  if (c === 13 || c === 10) return { kind: "keys", value: "enter" };
  if (c === 9) return { kind: "keys", value: "tab" };
  if (c === 127 || c === 8) return { kind: "keys", value: "backspace" };
  if (c === 27) return { kind: "keys", value: "esc" };
  if (c >= 1 && c <= 26) return { kind: "keys", value: `ctrl+${String.fromCharCode(96 + c)}` };
  if (c < 32) throw new KeyInputError("That control character is not a key this bridge can send.");
  return { kind: "text", value: raw };
}

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out = [];
    const err = [];
    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => err.push(c));
    child.on("error", reject);
    child.on("close", (code) => {
      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = Buffer.concat(err).toString("utf8");
      if (code !== 0) {
        reject(new Error(stderr.trim() || `herdr exited ${code}`));
        return;
      }
      resolve(stdout);
    });
  });
}

// A live `terminal session control` child. One JSON line per input/resize;
// frames come back on stdout and are only parsed to catch terminal.closed,
// so a late writer or a dead child can never double-fire the close.
function spawnControl(bin, args) {
  const handle = { closed: false, line: "" };
  const child = spawn(bin, args, { stdio: ["pipe", "pipe", "ignore"] });
  handle.child = child;
  child.stdin.on("error", () => {}); // a kill can land mid-write
  let killTimer;
  const close = () => {
    if (handle.closed) return;
    handle.closed = true;
    // Release the exclusive session, then drop stdin. herdr may or may not
    // exit on either; the grace kill is the guaranteed cleanup.
    try {
      child.stdin.write('{"type":"terminal.release"}\n');
    } catch { /* already gone */ }
    try {
      child.stdin.destroy();
    } catch { /* already gone */ }
    killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }, 500);
    killTimer.unref?.();
    handle.onClosed?.();
  };
  const clearKill = () => clearTimeout(killTimer);
  child.stdout.on("data", (chunk) => {
    handle.line += chunk.toString("utf8");
    if (handle.line.length > 1048576) handle.line = handle.line.slice(-1024);
    for (;;) {
      const newline = handle.line.indexOf("\n");
      if (newline === -1) break;
      const line = handle.line.slice(0, newline);
      handle.line = handle.line.slice(newline + 1);
      if (!line.includes('"terminal.closed"')) continue;
      try {
        if (JSON.parse(line)?.type === "terminal.closed") return close();
      } catch { /* non-JSON lines are display-only */ }
    }
  });
  child.on("error", () => {
    clearKill();
    close();
  });
  child.on("exit", () => {
    clearKill();
    close();
  });
  handle.close = close;
  return handle;
}

function createDemoHerdr(onLine) {
  // The session-control key bytes, mapped back to the demo's key names.
  const DEMO_KEY_NAME = {
    "\r": "enter", "\n": "enter", "\u001b": "esc", "\t": "tab",
    "\u001b[Z": "shift+tab", "\u001b[A": "up", "\u001b[B": "down",
    "\u001b[C": "right", "\u001b[D": "left", "\u007f": "backspace", " ": "space",
  };
  let agents = seedAgents();
  let shells = [];
  // Monotonic: a length-derived id reused a live shell's id after a close.
  let shellSeq = 0;
  function emit(agent) {
    const last = agent.lines.at(-1);
    if (last) onLine?.(agent.id, last);
  }
  return {
    async dump(target) {
      const shell = shells.find((s) => s.id === target);
      if (shell) return (shell.lines ?? []).map((l) => l.text).join("\n") + "\n";
      const agent = agents.find((a) => a.id === target) ?? agents[0];
      return (agent?.lines ?? []).map((l) => l.text).join("\n") + "\n";
    },
    async geometry() {
      return { cols: 80, rows: 24 };
    },
    async snapshot() {
      return {
        hostId: "demo",
        at: now(),
        agents,
        panes: agents.map((a) => ({ id: a.paneId, agentId: a.id })),
        shells: shells.map((s) => ({ id: s.id, cwd: s.cwd, alive: true })),
        kinds: pathKinds(),
      };
    },
    async isShell(target) {
      return shells.some((s) => s.id === target);
    },
    async terminal(terminalId) {
      const agent = agents.find((a) => a.id === terminalId) ?? shells.find((a) => a.id === terminalId);
      return agent ? { paneId: agent.id, terminalId: agent.id } : null;
    },
    async detail(target) {
      const agent = agents.find((a) => a.id === target) ?? shells.find((a) => a.id === target);
      if (!agent) throw new Error("agent not found");
      const output = agent.lines.map((item) => item.text).join("\n");
      return { agentId: agent.id, terminal_id: agent.id, revision: agent.ticks, output,
        conversation: { kind: "available", messages: agent.lines.filter((item) => item.text).map((item) => ({ role: item.tone === "in" ? "user" : item.tone === "dim" ? "system" : "agent", text: item.text })) } };
    },
    // The demo has no real terminal: a session-control stub whose input goes
    // through the same prompt path, so demo mode keeps echoing /pty input.
    control({ target, onClosed }) {
      const handle = { closed: false, target: String(target) };
      handle.close = () => {
        if (handle.closed) return;
        handle.closed = true;
        onClosed?.();
      };
      return handle;
    },
    writeControl(handle, text) {
      if (handle.closed || !text) return;
      const s = String(text);
      // Keys go back through the demo's keys() path (the pre-cutover
      // behavior: [esc] rendered, not echoed as prompt text).
      const name = DEMO_KEY_NAME[s]
        ?? (s.length === 1 && s.charCodeAt(0) >= 1 && s.charCodeAt(0) <= 26
          ? `ctrl+${String.fromCharCode(s.charCodeAt(0) + 96)}`
          : undefined);
      if (name) { this.keys(handle.target, name); return; }
      this.prompt(handle.target, s);
    },
    resizeControl() {},
    closeControl(handle) {
      handle.close();
    },
    async prompt(target, text) {
      const trimmed = String(text ?? "").replace(/\s+$/, "");
      if (!trimmed) return;
      const shell = shells.find((s) => s.id === target);
      if (shell) {
        const next = {
          ...shell,
          lines: [...(shell.lines ?? []), line(`> ${trimmed}`, "in"), line("demo shell ran it", "dim")].slice(-120),
        };
        shells = shells.map((s) => (s.id === target ? next : s));
        emit({ id: target, lines: next.lines });
        return;
      }
      agents = agents.map((agent) => {
        if (agent.id !== target) return agent;
        let next = append(agent, "");
        emit(next);
        next = append(next, `> ${trimmed}`, "in");
        emit(next);
        if (agent.status === "blocked") return { ...next, pendingInput: trimmed };
        next = append(next, "queued on the running turn", "dim");
        emit(next);
        return { ...setStatus(next, "working"), workTicks: 2, nextStatus: "done" };
      });
    },
    async answer(target, token, optionKey) {
      const current = agents.find((agent) => agent.id === target);
      const dialog = current?.blockedDialog;
      if (dialog?.kind !== "choose" || dialog.expected.token !== token) throw new Error(GONE);
      const choice = dialog.options.find((option) => option.key === optionKey);
      if (!choice) throw new Error(GONE);
      const questions = current.question;
      const step = dialog.step.index;
      if (!questions?.[step]) throw new Error(GONE);
      const answered = questions.map((question, index) =>
        index === step ? { ...question, answer: choice.label } : question,
      );
      const nextQuestion = answered[step + 1];
      agents = agents.map((agent) => {
        if (agent.id !== target) return agent;
        let next = append(agent, String(optionKey), "in");
        emit(next);
        next = append(next, "thinking…", "dim");
        emit(next);
        if (nextQuestion) {
          next = append(next, nextQuestion.text, "warn");
          emit(next);
          return {
            ...setStatus(next, "blocked"),
            question: answered,
            blockedPrompt: nextQuestion.text,
            pendingInput: null,
            blockedDialog: demoDialog(agent.id, answered, step + 1),
            nextStatus: null,
          };
        }
        return {
          ...setStatus(next, "working"),
          question: answered,
          workTicks: 3,
          nextStatus: "done",
          blockedPrompt: null,
          blockedDialog: null,
        };
      });
    },
    async keys(target, raw) {
      // Validated like the real bridge; literal text is echoed, never pressed.
      const input = herdrInput(raw);
      const name = input.kind === "keys" ? input.value : null;
      const keys = input.value;
      const shell = shells.find((s) => s.id === target);
      if (shell) {
        const echo =
          name === "esc" ? [line("[esc]", "dim")]
          : name === "ctrl+c" ? [line("^C", "warn")]
          : name === "ctrl+l" ? []
          : [line(String(keys), "in")];
        const next = {
          ...shell,
          lines: name === "ctrl+l" ? (shell.lines ?? []).slice(-2) : [...(shell.lines ?? []), ...echo].slice(-120),
        };
        shells = shells.map((s) => (s.id === target ? next : s));
        return;
      }
      agents = agents.map((agent) => {
        if (agent.id !== target) return agent;
        if (name === "enter" && agent.status === "blocked") {
          const typed = agent.pendingInput ?? "";
          // Enter commits an insertion, so with nothing inserted into this
          // block it is just a keypress. Reading the text back off the pane
          // instead would answer with a prompt from an earlier turn.
          if (!typed) return agent;
          let next = append(agent, "enter", "dim");
          if (/^(y|yes)\b/i.test(typed)) {
            next = append(next, "running prisma migrate deploy", "ok");
            emit(next);
            return { ...setStatus(next, "working"), blockedPrompt: null, pendingInput: null, workTicks: 2, nextStatus: "done" };
          }
          if (/^(n|no)\b/i.test(typed)) {
            next = append(next, "skipping migrate", "dim");
            emit(next);
            return { ...setStatus(next, "idle"), blockedPrompt: null, pendingInput: null, nextStatus: null };
          }
          next = append(next, "noted — picking the work back up", "ok");
          emit(next);
          return { ...setStatus(next, "working"), blockedPrompt: null, pendingInput: null, workTicks: 2, nextStatus: "done" };
        }
        if (name === "esc" && agent.status === "blocked") {
          const next = append(agent, "[esc]", "dim");
          emit(next);
          return { ...setStatus(next, "idle"), blockedPrompt: null, pendingInput: null, nextStatus: null };
        }
        const next = name === "esc" ? append(agent, "[esc]", "dim") : append(agent, String(keys), "in");
        emit(next);
        return next;
      });
    },
    async rename(target, name, clear) {
      if (clear) return;
      agents = agents.map((agent) => agent.id === target && name ? { ...agent, name: String(name), title: String(name) } : agent);
    },
    async close(target) {
      const gone = shells.some((s) => s.id === target);
      if (gone) shells = shells.filter((s) => s.id !== target);
      agents = agents.filter((agent) => agent.id !== target);
    },
    async openShell({ cwd }) {
      const directory = String(cwd ?? "").replace(/\/+$/, "");
      const existing = shells.find((s) => s.cwd === directory);
      if (existing) return { paneId: existing.id };
      const id = `demo:shell${(shellSeq += 1).toString(36)}`;
      shells = [
        ...shells,
        {
          id,
          cwd: directory,
          alive: true,
          lines: [
            line(`shell in ${directory || "the demo project"}`, "dim"),
            line("type a command, or close it from its header"),
          ],
        },
      ];
      return { paneId: id };
    },
    async block(target) {
      agents = agents.map((agent) => {
        if (agent.id !== target) return agent;
        let next = setStatus(agent, "blocked");
        next = {
          ...next,
          blockedPrompt: "Should I run prisma migrate? y/n",
          pendingInput: null,
          nextStatus: null,
        };
        next = append(next, "Should I run prisma migrate? y/n", "warn");
        emit(next);
        return next;
      });
    },
    async startAgent({ cwd, agentKind }) {
      const name = agentName(agentKind);
      const paneId = `demo:p${agents.length + 1}`;
      const t = now();
      const directory = String(cwd ?? "");
      agents = [
        ...agents,
        {
          id: paneId,
          name,
          kind: agentKind,
          status: "working",
          workspace: "demo",
          tab: name,
          paneId,
          cwd: directory,
          projectRoot: directory,
          branch: "",
          lastOutput: `started ${agentKind}`,
          attention: false,
          statusChangedAt: t,
          workTicks: 2,
          ticks: 0,
          nextStatus: "idle",
          blockedPrompt: null,
          lines: [line(`${agentKind}  ·  ${directory}`, "dim"), line(`started ${agentKind}`)],
        },
      ];
      return { paneId };
    },
    async capabilities() {
      return { inputModes: ["send"], stop: false, fit: false };
    },
    async submit(target, text, mode) {
      if (mode === "stop") await this.keys(target, "esc");
      else {
        await this.prompt(target, text);
        if (mode === "terminal") await this.keys(target, "enter");
      }
      return { state: "delivered", message: "Message delivered to the demo terminal." };
    },
  };
}

export function agentKind(name) {
  return typeof name === "string" && name.trim() ? name.trim() : "unknown";
}
const STATUS = new Set(["idle", "working", "blocked", "done"]);

function mapAgent(a) {
  const title = a.terminal_title_stripped ?? a.terminal_title ?? "";
  const status = STATUS.has(a.agent_status) ? a.agent_status : "unknown";
  const session =
    a.agent_session && (a.agent_session.kind === "id" || a.agent_session.kind === "path")
      ? { kind: a.agent_session.kind, value: a.agent_session.value }
      : undefined;
  return {
    id: a.pane_id,
    name: a.agent,
    kind: agentKind(a.agent),
    status,
    workspace: a.workspace_id ?? "",
    tab: a.tab_id ?? "",
    paneId: a.pane_id,
    cwd: a.foreground_cwd || a.cwd || "",
    branch: "",
    title,
    lastOutput: title,
    lines: title ? [{ text: title, tone: "dim" }] : [],
    attention: status === "blocked",
    statusChangedAt: now(),
    workTicks: 0,
    ticks: 0,
    nextStatus: null,
    blockedPrompt: null,
    sessionId: session?.value,
    session,
    revision: Number(a.revision ?? 0),
  };
}

function createExecHerdr(bin) {
  let metadata = new Map();
  const modelCache = new Map();
  // One per bridge process: a consumed answer must not re-open its choose card.
  const observations = createAnswerObservations();
  // The region herdr's own blocked rules key on, which is where the dialog is.
  const readDetection = (paneId) =>
    run(bin, ["pane", "read", String(paneId), "--format", "ansi", "--source", "detection"]);
  // Companion shells: one per canonical cwd. The pane's label marks them so a
  // restarted bridge re-adopts its shells from the pane list instead of
  // creating duplicates of the same directory. It is set with pane rename:
  // tab create's --label lands on the tab, which pane list does not show.
  const SHELL_LABEL = "moshpit shell";
  const shells = new Map(); // canonical cwd -> { cwd, paneId }
  const openingShells = new Map(); // canonical cwd -> in-flight open promise
  let shellLive = new Set();
  const canonical = (dir) => String(dir ?? "").replace(/\/+$/, "");
  const shellHasPane = (paneId) => shellLive.has(paneId) && [...shells.values()].some((shell) => shell.paneId === paneId);
  async function reconcileShells() {
    const panes = JSON.parse(await run(bin, ["pane", "list"]))?.result?.panes ?? [];
    shellLive = new Set(panes.map((p) => p.pane_id));
    for (const pane of panes) {
      if (pane.label !== SHELL_LABEL) continue;
      const cwd = canonical(pane.cwd);
      if (cwd && !shells.has(cwd)) shells.set(cwd, { cwd, paneId: pane.pane_id });
    }
    // Dead entries stay visible so the phone can offer a recreate; cap them so
    // a herdr restart (new pane ids, no close notices) cannot grow them.
    if (shells.size > 20) {
      for (const [cwd, shell] of shells) {
        if (shells.size <= 20) break;
        if (!shellLive.has(shell.paneId)) shells.delete(cwd);
      }
    }
    return panes;
  }
  function openShell({ cwd }) {
    const directory = canonical(cwd);
    if (!openingShells.has(directory)) {
      openingShells.set(
        directory,
        (async () => {
          const panes = await reconcileShells();
          const existing = shells.get(directory);
          if (existing) {
            if (shellLive.has(existing.paneId)) return { paneId: existing.paneId };
            shells.delete(directory); // stale entry; recreate below
          }
          // Same active-workspace lookup startAgent uses: an unnamed tab
          // would land in the wrong workspace when the cwd lives elsewhere.
          const workspaceId =
            panes.find((p) => canonical(p.cwd) === directory)?.workspace_id;
          const created = JSON.parse(
            await run(bin, [
              "tab", "create", "--cwd", directory,
              ...(workspaceId ? ["--workspace", workspaceId] : []),
              "--label", SHELL_LABEL, "--no-focus",
            ]),
          );
          const paneId = created.result?.root_pane?.pane_id;
          if (typeof paneId !== "string" || !paneId)
            throw new Error("tab create returned no shell pane");
          // `--label` names the tab; pane list reports only the pane's own
          // label (herdr 0.8.2), so without this a restarted bridge could
          // not recognise its shell and opened a duplicate. A failed rename
          // costs only that re-adoption, not the shell.
          await run(bin, ["pane", "rename", paneId, SHELL_LABEL]).catch(() => {});
          shells.set(directory, { cwd: directory, paneId });
          return { paneId };
        })().finally(() => openingShells.delete(directory)),
      );
    }
    return openingShells.get(directory);
  }
  // dump() runs on the terminal poll (every PTY_POLL_MS, 100ms by default), so
  // resolving the pane per call doubled the subprocesses every open terminal
  // spawns. The terminal_id -> pane_id mapping is stable for the pane's life;
  // a short TTL keeps a closed-and-reopened pane from being pinned.
  const PANE_TTL_MS = 5000;
  const paneCache = new Map();
  async function terminalPane(target) {
    const hit = paneCache.get(target);
    if (hit && hit.at > Date.now() - PANE_TTL_MS) return hit.pane;
    const panes = JSON.parse(await run(bin, ["pane", "list"]))?.result?.panes ?? [];
    const pane = panes.find((pane) => pane.terminal_id === target || pane.pane_id === target || pane.label === target);
    paneCache.set(target, { pane, at: Date.now() });
    // The map is keyed by whatever callers ask for, so it has to be swept or a
    // long-lived bridge accumulates an entry per pane it has ever been asked about.
    if (paneCache.size > 256) {
      for (const [key, value] of paneCache) {
        if (value.at <= Date.now() - PANE_TTL_MS) paneCache.delete(key);
      }
    }
    return pane;
  }
  const resolveProject = createProjectResolver(async (cwd) => {
    const stdout = await run(bin, ["worktree", "list", "--cwd", cwd]);
    return JSON.parse(stdout).result;
  });
  return {
    async dump(target) {
      const pane = await terminalPane(target);
      return run(bin, [
        "pane",
        "read",
        String(pane?.pane_id ?? target),
        "--format",
        "ansi",
        "--source",
        "visible",
      ]);
    },
    /** The pane's own cell grid — the web terminal has to match it or every line wraps. */
    async geometry(target) {
      target = (await terminalPane(target))?.pane_id ?? target;
      const stdout = await run(bin, ["pane", "layout", "--pane", String(target)]);
      const layout = JSON.parse(stdout).result?.layout;
      const rect =
        layout?.panes?.find((p) => p.pane_id === target)?.rect ?? layout?.area;
      if (!rect?.width || !rect?.height) throw new Error("no pane rect");
      return { cols: rect.width, rows: rect.height };
    },
    async snapshot() {
      const stdout = await run(bin, ["api", "snapshot"]);
      const parsed = JSON.parse(stdout);
      const raw = parsed.result?.snapshot ?? parsed;
      const agents = await Promise.all((raw.agents ?? []).map(async (rawAgent) => {
        const agent = mapAgent(rawAgent);
        const git = await resolveProject(agent.cwd);
        const model = agent.session?.kind === "path" ? await latestModel(agent.session.value, modelCache) : null;
        return { ...agent, projectRoot: git?.root, branch: git?.branch ?? "", model: model ?? undefined };
      }));
      // Drop cache rows for sessions this snapshot no longer sees, so a
      // long-lived bridge does not retain a row per session file ever opened.
      if (modelCache.size > agents.length) {
        const live = new Set(agents.map((a) => a.session?.value).filter(Boolean));
        for (const file of modelCache.keys()) if (!live.has(file)) modelCache.delete(file);
      }
      // herdr persists pane renames in `label`, which the snapshot's agent
      // objects omit; the pane list carries it. An explicit label beats the
      // generic terminal title (five pi panes all read "π - moshpit").
      // This is a second spawn per poll; `pane list` is a cheap in-memory
      // read on herdr's side, and the labels have no other source.
      let shellList = [];
      try {
        shellList = await reconcileShells();
        const byPane = new Map(shellList.map((p) => [p.pane_id, p.label]));
        for (const agent of agents) {
          const paneLabel = byPane.get(agent.paneId);
          if (paneLabel) agent.title = paneLabel;
        }
      } catch {
        /* labels and shells are display-only */
      }
      metadata = new Map(agents.map((agent) => [agent.id, agent]));
      // A pane this snapshot no longer sees cannot be answered, and its token
      // would otherwise sit in the cache for the life of the bridge.
      observations.forget(metadata.keys());
      // herdr says an agent is blocked but not what it asked. Read only those
      // panes -- the question is the one thing the phone actually needs.
      await Promise.all(
        agents
          .filter((a) => a.status === "blocked")
          .map(async (a) => {
            try {
              const text = await readDetection(a.id);
              const found = extractPrompt(text);
              const observed = observations.observe({
                target: a.id,
                sessionId: a.sessionId,
                harness: a.kind,
                revision: a.revision,
                dump: text,
              });
              if (observed?.kind === "choose" && !observed.consumed) {
                a.blockedDialog = {
                  kind: "choose",
                  family: observed.family,
                  sessionId: observed.sessionId,
                  expected: {
                    token: observed.token,
                    signature: observed.signature,
                    revision: observed.revision,
                  },
                  question: observed.question,
                  step: observed.step,
                  options: observed.options,
                };
              } else {
                a.blockedDialog = {
                  kind: "terminal",
                  question: found?.question ?? "",
                  options: found?.options ?? [],
                };
              }
              if (!found) return;
              a.blockedPrompt = found.question;
              a.blockedOptions = found.options;
              a.lastOutput = found.question;
            } catch {
              /* pane went away between the snapshot and the read */
            }
          }),
      );
      return {
        hostId: "host",
        at: now(),
        agents,
        panes: (raw.agents ?? []).map((a) => ({ id: a.pane_id, agentId: a.pane_id })),
        shells: [...shells.values()].map((s) => ({
          id: s.paneId,
          cwd: s.cwd,
          alive: shellLive.has(s.paneId),
        })),
        kinds: pathKinds(),
      };
    },
    // The pane a write lane is keyed by: a label, terminal ID or pane ID for
    // one pane all resolve to its pane ID.
    async paneId(target) {
      return (await terminalPane(String(target)))?.pane_id ?? String(target);
    },
    // The exact terminal, read fresh rather than through the pane cache, so an
    // upgrade can tell that a ticket's pane closed or was replaced.
    async terminal(terminalId) {
      const panes = JSON.parse(await run(bin, ["pane", "list"]))?.result?.panes ?? [];
      const pane = panes.find((candidate) => candidate.terminal_id === terminalId);
      return pane ? { paneId: pane.pane_id, terminalId: pane.terminal_id } : null;
    },
    async detail(target) {
      const pane = await terminalPane(String(target));
      if (!pane?.terminal_id) throw new Error("terminal not found");
      const agent = metadata.get(pane.pane_id);
      const output = (await run(bin, agent
        ? ["agent", "read", pane.pane_id, "--source", "recent-unwrapped", "--lines", "200", "--format", "ansi"]
        : ["pane", "read", pane.pane_id, "--format", "ansi", "--source", "visible"])).replace(/\0/g, "").slice(-131072);
      return { agentId: pane.pane_id, terminal_id: pane.terminal_id, revision: agent?.revision ?? 0, output,
        conversation: parseConversation(agent?.kind ?? "unknown", output) };
    },
    async prompt(target, text) {
      await run(bin, ["agent", "prompt", String(target), String(text ?? "")]);
    },
    async keys(target, keys) {
      const input = herdrInput(keys);
      if (input.kind === "keys") {
        await run(bin, ["pane", "send-keys", String(target), input.value]);
        return;
      }
      await run(bin, ["pane", "send-text", String(target), input.value]);
    },
    async answer(target, token, optionKey) {
      const pending = observations.peek(target);
      if (!pending || pending.kind !== "choose" || pending.token !== token || pending.consumed) {
        throw new Error(GONE);
      }
      // The snapshot that minted this token is up to one poll old, and a
      // digit sent at the wrong dialog answers it. Re-read the pane and
      // require the same card: the signature covers the stepper header, so
      // a question already answered from the terminal no longer matches.
      let fresh;
      try {
        fresh = inspectAnswerDialog(metadata.get(target)?.kind, await readDetection(target));
      } catch {
        throw new Error(GONE);
      }
      if (fresh.kind !== "choose" || fresh.signature !== pending.signature) throw new Error(GONE);
      const entry = observations.consume(target, token, optionKey);
      if (!entry) throw new Error(GONE);
      // One printable key, the existing keys path: single chars go out as
      // send-text, never Enter. A stale step or unknown key already threw.
      await this.keys(target, optionKey);
    },
    async block() {
      throw new Error("block is demo-only");
    },
    async rename(target, name, clear) {
      await run(bin, ["pane", "rename", String(target), ...(clear ? ["--clear"] : [String(name ?? "")])]);
    },
    async close(target) {
      await run(bin, ["pane", "close", String(target)]);
      for (const [cwd, shell] of shells)
        if (shell.paneId === target) {
          shells.delete(cwd);
          break;
        }
    },
    openShell,
    async isShell(target) {
      return shellHasPane(String(target));
    },
    async startAgent({ cwd, agentKind, model }) {
      const directory = String(cwd).replace(/\/+$/, "");
      // herdr creates tabs in the *active* workspace when none is named, so a
      // start aimed at a directory living in another workspace lands there.
      const panes = JSON.parse(await run(bin, ["pane", "list"]))?.result?.panes ?? [];
      const workspaceId = panes.find((p) => p.cwd === directory)?.workspace_id;
      const created = JSON.parse(
        await run(bin, ["tab", "create", "--cwd", directory, ...(workspaceId ? ["--workspace", workspaceId] : []), "--no-focus"]),
      );
      const paneId = created.result?.root_pane?.pane_id;
      if (!paneId) throw new Error("tab create returned no pane");
      const name = agentName(agentKind);
      // herdr prepends the kind executable, so the agent args are flags only.
      // Only pi's --model is verified; other kinds start unflagged.
      const extra = model && agentKind === "pi" ? ["--", "--model", String(model)] : [];
      try {
        await run(bin, ["agent", "start", name, "--kind", agentKind, "--pane", paneId, ...extra]);
      } catch (err) {
        await run(bin, ["pane", "close", paneId]).catch(() => {});
        throw err;
      }
      return { paneId };
    },
    async capabilities(agent) {
      return nativeCapabilities(agent);
    },
    // Session-control transport: one long-lived child per open terminal. The
    // ticket's terminal_id is the session target; input and resizes are JSON
    // lines on its stdin. JSON.stringify escapes control characters, which the
    // herdr side requires.
    control({ target, cols, rows, onClosed }) {
      const handle = spawnControl(bin, [
        "terminal", "session", "control", String(target),
        "--cols", String(Number(cols)), "--rows", String(Number(rows)),
      ]);
      handle.onClosed = onClosed;
      return handle;
    },
    writeControl(handle, text) {
      if (!handle?.child || handle.closed) return;
      try {
        handle.child.stdin.write(`${JSON.stringify({ type: "terminal.input", text: String(text) })}\n`);
      } catch { /* child went away mid-write */ }
    },
    resizeControl(handle, cols, rows) {
      if (!handle?.child || handle.closed) return;
      try {
        handle.child.stdin.write(`${JSON.stringify({ type: "terminal.resize", cols: Number(cols), rows: Number(rows) })}\n`);
      } catch { /* child went away mid-write */ }
    },
    closeControl(handle) {
      handle?.close();
    },
    async submit(target, text, mode) {
      const agent = metadata.get(target);
      if (agent) return submitNative({ run, bin, target, text, mode, agent });
      // A companion shell is a bare pane: raw terminal writes are fine, but it
      // has no coding-agent session to send prompts into.
      if (mode !== "terminal" || !shellHasPane(String(target)))
        throw new Error("Unknown agent for submission.");
      return submitNative({ run, bin, target, text, mode, agent: { kind: "shell" } });
    },
  };
}

export function createHerdr(opts = {}) {
  const onLine = opts.onLine;
  const bin = opts.bin ?? process.env.MOSHPIT_HERDR_BIN;
  if (bin) return createExecHerdr(bin, onLine);
  return createDemoHerdr(onLine);
}
