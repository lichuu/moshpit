import { useState } from "react";
import { useMoshpitStore } from "@/lib/moshpit/store";

/**
 * What a pending rename, close or shell-open acts on. A pane ID alone is not
 * enough: two hosts can both have a `w1:p2`, so the host is part of the key.
 */
export type ActionTarget = { hostId: string | null; id: string };

const sameTarget = (a: ActionTarget, b: ActionTarget | null) =>
  b !== null && a.hostId === b.hostId && a.id === b.id;

/**
 * State for an action that is only meaningful for one pane on one host. It
 * reads as null the moment `current` is anything else, and is cleared in the
 * same render, so switching agent or host cannot leave a confirmation or a
 * half-typed rename armed for a pane the user is no longer looking at.
 */
export function useBoundAction<T extends ActionTarget>(
  current: ActionTarget | null,
) {
  const [pending, setPending] = useState<T | null>(null);
  if (pending && !sameTarget(pending, current)) {
    setPending(null);
    return [null, setPending] as const;
  }
  return [pending, setPending] as const;
}

/**
 * Re-reads the store at commit time: true only while `target` is still the
 * pane the detail view shows on the host that is still connected.
 */
export function targetIsCurrent(target: ActionTarget): boolean {
  const s = useMoshpitStore.getState();
  if (s.connectedHostId !== target.hostId) return false;
  if (s.selectedShellId) return s.selectedShellId === target.id;
  const agent = s.agents.find((a) => a.id === s.selectedAgentId) ?? s.agents[0];
  return agent?.id === target.id;
}
