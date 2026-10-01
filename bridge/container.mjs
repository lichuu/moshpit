import { lstat } from "node:fs/promises";

// The container image starts `moshpit bridge` before anyone has run setup.
// Exiting would crash-loop the container, and `docker exec` cannot reach a
// restarting container, so the bridge waits for setup to write its config.

const exists = (file) =>
  lstat(file).then(
    () => true,
    (error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );

/**
 * Resolves once MOSHPIT_CONFIG exists, or at once outside the container or
 * when no config is named. Returns false when `signal` aborts the wait.
 */
export async function waitForContainerConfig(env, { log = console.error, intervalMs = 2000, signal } = {}) {
  const file = env.MOSHPIT_CONFIG;
  if (env.MOSHPIT_SUPERVISOR !== "container" || !file || (await exists(file))) return true;
  log(`moshpit: waiting for ${file}. Run: docker compose exec moshpit moshpit setup`);
  while (!signal?.aborted) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, intervalMs);
      signal?.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
    });
    if (await exists(file)) return true;
  }
  return false;
}

/** The wait for `moshpit bridge`: docker stop's SIGTERM ends it, as it would end the bridge. */
export async function containerConfigReady() {
  const stop = new AbortController();
  const onSignal = () => stop.abort();
  process.once("SIGTERM", onSignal).once("SIGINT", onSignal);
  try {
    return await waitForContainerConfig(process.env, { signal: stop.signal });
  } finally {
    process.off("SIGTERM", onSignal).off("SIGINT", onSignal);
  }
}
