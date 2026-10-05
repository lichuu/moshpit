import { open, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";

const capabilities = { inputModes: ["send"], stop: false, fit: false };
const text = (value) => typeof value === "string" ? value : JSON.stringify(value ?? "", null, 2);
const contentText = (value) => typeof value === "string" ? value : Array.isArray(value)
  ? value.map((part) => part.text ?? (part.type === "image" ? "[Image]" : part.type === "resource_link" ? part.uri : "")).filter(Boolean).join("\n") : text(value);
const hash = (value) => createHash("sha256").update(value).digest("hex").slice(0, 20);
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
function decode(value) {
  try { return JSON.parse(Buffer.from(value, "base64url").toString()); } catch { return null; }
}

async function findExact(root, predicate) {
  const matches = [];
  async function visit(dir) {
    let files;
    try { files = await readdir(dir, { withFileTypes: true }); } catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const file of files) {
      const full = path.join(dir, file.name);
      if (file.isDirectory()) await visit(full);
      else if (file.isFile() && predicate(file.name, full)) matches.push(full);
    }
  }
  await visit(root);
  if (matches.length !== 1) throw new Error(matches.length ? "Session source is ambiguous." : "The native session file is not available yet.");
  return matches[0];
}

// A question tool is any ask-user tool whose input carries structured options.
// The shape, not the name alone, is the match: a same-named tool without
// options falls back to a plain activity entry.
const askTool = /(ask[_-]?user|request[_-]?user[_-]?input|user[_-]?input|elicit)/i;
function questionModel(name, input) {
  if (!name || !askTool.test(String(name))) return null;
  let parsed = input;
  if (typeof parsed === "string") { try { parsed = JSON.parse(parsed); } catch { return null; } }
  if (!parsed || !Array.isArray(parsed.questions)) return null;
  const questions = parsed.questions.map((item, i) => {
    const question = {
      text: item && typeof item.question === "string" ? item.question : `Question ${i + 1}`,
      multi: !!(item && item.multiSelect === true),
      options: Array.isArray(item?.options)
        ? item.options.filter((o) => o && typeof o.label === "string").map((o) => ({
            label: o.label,
            description: typeof o.description === "string" ? o.description : undefined,
          }))
        : [],
    };
    if (item && typeof item.id === "string" && item.id) question.id = item.id;
    if (item && typeof item.header === "string" && item.header) question.header = item.header;
    return question;
  });
  // Keep option-less questions in place rather than filtering them out: the
  // tap recipe counts positions, so dropping one here would silently shift
  // every later question out of step with what the TUI is showing.
  return questions.some((question) => question.options.length > 0) ? questions : null;
}

// A keyed result ("{\"answers\":{<id>:{\"answers\":[...]}}}") maps answers to
// questions by exact id, never object order. Duplicate ids disable the
// mapping entirely, missing or malformed per-question values stay absent
// (never fabricated), failed results never populate answers, and anything
// else keeps the legacy entry-level result text.
function applyKeyedAnswers(questions, failed, answer) {
  if (failed) return false;
  let parsed;
  try { parsed = JSON.parse(answer); } catch { return false; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Object.hasOwn(parsed, "answers")) return false;
  const keyed = parsed.answers;
  if (!keyed || typeof keyed !== "object" || Array.isArray(keyed)) return false;
  const seen = new Set();
  for (const question of questions) {
    if (question.id === undefined) continue;
    if (seen.has(question.id)) return false;
    seen.add(question.id);
  }
  if (!seen.size) return false;
  let matched = false;
  for (const question of questions) {
    if (question.id === undefined || !Object.hasOwn(keyed, question.id)) continue;
    const value = keyed[question.id];
    if (value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "answers") && Array.isArray(value.answers) && value.answers.every((entry) => typeof entry === "string")) {
      question.answers = value.answers;
      matched = true;
    }
  }
  return matched;
}

// Pi saves `/skill:name args` as the whole SKILL.md wrapped in <skill>, then
// the args. Same match as pi's own HTML export; fold it back to what was typed.
function piSkillCommand(text) {
  const match = typeof text === "string" && text.match(/^<skill name="([^"]+)" location="[^"]+">\n[\s\S]*?\n<\/skill>(?:\n\n([\s\S]+))?$/);
  return match ? `/skill:${match[1]}${match[2] ? ` ${match[2]}` : ""}` : text;
}

