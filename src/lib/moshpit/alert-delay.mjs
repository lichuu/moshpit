// C13: herdr waits `ui.toast.delay_seconds` before an alert and sends it only
// if the pane is still in the state that earned it. The bridge holds push
// this way and the app holds its foreground cue the same way, so both import
// this one rule.

/**
 * Holds alerts and releases each once its delay has passed, if `holds(item,
 * status)` says the agent is still in the state that earned it. An agent that
 * left that state, or left the snapshot, drops its alert unsent. A second
 * alert for an agent replaces the first and restarts its delay.
 */
export function createAlertDelay(holds) {
  const pending = new Map();
  return {
    step(candidates, agents, delayMs, now) {
      for (const item of candidates) pending.set(item.id, { item, due: now + delayMs });
      const status = new Map(agents.map((agent) => [agent.id, agent.status]));
      const ready = [];
      for (const [id, { item, due }] of pending) {
        if (!holds(item, status.get(id))) pending.delete(id);
        else if (due <= now) {
          pending.delete(id);
          ready.push(item);
        }
      }
      return ready;
    },
    clear() {
      pending.clear();
    },
    get size() {
      return pending.size;
    },
  };
}
