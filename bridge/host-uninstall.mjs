import { lstat, rm, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { parseHostConfig } from "./host-config.mjs";
import { parseProperties, parseServeStatus, runCommand, UNIT_NAME } from "./host-probe.mjs";
import { acquireLock } from "./host-setup.mjs";
import { bridgeTarget, planFromConfig, unitText } from "./host-steps.mjs";
import { CONTAINER_MESSAGE, EXIT, finish, Refusal, row } from "./host-update.mjs";
import { readPrivateFile } from "./private-files.mjs";

// `moshpit uninstall`: undoes what setup did on this host, and only that.
// Each part reads the host first, so a rerun changes nothing. Config, device
// state and the setup journal stay unless --purge.

const firstLine = (text) => text.trim().split("\n")[0] ?? "";

async function readOrNull(file, parse) {
  try {
    const text = await readPrivateFile(file, { maxBytes: 256 * 1024 });
    return text === null ? null : parse(text);
  } catch {
    return null;
  }
}

async function mustRun(ctx, name, ...args) {
  const result = await runCommand(ctx.runner, name, ...args);
  if (result.code !== 0) throw new Error(`${name} failed (${firstLine(result.stderr) || `exit ${result.code}`})`);
}

const unitShow = async (ctx) => parseProperties((await runCommand(ctx.runner, "unitShow", UNIT_NAME)).stdout);

/** Stops and disables the service, then removes its unit, unless the unit is not the one setup writes. */
async function removeService(ctx) {
  const text = await readPrivateFile(ctx.paths.unit, { maxBytes: 64 * 1024 }).catch(() => null);
  if (text !== null && text !== unitText(ctx.paths))
    return [row("service", "skipped", `${ctx.paths.unit} is not the unit setup writes; left alone`)];
  const rows = [];
  let unit = await unitShow(ctx);
  if (text === null && unit.LoadState !== "not-found") {
    // Setup's unit file is gone, yet a moshpit.service still loads: from
    // another unit directory, so it is someone else's.
    const fragment = (await runCommand(ctx.runner, "unitFragment", UNIT_NAME)).stdout.trim();
    if (fragment && fragment !== ctx.paths.unit)
      return [row("service", "skipped", `${UNIT_NAME} loads from ${fragment}, not the unit setup writes; left alone`)];
  }
  const running = !["inactive", "failed", undefined].includes(unit.ActiveState);
  if (unit.LoadState !== "not-found" && (unit.UnitFileState === "enabled" || running)) {
    await mustRun(ctx, "disableNow", UNIT_NAME);
    rows.push(row("service", "done", `${UNIT_NAME} stopped and disabled`));
  } else rows.push(row("service", "skipped", `${UNIT_NAME} is not enabled or running`));
  if (text !== null) await unlink(ctx.paths.unit);
  unit = await unitShow(ctx);
  if (unit.LoadState !== "not-found") {
    await mustRun(ctx, "daemonReload");
    rows.push(row("unit", "done", `${ctx.paths.unit} removed and systemd reloaded`));
  } else if (text === null) rows.push(row("unit", "skipped", `${ctx.paths.unit} is already gone`));
  else rows.push(row("unit", "done", `${ctx.paths.unit} removed`));
  return rows;
}

/** Removes the Serve route only if setup created it and it still points at this bridge. */
async function removeServeRoute(ctx, journal, config) {
  const entry = journal?.steps?.["serve-configured"];
  const port = entry?.previous?.port;
  if (!Number.isInteger(port)) return row("serve", "skipped", "the setup journal records no Serve route");
  const status = await runCommand(ctx.runner, "serveStatus");
  if (status.code !== 0) throw new Error(`tailscale serve status failed (${firstLine(status.stderr) || `exit ${status.code}`})`);
  const target = parseServeStatus(status.stdout).get(port);
  if (target === undefined) return row("serve", "skipped", `Serve port ${port} serves nothing`);
  if (!entry.at || entry.previous.target !== null)
    return row("serve", "skipped", `Serve port ${port} proxied to ${entry.previous.target ?? "something"} before setup, so setup did not create it; left alone`);
  if (!config || target !== bridgeTarget(planFromConfig(config)))
    return row("serve", "skipped", `Serve port ${port} now proxies to ${target}, not this bridge; left alone`);
  await mustRun(ctx, "serveOff", port);
  return row("serve", "done", `Serve port ${port} no longer proxies to ${target}`);
}

/** Disables lingering only if setup's journal says setup enabled it. */
async function removeLinger(ctx, journal) {
  const shown = await runCommand(ctx.runner, "lingerShow", ctx.user);
  if (shown.code !== 0 || shown.stdout.trim() !== "yes") return row("linger", "skipped", `lingering is off for ${ctx.user}`);
  const entry = journal?.steps?.persistence;
  if (!entry?.at || entry.previous?.linger !== false) return row("linger", "skipped", `lingering was not enabled by setup; left on for ${ctx.user}`);
  const result = await runCommand(ctx.runner, "lingerDisable", ctx.user);
  if (result.code !== 0)
    return row("linger", "blocked", `loginctl disable-linger was refused (${firstLine(result.stderr) || `exit ${result.code}`}). Run: sudo loginctl disable-linger ${ctx.user}`);
  return row("linger", "done", `lingering disabled for ${ctx.user}`);
}

/** The releases, `current`, the staging copy and the update journal, which only describes releases. */
async function removeReleases(ctx) {
  const targets = [ctx.paths.current, ctx.paths.releases, ctx.paths.staging, ctx.paths.updateJournal];
  const present = (await Promise.all(targets.map((file) => lstat(file).then(() => file, () => null)))).filter(Boolean);
  for (const file of present) await rm(file, { recursive: true, force: true });
  await rmdir(ctx.paths.data).catch(() => {});
  return present.length ? row("releases", "done", `removed ${present.join(", ")}`) : row("releases", "skipped", "no releases installed");
}

async function purge(ctx) {
  const gone = [];
  for (const target of [ctx.paths.config, ctx.paths.state, ctx.paths.data]) {
    const existed = await rm(target, { recursive: true }).then(() => true, (error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
    if (existed) gone.push(target);
  }
  await rmdir(path.dirname(ctx.paths.config)).catch(() => {});
  return row("purge", gone.length ? "done" : "skipped", gone.length ? `deleted ${gone.join(", ")}` : "no config or state left");
}

/** `moshpit uninstall [--purge] [--yes]`. Returns `{ result, exitCode }` like setup. */
export async function runUninstall(ctx) {
  const rows = [];
  try {
    if (ctx.env.MOSHPIT_SUPERVISOR === "container")
      throw new Refusal(EXIT.container, "container", `${CONTAINER_MESSAGE} To uninstall, remove the container, and its volumes if you want the state gone.`);
    if (ctx.options.purge && !ctx.options.yes) {
      const question = `Delete moshpit's config (${ctx.paths.config}) and all device state (${ctx.paths.state})? Approved devices cannot be recovered. [y/N] `;
      if (!ctx.isTTY) throw new Refusal(EXIT.confirmBlocked, "confirm", "--purge deletes the config and all device state, so without a terminal it needs --yes. Nothing was changed.");
      if (!(await ctx.prompt(question))) throw new Refusal(EXIT.confirmBlocked, "confirm", "Declined; nothing was changed.");
    }
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    rows.push(row(error.id, "failed", error.message));
    return finish({ state: "refused", exitCode: error.exitCode }, rows);
  }

  const lock = await acquireLock(ctx.paths.lock, ctx.isAlive).catch((error) => {
    // No state directory means nothing of setup's is left to race with.
    if (error.code === "ENOENT") return { release: async () => {} };
    throw error;
  });
  if (!lock.release) {
    rows.push(row("lock", "failed", `${lock.heldBy ? `process ${lock.heldBy}` : "another run"} holds ${ctx.paths.lock}; wait for it to finish.`));
    return finish({ state: "refused", exitCode: EXIT.locked }, rows);
  }
  try {
    const journal = await readOrNull(ctx.paths.journal, JSON.parse);
    const config = await readOrNull(ctx.paths.config, parseHostConfig);
    rows.push(...(await removeService(ctx)));
    rows.push(await removeServeRoute(ctx, journal, config));
    rows.push(await removeLinger(ctx, journal));
    rows.push(await removeReleases(ctx));
  } finally {
    await lock.release();
  }
  if (ctx.options.purge) rows.push(await purge(ctx));
  const blocked = rows.some((entry) => entry.status === "blocked");
  const outcome = { state: ctx.options.purge ? "purged" : "uninstalled", exitCode: blocked ? EXIT.lingerBlocked : EXIT.ok };
  if (!ctx.options.purge)
    outcome.next = `The config (${ctx.paths.config}) and device state (${ctx.paths.state}) are kept. A release's setup reinstalls with them; moshpit uninstall --purge deletes them.`;
  return finish(outcome, rows);
}
