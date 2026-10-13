import type { BlockedDialog } from "./types";

export const QUESTION_CONTROLS_ENABLED: false;

export type QuestionControl =
  | {
      op: "toggle";
      questionId: string;
      optionKey: string;
      label: string;
      description?: string;
      checked: boolean;
    }
  | { op: "text"; questionId: string; label: string }
  | { op: "review"; label: "Review" }
  | { op: "submit"; label: "Submit answers" }
  | { op: "next"; label: "Next tab" }
  | { op: "prev"; label: "Previous tab" };

export type QuestionControlModel = {
  token: string;
  phase: "select" | "review";
  questionId: string;
  question: string;
  answers?: string[];
  controls: QuestionControl[];
};

export function questionControls(
  dialog: BlockedDialog | undefined,
  enabled?: boolean,
): QuestionControlModel | null;
