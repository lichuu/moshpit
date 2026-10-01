import { readlink } from "node:fs/promises";
import { RELEASE_VERSION } from "./host-releases.mjs";
import { realContext, renderHuman } from "./host-setup.mjs";
import { runUninstall } from "./host-uninstall.mjs";
import { EXIT, row, runRollback, runUpdate } from "./host-update.mjs";
import { stepParts, writeEnvelope } from "./json-output.mjs";

// The headless front end for update, rollback and uninstall: the same flags,
// human rows and single --json result as setup.

const FLAGS = {
  update: { "--version": "version", "--json": "json" },
  rollback: { "--json": "json" },
  uninstall: { "--purge": "purge", "--yes": "yes", "--json": "json" },
};

const RUNS = { update: runUpdate, rollback: runRollback, uninstall: runUninstall };

export const USAGE = [
  "usage: moshpit update [--version <tag>] [--json]",
  "       moshpit rollback [--json]",
  "       moshpit uninstall [--purge] [--yes] [--json]",
].join("\n");

/** `{ options }` or `{ error }`. */
export function parseArgs(command, argv) {
  const known = FLAGS[command];
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const [flag, inline] = argv[index].split(/=(.*)/s, 2);
    const key = known[flag];
    if (!key) return { error: `Unknown argument ${JSON.stringify(argv[index])}.` };
    if (Object.hasOwn(options, key)) return { error: `${flag} was given twice.` };
    if (key !== "version") {
      if (inline !== undefined) return { error: `${flag} takes no value.` };
      options[key] = true;
      continue;
    }
    const value = inline ?? argv[++index];
    if (!RELEASE_VERSION.test(value ?? "")) return { error: "--version needs a release tag, such as v1.2.0." };
    options.version = value;
  }
  return { options };
}

/** This machine; `running` is this executable's release info. */
export function maintainContext({ running, options }) {
  return { ...realContext({ release: null, options }), running, readProcExe: (pid) => readlink(`/proc/${pid}/exe`) };
}

/** `moshpit update`, `rollback` and `uninstall`, run from bridge/cli.mjs. */
export async function main(command, argv, { running, io = process, context = maintainContext } = {}) {
  const parsed = parseArgs(command, argv);
  if (parsed.error) {
    io.stderr.write(`${parsed.error}\n${USAGE}\n`);
    io.exitCode = EXIT.usage;
    return;
  }
  const ctx = context({ running, options: parsed.options });
  let outcome;
  try {
    outcome = await RUNS[command](ctx);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    outcome = { result: { ok: false, state: "failed", steps: [row(command, "failed", detail)] }, exitCode: EXIT.failed };
  }
  if (parsed.options.json) writeEnvelope(io, command, stepParts(outcome));
  else renderHuman(outcome, io);
  io.exitCode = outcome.exitCode;
}
