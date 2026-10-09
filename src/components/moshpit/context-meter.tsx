import { contextLabel, contextLevel, contextPercent, formatTokens, limitLine, type ContextLevel } from "@/lib/moshpit/context-meter";
import type { ContextUsage } from "@/lib/moshpit/session-protocol";
import { cn } from "@/lib/utils";

// Amber reuses the palette's attention colour. The theme has no red of its
// own; destructive controls elsewhere use Tailwind's, so the meter does too.
const TEXT: Record<ContextLevel, string> = { ok: "text-subtle", unknown: "text-subtle", warn: "text-blocked", high: "text-red-500" };
const FILL: Record<ContextLevel, string> = { ok: "bg-muted", unknown: "bg-muted", warn: "bg-blocked", high: "bg-red-500" };

function Bar({ percent, level, className }: { percent: number; level: ContextLevel; className?: string }) {
  return (
    <span aria-hidden="true" className={cn("relative h-1 shrink-0 overflow-hidden rounded-full bg-border", className)}>
      <span className={cn("absolute inset-y-0 left-0 rounded-full", FILL[level])} style={{ width: `${percent}%` }} />
    </span>
  );
}

/**
 * The quiet line under the composer. It owns a fixed one-line slot, so the
 * input above never moves when a measurement arrives or goes. With a capacity
 * it is a meter (bar plus "62% of context"); without one it is plain text and
 * never a percentage.
 */
export function ContextMeter({ context, reserve }: { context?: ContextUsage; reserve: boolean }) {
  if (!reserve) return null;
  const level = context ? contextLevel(context) : undefined;
  const percent = context ? contextPercent(context) : undefined;
  const limits = context ? limitLine(context.limits) : undefined;
  return (
    <div className="composer-meter mt-1 flex h-4 shrink-0 items-center justify-between gap-3 px-2 text-2xs tabular-nums" data-testid="context-meter-slot">
      {context && level ? (
        percent !== undefined ? (
          <div
            role="meter"
            aria-label="Context use"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-valuetext={contextLabel(context)}
            data-level={level}
            className={cn("flex min-w-0 items-center gap-2", TEXT[level])}
          >
            <Bar percent={percent} level={level} className="w-12" />
            <span className="truncate">{contextLabel(context)}</span>
          </div>
        ) : (
          <p data-testid="context-meter" data-level={level} className={cn("min-w-0 truncate", TEXT[level])}>{contextLabel(context)}</p>
        )
      ) : null}
      {limits ? <p data-testid="context-limits" className="min-w-0 truncate text-subtle">{limits}</p> : null}
    </div>
  );
}

/**
 * The same figure in a header or list row: a short bar and a number, or just
 * the token count when the window size is unknown. The full wording rides the
 * accessible name.
 */
export function ContextBadge({ context, className }: { context: ContextUsage; className?: string }) {
  const level = contextLevel(context);
  const percent = contextPercent(context);
  const label = contextLabel(context);
  return (
    <span
      role={percent === undefined ? undefined : "meter"}
      aria-label={percent === undefined ? undefined : "Context use"}
      aria-valuemin={percent === undefined ? undefined : 0}
      aria-valuemax={percent === undefined ? undefined : 100}
      aria-valuenow={percent}
      aria-valuetext={percent === undefined ? undefined : label}
      title={label}
      data-level={level}
      className={cn("inline-flex shrink-0 items-center gap-1.5 text-2xs tabular-nums", TEXT[level], className)}
    >
      {percent === undefined ? (
        <>{formatTokens(context.used)} tokens</>
      ) : (
        <>
          <Bar percent={percent} level={level} className="w-6" />
          {percent}%
        </>
      )}
    </span>
  );
}
