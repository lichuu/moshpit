import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { MAX_CONFIG_BYTES, parseHostConfig } from "./host-config.mjs";
import { parseProperties, runCommand, UNIT_NAME } from "./host-probe.mjs";
import {
  devicesVersion,
  incompatibility,
  pruneReleases,
  readCurrent,
  readUpdateJournal,
  RELEASE_VERSION,
  releaseInfoOf,
  releaseInstalled,
  switchCurrent,
  writeUpdateJournal,
} from "./host-releases.mjs";
import { acquireLock } from "./host-setup.mjs";
import { answersAuthInfo, planFromConfig } from "./host-steps.mjs";
import { readPrivateFile } from "./private-files.mjs";
import { checkRelease, ManifestMismatch } from "./release-manifest.mjs";
import { DEFAULT_RELEASE_API, downloadRelease, githubToken, ReleaseSourceError } from "./release-source.mjs";

// `moshpit update` and `moshpit rollback`: a journaled walk that moves
// `current` to another release, restarts the service and checks it, and
// switches back if the new release does not come up. Config, device state and
// setup's journal are never touched.

export const EXIT = {
  ok: 0,
  failed: 1,
  usage: 2,
  confirmBlocked: 30,
  locked: 31,
  lingerBlocked: 32,
  conflict: 33,
  notInstalled: 40,
  // 41 was an unsigned running build; releases are no longer signed.
  source: 42,
  // The download does not match its manifest, or the staged copy reports another version.
  verification: 43,
  downgrade: 44,
  incompatible: 45,
  noPrevious: 46,
  container: 47,
  reverted: 48,
  revertFailed: 49,
};

/** A reason to stop before anything changes. */
export class Refusal extends Error {
  constructor(exitCode, id, message) {
    super(message);
    this.exitCode = exitCode;
    this.id = id;
  }
}

/** A step that ran without taking effect. Before the switch the attempt is dropped; after it, reverted. */
class StepFailed extends Error {
  constructor(message, exitCode = EXIT.failed) {
    super(message);
    this.exitCode = exitCode;
  }
}

export const row = (id, status, detail) => ({ id, status, detail });
const firstLine = (text) => text.trim().split("\n")[0] ?? "";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fileSha256 = (file) => readFile(file).then(sha256, () => null);
const stagingFile = (ctx, version) => path.join(ctx.paths.staging, version, "moshpit");

export const CONTAINER_MESSAGE =
  "This moshpit runs in a container, where updates are new image tags: pull the new tag and recreate the container. Device state stays on its volume. Nothing was changed.";

/** What update and rollback need from an installed host, or a refusal before any change. */
async function readInstall(ctx) {
  const current = await readCurrent(ctx.paths);
  if (current.target !== null && !current.version)
    throw new Refusal(EXIT.conflict, "current", `${ctx.paths.current} points to ${current.target}, which is not a release setup installed. Nothing was changed.`);
  let config = null;
  try {
    const text = await readPrivateFile(ctx.paths.config, { maxBytes: MAX_CONFIG_BYTES });
    if (text !== null) config = parseHostConfig(text);
  } catch (error) {
    throw new Refusal(EXIT.notInstalled, "config", `${ctx.paths.config} is not a usable config: ${error.message}. Nothing was changed.`);
  }
  if (!current.version || !config)
    throw new Refusal(EXIT.notInstalled, "installed", "moshpit is not installed here. Install a release with its setup command first.");
  ctx.plan = planFromConfig(config);
  let onDisk;
  try {
    onDisk = await devicesVersion(config.stateDir);
  } catch (error) {
    throw new Refusal(EXIT.incompatible, "state", `The device state cannot be read (${error.message}). Nothing was changed.`);
  }
  // The installed release may be newer than a stale copy running this
  // command, and update must not move current below it either.
  const currentSerial = await releaseInfoOf(ctx.runner, ctx.paths.currentExecutable).then(
    (info) => (Number.isInteger(info.releaseSerial) ? info.releaseSerial : null),
    () => null,
  );
  return { current: current.version, currentSerial, configSchemaVersion: config.schemaVersion, devicesVersion: onDisk };
}

