// eslint-disable-next-line no-control-regex
const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;

function push(messages, role, text) {
  const value = text.trimEnd();
  if (!value) return;
  const last = messages.at(-1);
  if (last?.role === role) last.text += `\n${value}`;
  else messages.push({ role, text: value });
}

/** Conservative terminal-to-turn projection. Unknown text stays in Output. */
export function parseConversation(kind, raw) {
  const messages = [];
  let role = null;
  for (const original of raw.replace(ANSI, "").split(/\r?\n/)) {
    const line = original.replace(/\s+$/, "");
    const user = line.match(/^\s*[›❯>]\s+(.+)$/u);
    const agent = line.match(/^\s*[•✻●]\s+(.+)$/u);
    if (user) {
      role = "user";
      push(messages, role, user[1]);
    } else if (agent) {
      role = "agent";
      push(messages, role, agent[1]);
    } else if (role && /^\s{2,}\S/.test(line) && !/^\s*[└├│]/u.test(line)) {
      push(messages, role, line.trimStart());
    } else if (!line.trim()) {
      role = null;
    }
  }
  if (!messages.some((message) => message.role === "user") ||
      !messages.some((message) => message.role === "agent")) {
    return { kind: "unavailable", reason: `No ${kind} turn markers found` };
  }
  return { kind: "available", messages };
}
