export type PaneKey =
  | { kind: "deliver"; value: string }
  | { kind: "unsupported"; label: string }
  | { kind: "ignore" };

// Every modifier combination each named key accepts. A combination that is
// absent is unsupported, never the unmodified key: delivering a bare "\r" for
// Ctrl+Enter submits whatever the agent had staged.
const NAMED: Record<string, Record<string, string>> = {
  Tab: { "": "\t", shift: "shift+tab" },
  Enter: { "": "\r", alt: "alt+enter" },
  Backspace: { "": "\x7f" },
  Escape: { "": "\x1b" },
  ArrowUp: { "": "up" },
  ArrowDown: { "": "down" },
  ArrowLeft: { "": "left" },
  ArrowRight: { "": "right" },
};

const REPORTED = ["Home", "End", "PageUp", "PageDown", "Delete"];
const MODIFIER_KEYS = ["Shift", "Control", "Alt", "Meta"];
const NAMES: Record<string, string> = { ctrl: "Ctrl", alt: "Alt", shift: "Shift", meta: "Meta" };

function combination(e: { shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }): string {
  return [e.ctrlKey && "ctrl", e.altKey && "alt", e.shiftKey && "shift", e.metaKey && "meta"]
    .filter(Boolean)
    .join("+");
}

function label(combo: string, key: string): string {
  if (!combo) return key;
  return `${combo.split("+").map((name) => NAMES[name]).join("+")}+${key}`;
}

export function parsePaneKey(e: {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  nativeEvent?: { isComposing?: boolean };
}): PaneKey {
  if (e.nativeEvent?.isComposing) return { kind: "ignore" };
  if (MODIFIER_KEYS.includes(e.key)) return { kind: "ignore" };
  if (e.metaKey || e.ctrlKey) {
    const shortcut = e.key.toLowerCase();
    if (shortcut === "c" || shortcut === "v" || shortcut === "x" || shortcut === "a") return { kind: "ignore" };
  }
  const combo = combination(e);
  const accepted = NAMED[e.key];
  if (accepted) {
    const value = accepted[combo];
    return value === undefined ? { kind: "unsupported", label: label(combo, e.key) } : { kind: "deliver", value };
  }
  if (combo === "ctrl" && /^[a-z]$/i.test(e.key)) {
    return { kind: "deliver", value: String.fromCharCode(e.key.toLowerCase().charCodeAt(0) - 96) };
  }
  if (e.key.length === 1 && (combo === "" || combo === "shift")) return { kind: "deliver", value: e.key };
  if (REPORTED.includes(e.key) || e.key.startsWith("F")) return { kind: "unsupported", label: label(combo, e.key) };
  if (combo) return { kind: "unsupported", label: label(combo, e.key) };
  return { kind: "ignore" };
}
