#!/usr/bin/env node
import { getAsset, isSea } from "node:sea";
import { main as addressMain } from "./address-cli.mjs";
import { main as adminMain } from "./admin.mjs";
import { containerConfigReady } from "./container.mjs";
import { main as devicesMain } from "./devices-cli.mjs";
import { CONFIG_SCHEMA_VERSION, main as configMain } from "./host-config.mjs";
import { main as maintainMain } from "./host-maintain.mjs";
import { SOURCE_STATE_VERSIONS, versionText } from "./host-releases.mjs";
import { main as setupMain } from "./host-setup.mjs";
import { writeEnvelope } from "./json-output.mjs";

// The release executable's entry, also runnable from a checkout. Only the
// bridge command imports index.mjs, whose top level starts the server.

function release() {
  if (isSea()) return JSON.parse(getAsset("release.json", "utf8"));
  return {
    name: "moshpit",
    version: "source checkout",
    node: process.version,
    arch: process.arch,
    configSchemaVersion: CONFIG_SCHEMA_VERSION,
    stateVersions: SOURCE_STATE_VERSIONS,
  };
}

const maintain = (command) => (argv) => maintainMain(command, argv, { running: { info: release() } });

const COMMANDS = {
  bridge: async () => {
    if (await containerConfigReady()) await import("./index.mjs");
  },
  address: (argv) => addressMain(argv),
  admin: adminMain,
  devices: (argv) => devicesMain(argv),
  config: configMain,
  // Setup installs this executable, so a checkout passes no release and refuses at preflight.
  setup: (argv) => setupMain("setup", argv, { release: isSea() ? { version: release().version, executable: process.execPath } : null }),
  status: (argv) => setupMain("status", argv),
  update: maintain("update"),
  rollback: maintain("rollback"),
  uninstall: maintain("uninstall"),
  version: async (argv) => {
    const info = release();
    if (argv[0] === "--json") writeEnvelope(process, "version", { exitCode: 0, result: info });
    else process.stdout.write(versionText(info));
  },
};

const USAGE = [
  "usage: moshpit bridge",
  "       moshpit address [--json]",
  "       moshpit admin pair|devices|revoke|expiry|requests|approve|reject ...",
  "       moshpit devices [list|pending|approve ID|reject ID] [--yes] [--json]",
  "       moshpit config migrate|check ...",
  "       moshpit setup [--yes] [--allow-linger] [--port 443|8803] [--emit-link] [--recover] [--json]",
  "       moshpit status [--json]",
  "       moshpit update [--version <tag>] [--json]",
  "       moshpit rollback [--json]",
  "       moshpit uninstall [--purge] [--yes] [--json]",
  "       moshpit version [--json]",
].join("\n");

const [command, ...rest] = process.argv.slice(2);
if (Object.hasOwn(COMMANDS, command ?? "")) await COMMANDS[command](rest);
else {
  process.stderr.write(`${USAGE}\n`);
  process.exitCode = 2;
}