/**
 * Whether a checked manifest may replace the running release:
 * `{ upToDate }`, `{ refuse: { exitCode, message } }` or `{ ok }`.
 */
export function admitRelease(manifest, { running, host }) {
  const refuse = (exitCode, message) => ({ refuse: { exitCode, message } });
  const name = `moshpit-linux-${running.arch}`;
  if (manifest.name !== name || manifest.arch !== running.arch)
    return refuse(EXIT.incompatible, `The release manifest describes ${manifest.name} for ${manifest.arch}, not ${name}.`);
  if (typeof manifest.version !== "string" || !RELEASE_VERSION.test(manifest.version))
    return refuse(EXIT.incompatible, `The release version ${JSON.stringify(manifest.version)} cannot name a release directory.`);
  if (!Number.isInteger(manifest.releaseSerial)) return refuse(EXIT.incompatible, "The release manifest has no release serial.");
  if (manifest.version === running.version && manifest.releaseSerial === running.releaseSerial) return { upToDate: true };
  const installedIsNewer = Number.isInteger(host.currentSerial) && host.currentSerial > running.releaseSerial;
  const floor = installedIsNewer ? { version: host.current, serial: host.currentSerial, what: "the installed release" } : { version: running.version, serial: running.releaseSerial, what: "this release" };
  if (manifest.releaseSerial <= floor.serial)
    return refuse(
      EXIT.downgrade,
      `Release ${manifest.version} (serial ${manifest.releaseSerial}) is not newer than ${floor.what}, ${floor.version} (serial ${floor.serial}). Update never downgrades; use moshpit rollback to return to the previous release.`,
    );
  const why = incompatibility(manifest, host);
  if (why) return refuse(EXIT.incompatible, `Release ${manifest.version} cannot run on this host: ${why}.`);
  return { ok: true };
}

const fetchRelease = (ctx, tag) =>
  downloadRelease({ fetch: ctx.fetch, api: ctx.env.MOSHPIT_RELEASE_API || DEFAULT_RELEASE_API, arch: ctx.running.info.arch, tag, token: githubToken(ctx.env) });

/** Downloads, checks and admits the requested release, all before any change and before anything downloaded runs. */
async function resolveUpdate(ctx, host) {
  let fetched;
  try {
    fetched = await fetchRelease(ctx, ctx.options.version);
  } catch (error) {
    if (error instanceof ReleaseSourceError) throw new Refusal(EXIT.source, "release", `${error.message}. Nothing was changed.`);
    throw error;
  }
  const manifest = checked(fetched);
  const admitted = admitRelease(manifest, { running: ctx.running.info, host });
  if (admitted.refuse) throw new Refusal(admitted.refuse.exitCode, "release", `${admitted.refuse.message} Nothing was changed.`);
  return {
    download: fetched,
    manifest,
    upToDate: admitted.upToDate,
    detail: `${fetched.tag}: ${manifest.version} (serial ${manifest.releaseSerial}), SHA-256 ${manifest.sha256} matches its manifest`,
  };
}

function checked(fetched) {
  try {
    return checkRelease({ manifestBytes: fetched.manifest, binaryBytes: fetched.binary });
  } catch (error) {
    if (error instanceof ManifestMismatch)
      throw new Refusal(EXIT.verification, "verify", `Release ${fetched.tag} does not match its manifest (${error.message}). Nothing was changed.`);
    throw error;
  }
}

/** A resumed update whose staging copy is gone downloads the same release again. */
async function downloadAgain(ctx) {
  const { attempt } = ctx;
  let fetched;
  try {
    fetched = await fetchRelease(ctx, attempt.tag);
    if (checked(fetched).sha256 !== attempt.manifest.sha256)
      throw new StepFailed(`Release ${attempt.tag} changed since this update began; rerun moshpit update.`, EXIT.verification);
  } catch (error) {
    if (error instanceof ReleaseSourceError) throw new StepFailed(error.message, EXIT.source);
    if (error instanceof Refusal) throw new StepFailed(error.message, error.exitCode);
    throw error;
  }
  return fetched.binary;
}

