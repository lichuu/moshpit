import { setTimeout as delay } from "node:timers/promises";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SUPPORTED = new Set(["pi", "claude", "claude-code", "codex", "grok", "opencode"]);

function reject(message) {
  throw Object.assign(new Error(message), { delivery: "failed" });
}

async function piBindings() {
  try {
    const value = JSON.parse(await readFile(path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"), "keybindings.json"), "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    return ["tui.input.submit", "app.message.followUp", "app.abort"].every((key) => !(key in value));
  } catch (error) {
    return error.code === "ENOENT";
  }
}

export async function nativeCapabilities(agent) {
  const known = SUPPORTED.has(agent.kind);
  const pi = agent.kind === "pi" && await piBindings();
  return { inputModes: known ? pi ? ["send", "steer", "queue"] : ["send"] : [], stop: pi, fit: false };
}

// Typed text opens pi's completion list ("/model " lists models), and the
// Enter that follows accepts its first row instead of submitting. Pasted
// text opens no list. An end marker inside the text would close the paste
// early, so it is dropped.
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const paste = (text) => `${PASTE_START}${text.replaceAll(PASTE_END, "")}${PASTE_END}`;

export async function submitNative({ run, bin, target, text, mode, agent }) {
  const capabilities = await nativeCapabilities(agent);
  if (mode !== "terminal" && mode !== "stop" && !capabilities.inputModes.includes(mode)) {
    reject("This action is unavailable for this agent. Open Terminal to use its native controls.");
  }
  if (mode === "stop") {
    if (!capabilities.stop) reject("Stop is unavailable for this agent. Open Terminal to use its native controls.");
    if (agent.status !== "working") reject("This agent is not running a turn.");
    await run(bin, ["pane", "send-keys", String(target), "esc"]);
    return { state: "delivered", message: "Stop key delivered to the terminal." };
  }
  if (mode !== "terminal" && !text.trim()) reject("Write a message before sending.");
  if (typeof text !== "string") reject("Invalid message text.");
  if (text) {
    await run(bin, ["pane", "send-text", String(target), agent.kind === "pi" ? paste(text) : text]);
    // Herdr's native agent.prompt uses the same gap for paste handling. Await
    // the delimiter here so another bridge write cannot overtake it.
    await delay(300);
  }
  // A blocked dialog owns Enter. Insert the draft and leave submit to the
  // keypad / printed option keys so a typed answer cannot confirm whatever
  // the TUI currently highlights.
  if (mode !== "terminal" && agent.status === "blocked") {
    return { state: "delivered", message: "Typed into the terminal. Use Enter or Esc from the keypad to submit or cancel." };
  }
  await run(bin, ["pane", "send-keys", String(target), mode === "queue" ? "alt+enter" : "enter"]);
  return { state: "delivered", message: mode === "queue" ? "Follow-up key delivered. Check the native queue for acceptance." : mode === "steer" ? "Steering key delivered. The agent keeps its native delivery timing." : "Message and submit key delivered to the terminal." };
}
