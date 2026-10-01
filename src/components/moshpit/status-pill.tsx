import type { AgentStatus } from "@/lib/moshpit/types";
import { cn } from "@/lib/utils";

const LABEL: Record<AgentStatus, string> = {
  blocked: "blocked",
  working: "working",
  done: "done",
  idle: "idle",
  unknown: "unknown",
};

const TONE: Record<AgentStatus, string> = {
  blocked: "bg-blocked/10 text-blocked",
  working: "bg-working/10 text-working",
  done: "bg-done/10 text-done",
  idle: "bg-surface-2 text-muted shadow-border",
  unknown: "bg-surface-2 text-muted shadow-border",
};

export function StatusPill({
  status,
  className,
}: {
  status: AgentStatus;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "ear-tag inline-flex items-center pr-2 py-1 text-2xs font-medium",
        TONE[status],
        className,
      )}
    >
      {LABEL[status]}
    </span>
  );
}
