export const QUESTION_CONTROLS_ENABLED = false;

function compact(text) {
  return String(text ?? "").replace(/\s+/gu, " ").trim();
}

export function questionControls(dialog, enabled = QUESTION_CONTROLS_ENABLED) {
  if (!enabled || dialog?.kind !== "questions" || dialog.family !== "claude-ask-user-multiselect-v1") return null;
  const question = dialog.questions?.[0];
  if (!question || compact(question.id) !== compact(question.question)) return null;
  if (dialog.phase === "select" && dialog.actions?.includes("text") && dialog.focus?.kind === "other") {
    return {
      token: dialog.expected.token,
      phase: "select",
      questionId: question.id,
      question: question.question,
      controls: [{ op: "text", questionId: question.id, label: question.other?.label || "Type something" }],
    };
  }
  if (dialog.phase === "select" && dialog.actions?.includes("toggle") && (dialog.actions.includes("review") || dialog.actions.includes("next"))) {
    if (!question.options?.length) return null;
    return {
      token: dialog.expected.token,
      phase: "select",
      questionId: question.id,
      question: question.question,
      controls: [
        ...question.options.map((option) => ({
          op: "toggle",
          questionId: question.id,
          optionKey: option.key,
          label: option.label,
          description: option.description || undefined,
          checked: option.checked === true,
        })),
        ...(dialog.actions.includes("review") ? [{ op: "review", label: "Review" }] : []),
        ...(dialog.actions.includes("next") ? [{ op: "next", label: "Next tab" }] : []),
        ...(dialog.actions.includes("prev") ? [{ op: "prev", label: "Previous tab" }] : []),
      ],
    };
  }
  if (dialog.phase === "review" && dialog.actions?.includes("submit") && typeof dialog.submitKey === "string") {
    return {
      token: dialog.expected.token,
      phase: "review",
      questionId: question.id,
      question: question.question,
      answers: dialog.answers?.[question.id] ?? [],
      controls: [{ op: "submit", label: "Submit answers" }],
    };
  }
  return null;
}