function normalize(kind, records) {
  let entries = [];
  let turnId = "initial";
  const tools = new Map();
  const add = (entry, row, suffix = "") => {
    const id = `${row.id ?? row.uuid ?? row._offset}${suffix}`;
    const item = { id, turnId, ...(row.timestamp ? { at: String(row.timestamp) } : {}), ...entry };
    entries.push(item);
    return item;
  };
  const message = (role, value, row, suffix = "") => {
    const body = contentText(value);
    if (!body) return;
    if (role === "user") turnId = String(row.id ?? row.uuid ?? row._offset);
    return add({ kind: "message", role, text: body }, row, suffix);
  };
  const tool = (id, title, input, row, suffix = "") => {
    const question = questionModel(title, input);
    if (question) {
      const item = add({ kind: "question", title: "Question", questions: question, resolved: false }, row, suffix);
      tools.set(id, item);
      return item;
    }
    const item = add({ kind: "activity", title: title || "Tool", input: text(input), output: "", status: "running" }, row, suffix);
    let edit = input;
    if (typeof edit === "string") { try { edit = JSON.parse(edit); } catch { /* raw patch or command */ } }
    if (edit && typeof edit === "object") {
      const before = edit.old_string ?? edit.oldText ?? edit.old_str;
      const after = edit.new_string ?? edit.newText ?? edit.new_str;
      const file = edit.file_path ?? edit.path ?? edit.file ?? "file";
      if (typeof before === "string" && typeof after === "string") item.diff = `--- ${file}\n${before.split("\n").map((line) => `-${line}`).join("\n")}\n+++ ${file}\n${after.split("\n").map((line) => `+${line}`).join("\n")}`;
      if (typeof edit.patch === "string") item.diff = edit.patch;
    } else if (typeof input === "string" && input.includes("*** Begin Patch")) item.diff = input;
    tools.set(id, item);
    return item;
  };
  const result = (id, output, failed, row) => {
    const item = tools.get(id) ?? tool(id, "Tool result", "", row);
    if (item.kind === "question") {
      item.resolved = true;
      const answer = contentText(output);
      if (!applyKeyedAnswers(item.questions, failed, answer) && answer) item.answer = answer;
      return;
    }
    item.output = contentText(output);
    item.status = failed ? "failed" : "complete";
  };
  const blocks = (role, value, row) => {
    if (typeof value === "string") { message(role, value, row); return; }
    if (!Array.isArray(value)) return;
    value.forEach((part, i) => {
      const suffix = `:${i}`;
      if (["text", "input_text", "output_text"].includes(part.type)) message(role, part.text, row, suffix);
      else if (["tool_use", "toolCall"].includes(part.type)) tool(part.id, part.name, part.input ?? part.arguments, row, suffix);
      else if (part.type === "tool_result") result(part.tool_use_id, part.content, part.is_error, row);
      else if (["image", "input_image"].includes(part.type)) message(role, "[Image]", row, suffix);
    });
  };
  if (kind === "pi") {
    // Pi's last entry is the active leaf; parent links select the visible branch.
    const byId = new Map(records.filter((r) => r.id).map((r) => [r.id, r]));
    let leaf = records.findLast((r) => r.id && r.type !== "session");
    const branch = [];
    const visited = new Set();
    while (leaf && !visited.has(leaf.id)) {
      visited.add(leaf.id); branch.push(leaf); leaf = byId.get(leaf.parentId);
    }
    records = branch.reverse();
  }
  for (const row of records) {
    if (kind === "codex") {
      const p = row.payload ?? {};
      if (row.type === "event_msg" && ["task_started", "turn_started"].includes(p.type)) turnId = p.turn_id ?? turnId;
      if (row.type === "response_item") {
        if (p.type === "message" && ["user", "assistant"].includes(p.role)) blocks(p.role, p.content, row);
        if (["function_call", "custom_tool_call"].includes(p.type)) tool(p.call_id, p.name, p.arguments ?? p.input, row);
        if (["function_call_output", "custom_tool_call_output"].includes(p.type)) result(p.call_id, p.output, false, row);
      }
      if (row.type === "compacted") add({ kind: "status", text: p.message ?? "Conversation compacted" }, row);
      if (row.type === "event_msg" && ["task_complete", "turn_complete", "turn_aborted"].includes(p.type)) add({ kind: "status", text: p.type === "turn_aborted" ? "Turn stopped" : "Turn complete" }, row);
    } else if (kind === "claude") {
      // isMeta rows are what the harness told the model, not what anyone
      // typed: a loaded skill's SKILL.md, an attached image's dimensions.
      if (row.isSidechain || row.isMeta) continue;
      if (["user", "assistant"].includes(row.type)) blocks(row.type, row.message?.content, row);
      if (row.type === "system" && row.subtype === "compact_boundary") add({ kind: "status", text: "Conversation compacted" }, row);
    } else if (kind === "pi") {
      const m = row.message ?? {};
      if (row.type === "message" && m.role === "assistant") blocks(m.role, m.content, row);
      if (row.type === "message" && m.role === "user") blocks(m.role, typeof m.content === "string" ? piSkillCommand(m.content) : m.content?.map((part) => part.type === "text" ? { ...part, text: piSkillCommand(part.text) } : part), row);
      if (row.type === "message" && m.role === "toolResult") result(m.toolCallId, m.content, m.isError, row);
      if (["compaction", "branch_summary"].includes(row.type)) add({ kind: "status", text: row.summary ?? "Conversation compacted" }, row);
    } else if (kind === "grok") {
      const u = row.params?.update ?? {};
      const update = u.sessionUpdate;
      if (["user_message_chunk", "agent_message_chunk"].includes(update)) {
        const role = update === "user_message_chunk" ? "user" : "assistant";
        const last = entries.at(-1);
        const value = contentText([u.content]);
        if (last?.kind === "message" && last.role === role) last.text += value;
        else message(role, value, row);
      }
      if (update === "tool_call") tool(u.toolCallId, u.title, u.rawInput, row);
      if (update === "tool_call_update") {
        const item = tools.get(u.toolCallId) ?? tool(u.toolCallId, u.title, u.rawInput, row);
        if (u.title) item.title = u.title;
        if (u.rawInput) item.input = text(u.rawInput);
        if (u.content) {
          item.output = u.content.map((p) => p.type === "content" ? contentText([p.content]) : text(p)).join("\n");
          const diffs = u.content.filter((p) => p.type === "diff");
          if (diffs.length) item.diff = diffs.map((d) => `--- ${d.path}\n${d.oldText ?? ""}\n+++ ${d.path}\n${d.newText ?? ""}`).join("\n");
        }
        if (u.status) item.status = u.status === "failed" ? "failed" : u.status === "completed" ? "complete" : "running";
      }
      if (update === "turn_completed") add({ kind: "status", text: u.stop_reason === "cancelled" ? "Turn stopped" : "Turn complete" }, row);
      if (["session_recap", "auto_compact_completed"].includes(update)) add({ kind: "status", text: u.summary ?? "Conversation compacted" }, row);
    } else if (kind === "opencode") {
      const info = row.info;
      if (!info || !["user", "assistant"].includes(info.role)) continue;
      turnId = info.role === "user" ? info.id : info.parentID ?? turnId;
      for (const part of row.parts ?? []) {
        const source = { id: part.id, timestamp: info.time?.created };
        if (part.type === "text") message(info.role, part.text, source);
        if (part.type === "tool") {
          const s = part.state ?? {};
          const item = tool(part.callID, s.title ?? part.tool, s.input, source);
          item.output = text(s.output ?? s.error ?? "");
          item.status = s.status === "error" ? "failed" : s.status === "completed" ? "complete" : "running";
        }
        if (part.type === "file") message(info.role, `[Attachment: ${part.filename ?? part.mime}]`, source);
      }
    }
  }
  return entries;
}