async function reportedVersion(ctx, file) {
  try {
    return (await releaseInfoOf(ctx.runner, file)).version;
  } catch {
    return null;
  }
}

/**
 * Each step reads the host in `isDone(ctx, version)` and changes it in
 * `apply(ctx, version)`. `reverts` marks the steps after which a failure
 * switches back rather than dropping the attempt.
 */
const STEPS = {
  fetched: {
    id: "fetched",
    describe: (ctx, version) => `release ${version} downloaded and matched to its manifest`,
    async isDone(ctx, version) {
      const want = ctx.attempt.manifest.sha256;
      return (await fileSha256(ctx.paths.release(version))) === want || (await fileSha256(stagingFile(ctx, version))) === want;
    },
    async apply(ctx, version) {
      const bytes = ctx.download?.binary ?? (await downloadAgain(ctx));
      const file = stagingFile(ctx, version);
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(temporary, bytes, { mode: 0o700 });
      await rename(temporary, file);
    },
  },
  staged: {
    id: "staged",
    describe: (ctx, version) => `${ctx.paths.release(version)} installed, and it reports version ${version}`,
    async isDone(ctx, version) {
      const file = ctx.paths.release(version);
      const info = await stat(file).catch(() => null);
      if (!info?.isFile() || (info.mode & 0o777) !== 0o755) return false;
      if ((await fileSha256(file)) !== ctx.attempt.manifest.sha256) return false;
      return (await reportedVersion(ctx, file)) === version;
    },
    async apply(ctx, version) {
      const file = ctx.paths.release(version);
      // fetched is skipped, and nothing is staged, when a verified copy is already installed.
      if ((await fileSha256(file)) === ctx.attempt.manifest.sha256) await chmod(file, 0o755);
      else {
        await mkdir(path.dirname(file), { recursive: true, mode: 0o755 });
        const temporary = `${file}.${randomUUID()}.tmp`;
        await copyFile(stagingFile(ctx, version), temporary);
        await chmod(temporary, 0o755);
        await rename(temporary, file);
      }
      const reported = await reportedVersion(ctx, file);
      if (reported !== version)
        throw new StepFailed(`${file} reports version ${JSON.stringify(reported)}, not ${version}, so it was not switched to.`, EXIT.verification);
    },
  },
  switched: {
    id: "switched",
    reverts: true,
    describe: (ctx, version) => `${ctx.paths.current} points to releases/${version}`,
    isDone: async (ctx, version) => (await readCurrent(ctx.paths)).version === version,
    apply: (ctx, version) => switchCurrent(ctx.paths, version),
  },
  restarted: {
    id: "restarted",
    reverts: true,
    describe: (ctx, version) => `${UNIT_NAME} restarted and running ${version}`,
    async isDone(ctx, version) {
      const unit = parseProperties((await runCommand(ctx.runner, "unitMain", UNIT_NAME)).stdout);
      const pid = Number(unit.MainPID);
      if (unit.ActiveState !== "active" || !(pid > 0)) return false;
      const running = await ctx.readProcExe(pid).catch(() => null);
      return running !== null && running === (await realpath(ctx.paths.release(version)).catch(() => null));
    },
    async apply(ctx, version) {
      const result = await runCommand(ctx.runner, "restart", UNIT_NAME);
      if (result.code !== 0) throw new StepFailed(`systemctl --user restart ${UNIT_NAME} failed (${firstLine(result.stderr) || `exit ${result.code}`})`);
      // The restart returns at the fork, before the new main process execs the release.
      for (let attempt = 1; attempt < ctx.verifyAttempts; attempt++) {
        if (await STEPS.restarted.isDone(ctx, version)) return;
        await ctx.sleep(ctx.verifyDelayMs);
      }
    },
  },
  verified: {
    id: "verified",
    reverts: true,
    check: true,
    describe: (ctx) => `${ctx.plan.publicOrigin}/api/auth-info answers through Tailscale`,
    isDone: (ctx) => answersAuthInfo(ctx),
    async apply(ctx) {
      throw new StepFailed(`${ctx.plan.publicOrigin}/api/auth-info did not answer with 200 and a protocol. Check: journalctl --user -u ${UNIT_NAME}`);
    },
  },
};

