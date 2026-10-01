import type { KeyInput } from "./bridge";
import type { Question } from "./session-protocol";

const DIGIT_KINDS = new Set(["claude", "claude-code", "codex"]);

export function askOptionKeys(kind: string, question: Question, optionIndex: number): KeyInput[] {
  if (!question.options[optionIndex]) return [];
  if (kind === "pi") return [...Array(optionIndex).fill("down"), "enter"];
  // Claude and Codex digits commit immediately. Enter would reach the next question.
  if (DIGIT_KINDS.has(kind)) return [{ text: String(optionIndex + 1) }];
  return [{ text: question.options[optionIndex].label }, "enter"];
}
