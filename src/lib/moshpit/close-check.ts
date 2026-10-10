import { useEffect, useState } from "react";
import { fetchChangesSummary, unsavedWork } from "@/lib/moshpit/changes";

/** What the Close dialog knows about the agent's checkout. */
export type CloseCheck =
  | { phase: "checking" }
  | { phase: "clear" }
  | { phase: "work"; found: string[] }
  | { phase: "unknown"; reason: string };

function describeFailure(error: unknown) {
  if (error instanceof TypeError) return "The bridge could not be reached.";
  return error instanceof Error && error.message ? error.message : "The check failed.";
}

/**
 * C11: one read of the checkout's unsaved work each time the dialog opens,
 * started as it appears. Nothing is kept between openings, and a read that is
 * still running when the dialog closes is abandoned, so a late answer can
 * never land on the next opening. Without a bridge URL (demo mode) there is
 * nothing to ask and the check is clear.
 */
export function useCloseCheck(active: boolean, url: string, agentId: string): CloseCheck {
  const [result, setResult] = useState<CloseCheck | null>(null);

  useEffect(() => {
    if (!active || !url) return;
    const controller = new AbortController();
    setResult(null);
    fetchChangesSummary(url, agentId, controller.signal).then(
      (summary) => {
        if (controller.signal.aborted) return;
        const found = unsavedWork(summary);
        setResult(found.length ? { phase: "work", found } : { phase: "clear" });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setResult({ phase: "unknown", reason: describeFailure(error) });
      },
    );
    return () => {
      controller.abort();
      setResult(null);
    };
  }, [active, url, agentId]);

  if (!active || !url) return { phase: "clear" };
  return result ?? { phase: "checking" };
}