/** The walk for each attempt kind, and the walk back to where it started. */
export const WALKS = {
  update: [STEPS.fetched, STEPS.staged, STEPS.switched, STEPS.restarted, STEPS.verified],
  rollback: [STEPS.switched, STEPS.restarted, STEPS.verified],
  revert: [STEPS.switched, STEPS.restarted, STEPS.verified],
};

const journalTime = (ctx) => new Date(ctx.now()).toISOString();

async function walk(ctx, journal, steps, version, key, rows) {
  const done = (ctx.attempt[key] ??= {});
  for (const step of steps) {
    const id = key === "revert" ? `${step.id}-back` : step.id;
    if (await step.isDone(ctx, version)) {
      if (!done[step.id]) {
        done[step.id] = { at: journalTime(ctx) };
        await writeUpdateJournal(ctx.paths, journal);
      }
      rows.push(step.check ? row(id, "done", step.describe(ctx, version)) : row(id, "skipped", `already in place: ${step.describe(ctx, version)}`));
      continue;
    }
    let failure = null;
    try {
      await step.apply(ctx, version);
      if (!(await step.isDone(ctx, version))) failure = new StepFailed(`${step.describe(ctx, version)}: not in place after it ran`);
    } catch (error) {
      if (!(error instanceof StepFailed)) throw error;
      failure = error;
    }
    if (failure) {
      rows.push(row(id, "failed", failure.message));
      return { failed: step, exitCode: failure.exitCode };
    }
    done[step.id] = { at: journalTime(ctx) };
    await writeUpdateJournal(ctx.paths, journal);
    rows.push(row(id, "done", step.describe(ctx, version)));
  }
  return {};
}

/** Keeps the current release and the retained previous one, and drops the rest and the staging copy. */
async function tidy(ctx, journal) {
  const keep = [(await readCurrent(ctx.paths)).version, journal.previous?.version].filter(Boolean);
  return pruneReleases(ctx.paths, keep);
}

async function settle(ctx, journal, outcome) {
  const { attempt } = journal;
  // A finished switch keeps the release it left, so rollback can return to it.
  if (outcome === "done") journal.previous = { version: attempt.from };
  journal.last = { kind: attempt.kind, from: attempt.from, to: attempt.to, outcome, at: journalTime(ctx) };
  journal.attempt = null;
  await writeUpdateJournal(ctx.paths, journal);
  await tidy(ctx, journal);
}

const SUCCESS = { update: "updated", rollback: "rolled back" };

async function runAttempt(ctx, journal, rows) {
  const { attempt } = journal;
  ctx.attempt = attempt;
  if (!attempt.revert) {
    const forward = await walk(ctx, journal, WALKS[attempt.kind], attempt.to, "steps", rows);
    if (!forward.failed) {
      await settle(ctx, journal, "done");
      return { state: SUCCESS[attempt.kind], exitCode: EXIT.ok };
    }
    if (!forward.failed.reverts) {
      await settle(ctx, journal, "abandoned");
      return { state: "refused", exitCode: forward.exitCode, next: `Nothing was switched; ${attempt.from} still runs.` };
    }
    attempt.revert = {};
    await writeUpdateJournal(ctx.paths, journal);
  }
  const back = await walk(ctx, journal, WALKS.revert, attempt.from, "revert", rows);
  if (back.failed)
    return {
      state: "revert failed",
      exitCode: EXIT.revertFailed,
      next: `Neither ${attempt.to} nor ${attempt.from} came up. Check journalctl --user -u ${UNIT_NAME}, then rerun moshpit ${attempt.kind} to retry switching back to ${attempt.from}.`,
    };
  await settle(ctx, journal, "reverted");
  return {
    state: "reverted",
    exitCode: EXIT.reverted,
    next: `${attempt.to} did not pass its health check, so ${attempt.from} runs again. Check journalctl --user -u ${UNIT_NAME} for why.`,
  };
}

