import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// C13: herdr's own alert settings, read from its config file and never
// written. Two things are taken from it: `ui.toast.delay_seconds`, how long an
// alert waits to see whether the agent is still blocked or finished, and
// `[ui.sound.agents]`, which agents are muted. Keys, types and defaults are
// those of herdr's config reference, the same in 0.8.2 and 0.9.3.

export const DEFAULT_DELAY_SECONDS = 1;
export const MAX_DELAY_SECONDS = 3600;
/** herdr ships with one agent muted. */
const DEFAULT_SOUND_AGENTS = { droid: "off" };
const SOUND_VALUES = new Set(["default", "on", "off"]);
const MAX_CONFIG_BYTES = 1024 * 1024;
// herdr's label on the left, the kind the bridge reports on the right, where
// they differ by more than an underscore.
const LABEL_KINDS = { github_copilot: "copilot" };

export function herdrConfigPath(env = process.env) {
  if (env.HERDR_CONFIG_PATH) return env.HERDR_CONFIG_PATH;
  return path.join(env.HOME || os.homedir(), ".config", "herdr", "config.toml");
}

/** The text before a `#` comment, minding quotes. */
function uncommented(line) {
  let quote = "";
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quote) {
      if (c === "\\" && quote === '"') i += 1;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "#") return line.slice(0, i);
  }
  return line;
}

/** Splits on `separator` outside quotes and braces. */
function splitOutside(text, separator) {
  const parts = [];
  let quote = "";
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === "\\" && quote === '"') i += 1;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "{" || c === "[") depth += 1;
    else if (c === "}" || c === "]") depth -= 1;
    else if (c === separator && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function keyPath(text) {
  const parts = splitOutside(text.trim(), ".").map((part) => {
    const key = part.trim();
    const quoted = /^"([^"\\]*)"$/.exec(key) ?? /^'([^']*)'$/.exec(key);
    if (quoted) return quoted[1];
    return /^[A-Za-z0-9_-]+$/.test(key) ? key : null;
  });
  return parts.includes(null) ? null : parts;
}

function assign(out, prefix, keyText, valueText) {
  const key = keyPath(keyText);
  if (!key) return;
  const at = [...prefix, ...key];
  const value = valueText.trim();
  if (value.startsWith("{") && value.endsWith("}")) {
    for (const pair of splitOutside(value.slice(1, -1), ",")) {
      const [k, ...rest] = splitOutside(pair, "=");
      if (rest.length) assign(out, at, k, rest.join("="));
    }
    return;
  }
  let scalar;
  if (value === "true") scalar = true;
  else if (value === "false") scalar = false;
  else if (/^[+-]?\d[\d_]*$/.test(value)) scalar = Number(value.replaceAll("_", ""));
  else {
    const text = /^"((?:[^"\\]|\\.)*)"$/.exec(value) ?? /^'([^']*)'$/.exec(value);
    if (!text) return;
    scalar = text[1];
  }
  out.set(at.join("."), scalar);
}

/**
 * The booleans, integers and one-line strings of a TOML document, by dotted
 * path. This is the subset the alert settings use, not a TOML parser: arrays,
 * multi-line strings, floats and dates are skipped, and a key inside an array
 * of tables is filed under the table's name.
 */
export function tomlScalars(text) {
  const out = new Map();
  let table = [];
  let fence = "";
  for (const raw of String(text).split(/\r?\n/)) {
    if (fence) {
      if (raw.includes(fence)) fence = "";
      continue;
    }
    const line = uncommented(raw).trim();
    if (!line) continue;
    const header = /^\[\[?([^\]]+)\]\]?$/.exec(line);
    if (header) {
      table = keyPath(header[1]) ?? ["\0"];
      continue;
    }
    const [key, ...rest] = splitOutside(line, "=");
    if (!rest.length) continue;
    const value = rest.join("=").trim();
    const opened = /^("""|''')/.exec(value);
    if (opened) {
      if (!value.slice(3).includes(opened[1])) fence = opened[1];
      continue;
    }
    assign(out, table, key, value);
  }
  return out;
}

/** herdr's alert settings from its config text. Anything missing or out of range is herdr's default. */
export function parseAlertConfig(text) {
  const scalars = tomlScalars(text ?? "");
  const delay = scalars.get("ui.toast.delay_seconds");
  const delaySeconds = Number.isInteger(delay) && delay >= 0 && delay <= MAX_DELAY_SECONDS ? delay : DEFAULT_DELAY_SECONDS;
  const soundAgents = { ...DEFAULT_SOUND_AGENTS };
  for (const [key, value] of scalars) {
    const label = /^ui\.sound\.agents\.([^.]+)$/.exec(key)?.[1];
    if (label && SOUND_VALUES.has(value)) soundAgents[label] = value;
  }
  return { delaySeconds, soundAgents };
}

/** Whether herdr mutes this kind of agent. Only an explicit "off" mutes. */
export function soundMuted(config, kind) {
  if (!kind) return false;
  for (const [label, value] of Object.entries(config.soundAgents)) {
    if (value !== "off") continue;
    if (label === kind || label.replaceAll("_", "") === kind || LABEL_KINDS[label] === kind) return true;
  }
  return false;
}

/**
 * Reads the config when its size or modification time changes. A missing,
 * unreadable or oversized file gives herdr's defaults; nothing here throws.
 */
export function createHerdrAlerts({ file = herdrConfigPath(), fs = { readFile, stat } } = {}) {
  let stamp = "";
  let config = parseAlertConfig("");
  return {
    async current() {
      try {
        const info = await fs.stat(file);
        const next = `${info.size}:${info.mtimeMs}`;
        if (next !== stamp) {
          config = info.isFile() && info.size <= MAX_CONFIG_BYTES ? parseAlertConfig(await fs.readFile(file, "utf8")) : parseAlertConfig("");
          stamp = next;
        }
      } catch {
        stamp = "";
        config = parseAlertConfig("");
      }
      return config;
    },
    /** Marks the agents herdr mutes, for the app's own sound. */
    annotate(agents, current) {
      return agents.map((agent) => (soundMuted(current, agent.kind) ? { ...agent, soundMuted: true } : agent));
    },
  };
}
