#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "rolldown";
import { READABLE_VERSIONS, STATE_VERSION } from "../bridge/devices.mjs";
import { CONFIG_SCHEMA_VERSION } from "../bridge/host-config.mjs";
import { SPA_INDEX_ASSET, spaAssetKey } from "../bridge/spa-source.mjs";

// Builds dist/release/moshpit-linux-<arch>: a Node single executable holding
// bridge/cli.mjs bundled to one file and every dist/spa file as assets, and
// the manifest beside it that `moshpit update` checks the download against.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SPA = path.join(ROOT, "dist", "spa");
const OUT = path.join(ROOT, "dist", "release");
const ARCHES = new Set(["x64", "arm64"]);

function refuse(message) {
  console.error(message);
  process.exit(1);
}

const [major, minor] = process.versions.node.split(".").map(Number);
if (process.platform !== "linux") refuse("release builds run on Linux only");
if (!ARCHES.has(process.arch)) refuse(`unsupported architecture ${process.arch}`);
if (major < 25 || (major === 25 && minor < 5)) refuse(`node --build-sea needs Node 25.5 or later; this is ${process.version}`);

const run = (file, args, cwd = ROOT) => execFileSync(file, args, { cwd, stdio: "inherit" });
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function filesUnder(dir, prefix = "") {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await filesUnder(path.join(dir, entry.name), rel)));
    else if (entry.isFile()) files.push(rel);
    else refuse(`dist/spa/${rel} is neither a file nor a directory`);
  }
  return files.sort();
}

const name = `moshpit-linux-${process.arch}`;
const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
// The serial is a fixed base plus the commits reachable from HEAD. Each release
// descends from the one before it, so the count only grows, and it comes from
// git rather than the clock, so a rebuild reproduces it. A shallow clone would
// count only what it fetched.
const SERIAL_BASE = 340;
if (git("rev-parse", "--is-shallow-repository") !== "false") refuse("release builds need the full history: fetch with --unshallow or fetch-depth: 0");
const version = git("describe", "--always", "--dirty");
const releaseSerial = SERIAL_BASE + Number(git("rev-list", "--count", "HEAD"));
const work = path.join(OUT, `.work-${process.arch}`);
const executable = path.join(OUT, name);

run(process.execPath, [path.join(ROOT, "node_modules", "vite", "bin", "vite.js"), "build", "--config", "vite.spa.ts"]);
await rm(work, { recursive: true, force: true });
await mkdir(work, { recursive: true });

await build({
  input: path.join(ROOT, "bridge", "cli.mjs"),
  platform: "node",
  logLevel: "warn",
  output: { file: path.join(work, "bridge.mjs"), format: "esm", codeSplitting: false },
});

const spaFiles = await filesUnder(SPA);
const index = {};
const assets = {};
for (const rel of spaFiles) {
  const file = path.join(SPA, rel);
  const bytes = await readFile(file);
  index[rel] = { size: bytes.length, sha256: sha256(bytes) };
  assets[spaAssetKey(rel)] = file;
}
// Update and rollback refuse a release that cannot read the host's device state.
const stateVersions = { devices: { write: STATE_VERSION, read: [...READABLE_VERSIONS] } };
const release = { name: "moshpit", version, releaseSerial, arch: process.arch, node: process.version, configSchemaVersion: CONFIG_SCHEMA_VERSION, stateVersions };
await writeFile(path.join(work, SPA_INDEX_ASSET), JSON.stringify(index));
await writeFile(path.join(work, "release.json"), JSON.stringify(release));
assets[SPA_INDEX_ASSET] = path.join(work, SPA_INDEX_ASSET);
assets["release.json"] = path.join(work, "release.json");

const seaConfig = path.join(work, "sea.json");
await writeFile(
  seaConfig,
  JSON.stringify({
    // Relative, because node --build-sea records the main path in the executable.
    main: "bridge.mjs",
    mainFormat: "module",
    output: executable,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    assets,
  }),
);
await rm(executable, { force: true });
run(process.execPath, ["--build-sea", seaConfig], work);

const bytes = await readFile(executable);
const manifest = { ...release, name, sha256: sha256(bytes), bytes: bytes.length };
await writeFile(path.join(OUT, `${name}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
await rm(work, { recursive: true, force: true });
console.log(`${executable}\n${JSON.stringify(manifest, null, 2)}`);
