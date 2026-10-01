export type QuickReplyGroup = "agent" | "shell";

export type QuickReply = {
  id: string;
  label: string;
  text: string;
};

const CATALOG: Record<QuickReplyGroup, readonly QuickReply[]> = {
  agent: [
    { id: "yes", label: "yes", text: "yes" },
    { id: "no", label: "no", text: "no" },
    { id: "continue", label: "continue", text: "continue" },
    { id: "commit-and-push", label: "commit and push", text: "commit and push" },
    { id: "retry", label: "retry", text: "retry" },
    { id: "skip", label: "skip", text: "skip" },
  ],
  shell: [
    { id: "y", label: "y", text: "y" },
    { id: "n", label: "n", text: "n" },
  ],
};

export function quickRepliesFor(kind: string | undefined): readonly QuickReply[] {
  return CATALOG[kind === "shell" ? "shell" : "agent"];
}