/** Runs `body` under the installer lock, turning refusals into a result. */
async function locked(ctx, rows, body) {
  try {
    if (ctx.env.MOSHPIT_SUPERVISOR === "container") throw new Refusal(EXIT.container, "container", CONTAINER_MESSAGE);
    const host = await readInstall(ctx);
    const lock = await acquireLock(ctx.paths.lock, ctx.isAlive);
    if (!lock.release)
      throw new Refusal(EXIT.locked, "lock", `${lock.heldBy ? `process ${lock.heldBy}` : "another run"} holds ${ctx.paths.lock}; wait for it to finish.`);
    try {
      return await body(host, await readUpdateJournal(ctx.paths));
    } finally {
      await lock.release();
    }
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    rows.push(row(error.id, "failed", error.message));
    return { state: "refused", exitCode: error.exitCode };
  }
}

function unfinished(journal, kind) {
  const { attempt } = journal;
  if (!attempt || attempt.kind === kind) return;
  throw new Refusal(EXIT.conflict, "attempt", `A ${attempt.kind} from ${attempt.from} to ${attempt.to} is unfinished. Rerun moshpit ${attempt.kind} to finish it first.`);
}

/** `moshpit update`. Returns `{ result, exitCode }` like setup. */
export async function runUpdate(ctx) {
  ctx.command = "update";
  const rows = [];
  const outcome = await locked(ctx, rows, async (host, journal) => {
    unfinished(journal, "update");
    if (journal.attempt) rows.push(row("resume", "done", `resuming the update from ${journal.attempt.from} to ${journal.attempt.to}`));
    else {
      const resolved = await resolveUpdate(ctx, host);
      rows.push(row("release", "done", resolved.detail));
      if (resolved.upToDate) {
        await tidy(ctx, journal);
        return { state: "up to date", exitCode: EXIT.ok };
      }
      const { manifest } = resolved;
      journal.attempt = { kind: "update", from: host.current, to: manifest.version, tag: resolved.download.tag, manifest, steps: {} };
      ctx.download = resolved.download;
      await writeUpdateJournal(ctx.paths, journal);
    }
    return runAttempt(ctx, journal, rows);
  });
  return finish(outcome, rows);
}

/** `moshpit rollback`: back to the retained previous release, if it can read this host's state. */
export async function runRollback(ctx) {
  ctx.command = "rollback";
  const rows = [];
  const outcome = await locked(ctx, rows, async (host, journal) => {
    unfinished(journal, "rollback");
    if (journal.attempt) rows.push(row("resume", "done", `resuming the rollback from ${journal.attempt.from} to ${journal.attempt.to}`));
    else {
      const previous = journal.previous?.version;
      if (!previous || previous === host.current || !(await releaseInstalled(ctx.paths, previous)))
        throw new Refusal(EXIT.noPrevious, "previous", "No previous release is kept on this host, so there is nothing to roll back to. Nothing was changed.");
      let info;
      try {
        info = await releaseInfoOf(ctx.runner, ctx.paths.release(previous));
      } catch (error) {
        throw new Refusal(EXIT.incompatible, "previous", `Release ${previous} could not say which config and state it reads (${error.message}). Nothing was changed.`);
      }
      const why = info.version === previous ? incompatibility(info, host) : `it reports version ${info.version}`;
      if (why)
        throw new Refusal(
          EXIT.incompatible,
          "previous",
          `Release ${previous} cannot run on this host: ${why}. Rollback never restores an older device database, so it stays on ${host.current}. Nothing was changed.`,
        );
      rows.push(row("previous", "done", `${previous} reads this host's config and device state`));
      journal.attempt = { kind: "rollback", from: host.current, to: previous, steps: {} };
      await writeUpdateJournal(ctx.paths, journal);
    }
    return runAttempt(ctx, journal, rows);
  });
  return finish(outcome, rows);
}

export function finish(outcome, rows) {
  const result = { ok: outcome.exitCode === EXIT.ok, state: outcome.state, steps: rows };
  if (outcome.next) result.next = outcome.next;
  return { result, exitCode: outcome.exitCode };
}

