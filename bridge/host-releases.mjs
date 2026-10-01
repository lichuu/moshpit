import { randomUUID } from "node:crypto";
import { readdir, readlink, rename, rm, stat, symlink } from "node:fs/promises";
import path from "node:path";
import { MAX_STATE_BYTES, READABLE_VERSIONS, STATE_FILE, STATE_VERSION } from "./devices.mjs";
import { runCommand } from "./host-probe.mjs";
import { unwrapVersion } from "./json-output.mjs";
import { readPrivateFile, writePrivateFile } from "./private-files.mjs";

// The installed releases: the versioned directories under releases/, the
// `current` link the service runs, and the update journal that names the
// retained previous release.

export const UPDATE_JOURNAL_SCHEMA_VERSION = 1;
const MAX_UPDATE_JOURNAL_BYTES = 256 * 1024;
const MAX_RELEASE_INFO_BYTES = 64 * 1024;

/** A version that can name a directory under releases/. */
export const RELEASE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

/** The state versions a checkout reads and writes; a release records its own in release.json. */
export const SOURCE_STATE_VERSIONS = Object.freeze({ devices: { write: STATE_VERSION, read: [...READABLE_VERSIONS] } });

const releaseLink = (version) => path.join("releases", version);

/** The version `current` points at, or null when it is missing or not a link into releases/. */
export async function readCurrent(paths) {
  const target = await readlink(paths.current).catch((error) => {
    if (error.code === "ENOENT" || error.code === "EINVAL") return null;
    throw error;
  });
  if (target === null) return { version: null, target: null };
  const version = target.startsWith("releases/") ? target.slice("releases/".length) : null;
  return { version: version && RELEASE_VERSION.test(version) ? version : null, target };
}

/** Points `current` at releases/<version> with one rename, so the service never sees it missing. */
export async function switchCurrent(paths, version) {
  const temporary = `${paths.current}.${randomUUID()}.tmp`;
  await symlink(releaseLink(version), temporary);
  try {
    await rename(temporary, paths.current);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function releaseInstalled(paths, version) {
  try {
    return (await stat(paths.release(version))).isFile();
  } catch {
    return false;
  }
}

/**
 * `{schemaVersion, previous, attempt, last}`. `previous` is the retained
 * release `rollback` returns to; `attempt` is an update or rollback that has
 * not finished.
 */
export async function readUpdateJournal(paths) {
  const text = await readPrivateFile(paths.updateJournal, { maxBytes: MAX_UPDATE_JOURNAL_BYTES });
  if (text === null) return { schemaVersion: UPDATE_JOURNAL_SCHEMA_VERSION, previous: null, attempt: null };
  const journal = JSON.parse(text);
  if (journal?.schemaVersion !== UPDATE_JOURNAL_SCHEMA_VERSION)
    throw new Error(`${paths.updateJournal} is not an update journal this release reads; move it aside, then rerun`);
  return journal;
}

export const writeUpdateJournal = (paths, journal) => writePrivateFile(paths.updateJournal, `${JSON.stringify(journal, null, 2)}\n`);

/** Removes every release but the ones named, and the staging directory. */
export async function pruneReleases(paths, keep) {
  const removed = [];
  for (const entry of await readdir(paths.releases).catch(() => [])) {
    if (keep.includes(entry)) continue;
    await rm(path.join(paths.releases, entry), { recursive: true, force: true });
    removed.push(entry);
  }
  await rm(paths.staging, { recursive: true, force: true });
  return removed;
}

/** The device state version on disk, or null when there is no device state yet. */
export async function devicesVersion(stateDir) {
  const text = await readPrivateFile(path.join(stateDir, STATE_FILE), { maxBytes: MAX_STATE_BYTES });
  if (text === null) return null;
  const { version } = JSON.parse(text);
  if (!Number.isInteger(version)) throw new Error(`${path.join(stateDir, STATE_FILE)} has no integer version`);
  return version;
}

/**
 * Why a release cannot run on this host's config and state, or null when it
 * can. `info` is a release.json or manifest.
 */
export function incompatibility(info, { configSchemaVersion, devicesVersion: onDisk }) {
  if (info.configSchemaVersion !== configSchemaVersion)
    return `it reads config schema ${info.configSchemaVersion ?? "unknown"}, and this host's config is schema ${configSchemaVersion}`;
  const read = info.stateVersions?.devices?.read;
  if (!Array.isArray(read)) return "it does not declare which device state versions it reads";
  if (onDisk !== null && !read.includes(onDisk))
    return `it reads device state versions ${read.join(", ")}, and this host's devices.json is version ${onDisk}`;
  return null;
}

/** An executable's release.json, from `<executable> version --json`. */
export async function releaseInfoOf(runner, executable) {
  const result = await runCommand(runner, "releaseInfo", executable);
  if (result.code !== 0) throw new Error(`${executable} version --json exited ${result.code}`);
  if (result.stdout.length > MAX_RELEASE_INFO_BYTES) throw new Error(`${executable} version --json printed too much`);
  const info = unwrapVersion(JSON.parse(result.stdout));
  if (typeof info?.version !== "string") throw new Error(`${executable} version --json named no version`);
  return info;
}

/** `moshpit version`: the release line. */
export const versionText = (info) => `${info.name} ${info.version} (node ${info.node}, ${info.arch}, config schema ${info.configSchemaVersion})\n`;

/** For status: the current release, its serial, and the retained previous release. */
export async function releaseStatus(ctx) {
  const current = await readCurrent(ctx.paths);
  if (!current.version) return { current: null, previous: null };
  let serial = null;
  try {
    serial = (await releaseInfoOf(ctx.runner, ctx.paths.currentExecutable)).releaseSerial ?? null;
  } catch {
    // An executable that cannot say is reported as unknown.
  }
  const journal = await readUpdateJournal(ctx.paths).catch(() => null);
  const previous = journal?.previous?.version;
  return {
    current: { version: current.version, serial },
    previous: previous && previous !== current.version && (await releaseInstalled(ctx.paths, previous)) ? { version: previous } : null,
  };
}