export function createSessionReader(options = {}) {
  const home = options.home ?? os.homedir();
  const cache = new Map();
  const sources = new Map();
  const pending = new Map();
  async function locate(agent, kind) {
    const session = agent.session;
    if (!session || !["id", "path"].includes(session.kind) || typeof session.value !== "string" || !session.value) throw new Error("This pane has not reported an exact native session. Use Terminal.");
    const key = `${kind}:${session.kind}:${session.value}`;
    if (sources.has(key)) return sources.get(key);
    let source;
    if (session.kind === "path") source = path.resolve(session.value);
    else {
      const id = session.value;
      if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid native session identity.");
      if (kind === "codex") source = await findExact(path.join(options.codexHome ?? process.env.CODEX_HOME ?? path.join(home, ".codex"), "sessions"), (name) => name.endsWith(`-${id}.jsonl`));
      if (kind === "claude") source = await findExact(path.join(options.claudeHome ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude"), "projects"), (name) => name === `${id}.jsonl`);
      if (kind === "pi") source = await findExact(path.join(options.piHome ?? path.join(home, ".pi", "agent"), "sessions"), (name) => name.endsWith(`_${id}.jsonl`));
      if (kind === "grok") source = await findExact(path.join(options.grokHome ?? process.env.GROK_HOME ?? path.join(home, ".grok"), "sessions"), (name, full) => name === "updates.jsonl" && path.basename(path.dirname(full)) === id);
    }
    if (!source) throw new Error("No native source is configured for this session.");
    if (kind === "grok" && !(source.endsWith(".jsonl"))) source = path.join(source, "updates.jsonl");
    sources.set(key, source);
    return source;
  }
  async function openCode(agent) {
    if (agent.session?.kind !== "id") throw new Error("OpenCode has not reported an exact session ID.");
    let servers = options.openCodeServers;
    if (!servers && process.env.MOSHPIT_SESSION_REGISTRY) servers = JSON.parse(await readFile(process.env.MOSHPIT_SESSION_REGISTRY, "utf8")).opencode;
    const server = servers?.[agent.session.value];
    if (!server) throw new Error("Register this OpenCode session's existing local server to enable Conversation.");
    const url = new URL(server.url);
    if (!["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("OpenCode requires a local server URL.");
    const headers = {};
    if (server.password) headers.authorization = `Basic ${Buffer.from(`${server.username ?? "opencode"}:${server.password}`).toString("base64")}`;
    if (server.directory) headers["x-opencode-directory"] = server.directory;
    const get = async (endpoint) => {
      const response = await (options.fetch ?? fetch)(new URL(endpoint, url), { headers, signal: AbortSignal.timeout(5000), redirect: "error" });
      if (!response.ok) throw new Error(`OpenCode server returned ${response.status}.`);
      return response.json();
    };
    const id = encodeURIComponent(agent.session.value);
    const session = await get(`/session/${id}`);
    if (session.id !== agent.session.value) throw new Error("OpenCode server returned a different session.");
    const records = await get(`/session/${id}/message`);
    if (!Array.isArray(records)) throw new Error("Invalid OpenCode messages response.");
    return records;
  }
  async function refresh(agent, kind, sessionId) {
    let state = cache.get(sessionId);
    if (!state) { state = { generation: 0, revision: 0, entries: [], versions: new Map(), records: [], offset: 0 }; cache.set(sessionId, state); }
    let records;
    let replace = false;
    if (kind === "opencode") records = await openCode(agent);
    else {
      const source = await locate(agent, kind);
      const info = await stat(source);
      const signature = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      if (signature === state.signature) return state;
      replace = state.signature && (state.inode !== info.ino || info.size < state.size || info.size === state.size);
      if (replace) { state.offset = 0; state.records = []; }
      const file = await open(source, "r");
      let buffer;
      try {
        buffer = Buffer.alloc(Math.max(0, info.size - state.offset));
        let read = 0;
        while (read < buffer.length) {
          const { bytesRead } = await file.read(buffer, read, buffer.length - read, state.offset + read);
          if (!bytesRead) break;
          read += bytesRead;
        }
        buffer = buffer.subarray(0, read);
      } finally { await file.close(); }
      const end = buffer.lastIndexOf(10);
      if (end >= 0) {
        let consumed = 0;
        const appended = [];
        for (const line of buffer.subarray(0, end).toString("utf8").split("\n")) {
          if (line.trim()) appended.push({ ...JSON.parse(line), _offset: state.offset + consumed });
          consumed += Buffer.byteLength(line) + 1;
        }
        state.records.push(...appended);
        state.offset += end + 1;
      }
      state.signature = signature; state.inode = info.ino; state.size = info.size;
      records = state.records;
    }
    const next = normalize(kind, records);
    const ids = new Set(next.map((entry) => entry.id));
    if (replace || state.entries.some((entry) => !ids.has(entry.id))) { state.generation++; state.versions.clear(); }
    state.revision++;
    const previous = new Map(state.entries.map((entry) => [entry.id, JSON.stringify(entry)]));
    for (const entry of next) if (JSON.stringify(entry) !== previous.get(entry.id) || !state.versions.has(entry.id)) state.versions.set(entry.id, state.revision);
    state.entries = next;
    return state;
  }
  // When the newest message in a session was sent or received, for ordering
  // the agent list. Only the file's tail is read, and only when it changed.
  // ponytail: a 256KB tail; a turn that writes more tool output than that
  // without a message keeps the time of the last message seen.
  const activity = new Map();
  async function lastMessageAt(agent) {
    const kind = agent.kind === "claude-code" ? "claude" : agent.kind;
    if (!["codex", "claude", "pi", "grok"].includes(kind) || !agent.session?.value) return undefined;
    const key = `${kind}:${agent.session.kind}:${agent.session.value}`;
    const hit = activity.get(key);
    try {
      // A session with no file yet is looked for again later, not on every poll.
      if (hit?.retryAt > Date.now()) return undefined;
      const source = await locate(agent, kind);
      const info = await stat(source);
      const signature = `${info.size}:${info.mtimeMs}`;
      if (hit?.signature === signature) return hit.at;
      const size = Math.min(info.size, 262144);
      const buffer = Buffer.alloc(size);
      const file = await open(source, "r");
      try { await file.read(buffer, 0, size, info.size - size); } finally { await file.close(); }
      const records = [];
      for (const line of buffer.toString("utf8").split("\n")) {
        try { if (line.trim()) records.push(JSON.parse(line)); } catch { /* a first line the tail cut in half */ }
      }
      const newest = normalize(kind, records).findLast((entry) => entry.kind === "message" && entry.at);
      const at = (newest && Date.parse(newest.at)) || hit?.at || Math.round(info.mtimeMs);
      activity.set(key, { signature, at });
      return at;
    } catch {
      activity.set(key, { retryAt: Date.now() + 30_000 });
      return undefined;
    }
  }
  read.lastMessageAt = lastMessageAt;
  return read;
  async function read(agent, query = {}) {
    try {
      const kind = agent.kind === "claude-code" ? "claude" : agent.kind;
      if (!["codex", "claude", "pi", "grok", "opencode"].includes(kind)) throw new Error(`Native conversation is not available for ${agent.kind}. Use Terminal.`);
      if (!agent.session?.value) throw new Error("This pane has not reported an exact native session. Use Terminal.");
      const sessionId = `${kind}:${hash(`${agent.session.kind}:${agent.session.value}`)}`;
      const work = (pending.get(sessionId) ?? Promise.resolve()).catch(() => {}).then(() => refresh(agent, kind, sessionId));
      pending.set(sessionId, work);
      const state = await work;
      if (pending.get(sessionId) === work) pending.delete(sessionId);
      const cursor = encode({ s: sessionId, g: state.generation, r: state.revision });
      const requested = decode(query.after ?? query.before);
      const valid = requested?.s === sessionId && requested.g === state.generation && Number.isInteger(requested.r) && requested.r <= state.revision;
      const reset = !!(query.after || query.before) && !valid;
      let start = Math.max(0, state.entries.length - 100);
      let end = state.entries.length;
      let entries;
      if (query.after && valid) entries = state.entries.filter((entry) => state.versions.get(entry.id) > requested.r);
      else {
        if (query.before && valid) { const position = state.entries.findIndex((entry) => entry.id === requested.b); if (position >= 0) end = position; start = Math.max(0, end - 100); }
        entries = state.entries.slice(start, end);
      }
      const before = start > 0 ? encode({ s: sessionId, g: state.generation, r: state.revision, b: state.entries[start].id }) : null;
      return { kind: "available", agentId: agent.id, sessionId, entries, cursor, before, reset, capabilities };
    } catch (error) {
      return { kind: "unavailable", agentId: agent.id, reason: error.code === "ENOENT" ? "The native session file is not available yet." : error.message };
    }
  }
}
