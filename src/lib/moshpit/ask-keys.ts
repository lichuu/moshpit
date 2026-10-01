import type { KeyInput } from "./bridge";
import type { Question } from "./session-protocol";

// ponytail: per-agent TUI key table for single-select question options.
// Digits are verified against Collie's live-verified Claude wizard notes;
// the arrow run against the pi TUI source. Unknown kinds fall back to the
// label text. Multi-select key semantics differ per agent and are
// unverified, so the card routes them to the Terminal instead.
//
// herdr names panes by harness, so a live Claude Code pane reports "claude";
// "claude-code" only ever comes from the demo seed. Both spellings have to
// match or the digit recipe is dead on every real bridge -- the same pair
// sessions.mjs and native-input.mjs already accept.
const DIGIT_KINDS = new Set(["claude", "claude-code", "codex"]);

export function askOptionKeys(kind: string, question: Question, optionIndex: number): KeyInput[] {
  if (!question.options[optionIndex]) return [];
  if (kind === "pi") return [...Array(optionIndex).fill("down"), "enter"];
  // Digits and labels go as marked text: "10" is not a key name, and a label
  // reading "Enter" must be typed, not pressed. Codex digits commit on their
  // own; a trailing Enter leaks into the next card.
  if (kind === "codex") return [{ text: String(optionIndex + 1) }];
  if (DIGIT_KINDS.has(kind)) return [{ text: String(optionIndex + 1) }, "enter"];
  return [{ text: question.options[optionIndex].label }, "enter"];
}
