import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, readlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { sendAdminRequest } from "./admin.mjs";
import { MAX_CONFIG_BYTES, parseHostConfig } from "./host-config.mjs";
import { hostPaths, loopbackAuthInfo, loopbackPortFree, processAlive, realRunner } from "./host-probe.mjs";
import { releaseStatus } from "./host-releases.mjs";
import { CHECKS, HTTPS_PORTS, planFromConfig, STEPS, StepBlocked, StepConflict } from "./host-steps.mjs";
import { stepParts, writeEnvelope } from "./json-output.mjs";
import { readPrivateFile, writePrivateFile } from "./private-files.mjs";
import { linkMode, offerSetupLink } from "./setup-link.mjs";

// The setup engine and its headless front end. It walks CHECKS, then STEPS,
// journaling each step it changes. The journal is a record, not the truth:
// every step re-reads the host before it is skipped.

export const JOURNAL_SCHEMA_VERSION = 1;
const MAX_JOURNAL_BYTES = 256 * 1024;

/** Exit codes that are not a preflight row's own (CHECKS) or a step's (STEPS). */
export const EXIT = { ok: 0, failed: 1, usage: 2, notInstalled: 3, confirmBlocked: 30, locked: 31, conflict: 33 };

export const FINAL_STATES = ["installed, awaiting first device", "complete"];

async function readJournal(file) {
  const text = await readPrivateFile(file, { maxBytes: MAX_JOURNAL_BYTES });
  if (text === null) return { schemaVersion: JOURNAL_SCHEMA_VERSION, steps: {} };
  const journal = JSON.parse(text);
  if (journal?.schemaVersion !== JOURNAL_SCHEMA_VERSION || typeof journal.steps !== "object" || journal.steps === null)
    throw new Error(`${file} is not a setup journal this release reads; restore it from a backup, then rerun setup`);
  return journal;
}

async function record(ctx, journal, id, entry) {
  journal.steps[id] = entry;
  await writePrivateFile(ctx.paths.journal, `${JSON.stringify(journal, null, 2)}\n`);
}

/**
 * Takes the single-installer lock, or reports the pid holding it. The pid is
 * written before the lock appears (link is atomic), so a lock is never seen
 * empty; a lock whose pid is dead is stale and taken over.
 */
export async function acquireLock(file, isAlive) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${process.pid}\n`, { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await link(temporary, file);
        return { release: () => releaseLock(file) };
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      const pid = Number((await readFile(file, "utf8").catch(() => "")).trim());
      if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) return { heldBy: pid };
      await unlink(file).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    return { heldBy: null };
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

async function releaseLock(file) {
  const holder = (await readFile(file, "utf8").catch(() => "")).trim();
  if (holder === String(process.pid)) await unlink(file).catch(() => {});
}

const row = (id, status, detail) => ({ id, status, detail });

function stateOf(steps, done, devices) {
  const linear = steps.filter((step) => step.id !== "persistence" && step.id !== "verified");
  if (done.has("verified") && linear.every((step) => done.has(step.id))) {
    if (!done.has("persistence")) return "installed, awaiting persistence";
    return devices > 0 ? "complete" : "installed, awaiting first device";
  }
  let state = "not installed";
  for (const step of linear) {
    if (!done.has(step.id)) break;
    state = step.id;
  }
  return state;
}

function nextFor(ctx, state, rows) {
  const stuck = rows.find((entry) => entry.status === "failed" || entry.status === "blocked");
  if (stuck && stuck.id !== "persistence") return `Resolve the ${stuck.id} problem above, then rerun: moshpit setup`;
  if (state === "installed, awaiting persistence") return `Rerun with --allow-linger, or run: sudo loginctl enable-linger ${ctx.user}`;
  if (state === "installed, awaiting first device")
    return "Run moshpit setup on a terminal for a setup link to open on your first device, or add --emit-link to print one.";
  return undefined;
}

async function finish(ctx, steps, rows, exitCode, journal) {
  const done = new Set(rows.filter((entry) => entry.status === "done" || entry.status === "skipped").map((entry) => entry.id));
  // A run that stopped early still knows what earlier runs finished.
  const reached = new Set(rows.map((entry) => entry.id));
  for (const [id, entry] of Object.entries(journal?.steps ?? {})) if (!reached.has(id) && entry.at) done.add(id);
  const devices = done.has("verified") ? await countApprovedDevices(ctx) : 0;
  const state = stateOf(steps, done, devices);
  const result = { ok: exitCode === 0, state, steps: rows };
  const next = nextFor(ctx, state, rows);
  if (next) result.next = next;
  return { result, exitCode };
}

const pendingRows = (steps) => steps.map((step) => row(step.id, "pending", "not started"));

async function preflight(ctx, checks) {
  const notes = [];
  for (const check of checks) {
    const outcome = await check.run(ctx);
    if (outcome.fail) return { row: row("preflight", "failed", `${check.id}: ${outcome.fail}`), exitCode: check.exitCode };
    if (outcome.skipped) notes.push(`${check.id} skipped: ${outcome.skipped}`);
    if (outcome.unknown) notes.push(`${check.id} unknown: ${outcome.unknown}`);
  }
  return { row: row("preflight", "done", [`${checks.length - notes.length} checks passed`, ...notes].join("; ")), exitCode: 0 };
}

async function confirm(ctx, steps) {
  const machine = `machine ${ctx.plan.tailscale.dnsName}, account ${ctx.plan.tailscale.owner}`;
  const changes = [];
  for (const step of steps) if (step.confirm && !step.skipped?.(ctx) && !(await step.isDone(ctx))) changes.push(step.id);
  if (changes.length === 0) return { row: row("confirm", "skipped", `${machine}; nothing to change`) };
  if (ctx.options.yes) return { row: row("confirm", "done", `${machine}; accepted with --yes`) };
  if (!ctx.isTTY)
    return {
      row: row("confirm", "blocked", `${machine}. Nothing was changed: confirm on a terminal, or rerun with --yes to accept what was detected.`),
      exitCode: EXIT.confirmBlocked,
    };
  const accepted = await ctx.prompt(`Set up moshpit on ${ctx.plan.tailscale.dnsName} for ${ctx.plan.tailscale.owner} at ${ctx.plan.publicOrigin}? [y/N] `);
  return accepted ?
      { row: row("confirm", "done", `${machine}; confirmed`) }
    : { row: row("confirm", "blocked", `${machine}. Declined; nothing was changed.`), exitCode: EXIT.confirmBlocked };
}

async function walk(ctx, steps, journal) {
  const rows = [];
  let exitCode = 0;
  let stopped = false;
  for (const step of steps) {
    if (stopped) {
      rows.push(row(step.id, "pending", "not started"));
      continue;
    }
    const skipped = step.skipped?.(ctx);
    if (skipped) {
      rows.push(row(step.id, "skipped", skipped));
      continue;
    }
    const entry = journal.steps[step.id];
    try {
      if (await step.isDone(ctx)) {
        if (!entry?.at) await record(ctx, journal, step.id, { at: journalTime(ctx), previous: entry ? entry.previous : await step.snapshot(ctx) });
        rows.push(step.check ? row(step.id, "done", step.describe(ctx)) : row(step.id, "skipped", `already in place: ${step.describe(ctx)}`));
        continue;
      }
      const conflict = await step.conflict?.(ctx);
      if (conflict) throw new StepConflict(conflict);
      // The value being replaced is journaled before the change, so a crash
      // mid-apply cannot lose it. Resuming an unfinished entry keeps that
      // value; applying again after a finished one is a new change.
      const previous = entry && !entry.at ? entry.previous : await step.snapshot(ctx);
      await record(ctx, journal, step.id, { previous });
      await step.apply(ctx);
      if (!(await step.isDone(ctx))) throw new Error(`${step.describe(ctx)} did not take effect`);
      await record(ctx, journal, step.id, { at: journalTime(ctx), previous });
      rows.push(row(step.id, "done", `${entry?.at ? "had drifted, applied again: " : ""}${step.describe(ctx)}`));
    } catch (error) {
      if (error instanceof StepBlocked) {
        rows.push(row(step.id, "blocked", error.message));
        exitCode ||= step.blockedCode;
        continue;
      }
      rows.push(row(step.id, "failed", error instanceof Error ? error.message : String(error)));
      exitCode = error instanceof StepConflict ? EXIT.conflict : (step.failedCode ?? EXIT.failed);
      stopped = true;
    }
  }
  return { rows, exitCode };
}

/** Runs setup against ctx. Returns `{ result, exitCode }`; `result` is the --json object. */
export async function runSetup(ctx, { checks = CHECKS, steps = STEPS } = {}) {
  ctx.plan = {};
  // Read-only here, for preflight; the walk reads it again under the lock.
  ctx.journal = await readJournal(ctx.paths.journal).catch((error) => ({ unreadable: error.message, steps: {} }));
  const checked = await preflight(ctx, checks);
  if (checked.exitCode) {
    const journal = ctx.journal.unreadable ? null : ctx.journal;
    return finish(ctx, steps, [checked.row, row("confirm", "pending", "not started"), ...pendingRows(steps)], checked.exitCode, journal);
  }
  const confirmed = await confirm(ctx, steps);
  if (confirmed.exitCode) return finish(ctx, steps, [checked.row, confirmed.row, ...pendingRows(steps)], confirmed.exitCode, null);

  await mkdir(ctx.paths.state, { recursive: true, mode: 0o700 });
  const lock = await acquireLock(ctx.paths.lock, ctx.isAlive);
  if (!lock.release) {
    const holder = lock.heldBy ? `process ${lock.heldBy}` : "another run";
    const locked = row("lock", "blocked", `${holder} holds ${ctx.paths.lock}; wait for it to finish. A lock whose process has exited is taken over.`);
    return finish(ctx, steps, [checked.row, confirmed.row, locked, ...pendingRows(steps)], EXIT.locked, null);
  }
  try {
    let journal;
    try {
      journal = await readJournal(ctx.paths.journal);
    } catch (error) {
      return finish(ctx, steps, [checked.row, confirmed.row, row("journal", "failed", error.message), ...pendingRows(steps)], EXIT.failed, null);
    }
    const walked = await walk(ctx, steps, journal);
    return finish(ctx, steps, [checked.row, confirmed.row, ...walked.rows], walked.exitCode, journal);
  } finally {
    await lock.release();
  }
}

/** What is installed, read from the journal and the host. Never changes anything and never takes the lock. */
export async function readStatus(ctx, { steps = STEPS } = {}) {
  ctx.plan = {};
  ctx.verifyAttempts = 1;
  const rows = [];
  let journal = { steps: {} };
  try {
    journal = await readJournal(ctx.paths.journal);
  } catch (error) {
    rows.push(row("journal", "failed", error.message));
  }
  try {
    const text = await readPrivateFile(ctx.paths.config, { maxBytes: MAX_CONFIG_BYTES });
    if (text !== null) ctx.plan = planFromConfig(parseHostConfig(text));
  } catch (error) {
    rows.push(row("config", "failed", `${ctx.paths.config}: ${error.message}`));
  }
  const current = await readlink(ctx.paths.current).catch(() => null);
  ctx.release = current?.startsWith(`releases${path.sep}`) ? { version: current.slice("releases/".length), executable: null } : null;

  const done = new Set();
  for (const step of steps) {
    const at = journal.steps[step.id]?.at;
    const skipped = step.skipped?.(ctx);
    if (skipped) {
      done.add(step.id);
      rows.push(row(step.id, "skipped", skipped));
      continue;
    }
    try {
      if (await step.isDone(ctx)) {
        done.add(step.id);
        rows.push(row(step.id, "done", step.describe(ctx)));
      } else rows.push(row(step.id, "pending", at ? `the journal says done at ${at}, but it is not in place on the host` : "not done"));
    } catch (error) {
      rows.push(row(step.id, "failed", error instanceof Error ? error.message : String(error)));
    }
  }
  const devices = done.has("verified") ? await countApprovedDevices(ctx) : 0;
  const state = stateOf(steps, done, devices);
  const release = await releaseStatus(ctx);
  if (release.current) {
    const previous = release.previous ? `; previous ${release.previous.version} kept for moshpit rollback` : "; no previous release kept";
    rows.push(row("release", "done", `${release.current.version} (serial ${release.current.serial ?? "unknown"})${previous}`));
  }
  const result = { ok: FINAL_STATES.includes(state), state, steps: rows };
  const next = nextFor(ctx, state, []) ?? (FINAL_STATES.includes(state) ? undefined : "Run: moshpit setup");
  if (next) result.next = next;
  return { result, exitCode: result.ok ? EXIT.ok : EXIT.notInstalled };
}

const FLAGS = {
  setup: { "--yes": "yes", "--allow-linger": "allowLinger", "--json": "json", "--port": "port", "--emit-link": "emitLink", "--recover": "recover" },
  status: { "--json": "json" },
};

export const USAGE = [
  "usage: moshpit setup [--yes] [--allow-linger] [--port 443|8803] [--emit-link] [--recover] [--json]",
  "       moshpit status [--json]",
].join("\n");

/** `{ options }` or `{ error }` for a setup or status command line. */
export function parseSetupArgs(command, argv) {
  const known = FLAGS[command];
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const [flag, inline] = argv[index].split(/=(.*)/s, 2);
    const key = known[flag];
    if (!key) return { error: `Unknown argument ${JSON.stringify(argv[index])}.` };
    if (Object.hasOwn(options, key)) return { error: `${flag} was given twice.` };
    if (key !== "port") {
      if (inline !== undefined) return { error: `${flag} takes no value.` };
      options[key] = true;
      continue;
    }
    const value = inline ?? argv[++index];
    if (!HTTPS_PORTS.includes(Number(value)) || !/^[0-9]+$/.test(value ?? ""))
      return { error: `--port must be ${HTTPS_PORTS.join(" or ")}.` };
    options.port = Number(value);
  }
  return { options };
}

async function countApprovedDevices(ctx) {
  if (!ctx.plan.stateDir) return 0;
  const answer = await ctx.admin({ action: "devices" }, ctx.plan.stateDir);
  return answer.error ? 0 : answer.result.filter((device) => device.active && device.revokedAt === null).length;
}

const journalTime = (ctx) => new Date(ctx.now()).toISOString();

function onInterrupt(handler) {
  process.once("SIGINT", handler);
  return () => process.off("SIGINT", handler);
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

async function ask(question) {
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await prompt.question(question)).trim());
  } finally {
    prompt.close();
  }
}

/** The context for this machine. `release` is null when running from a checkout. */
export function realContext({ release, options }) {
  const env = { ...process.env, HOME: process.env.HOME || os.homedir() };
  return {
    runner: realRunner,
    env,
    paths: hostPaths(env),
    uid: process.getuid?.(),
    user: os.userInfo().username,
    arch: process.arch,
    glibc: process.report?.getReport().header.glibcVersionRuntime ?? null,
    isTTY: Boolean(process.stdin.isTTY && process.stderr.isTTY),
    stdoutIsTTY: Boolean(process.stdout.isTTY),
    prompt: ask,
    release,
    options,
    fetch: globalThis.fetch,
    portFree: loopbackPortFree,
    bridgeAnswers: loopbackAuthInfo,
    isAlive: processAlive,
    now: () => Date.now(),
    admin: (message, stateDir) => sendAdminRequest(message, { stateDir }),
    onInterrupt,
    sleep,
    verifyAttempts: 20,
    verifyDelayMs: 500,
  };
}

const rowWidth = (steps) => Math.max(...steps.map((entry) => entry.id.length));

/** Human rows: on stdout, except failed and blocked ones, which go to stderr. */
function renderRows(steps, width, { stdout, stderr }) {
  for (const entry of steps) {
    const line = `${entry.status.padEnd(8)} ${entry.id.padEnd(width)}  ${entry.detail.replace(/\n/g, `\n${" ".repeat(width + 11)}`)}\n`;
    (entry.status === "failed" || entry.status === "blocked" ? stderr : stdout).write(line);
  }
}

function renderSummary(result, { stdout }) {
  stdout.write(`state: ${result.state}\n`);
  if (result.next) stdout.write(`next: ${result.next}\n`);
}

/** Human output: every row, then the state and what to do next. */
export function renderHuman({ result }, io) {
  renderRows(result.steps, rowWidth(result.steps), io);
  renderSummary(result, io);
}

/** `moshpit setup` and `moshpit status`, run from bridge/cli.mjs. */
export async function main(command, argv, { release, io = process, context = realContext } = {}) {
  const parsed = parseSetupArgs(command, argv);
  if (parsed.error) {
    io.stderr.write(`${parsed.error}\n${USAGE}\n`);
    io.exitCode = EXIT.usage;
    return;
  }
  const { json } = parsed.options;
  const ctx = context({ release, options: parsed.options });
  let outcome;
  try {
    outcome = command === "setup" ? await runSetup(ctx) : await readStatus(ctx);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    outcome = { result: { ok: false, state: "unknown", steps: [row(command, "failed", detail)] }, exitCode: EXIT.failed };
  }
  const mode = command === "setup" ? linkMode(ctx, outcome) : "none";
  if (mode !== "none") {
    // The setup rows print before the link, so the operator reads what was
    // installed while the countdown runs.
    const width = rowWidth(outcome.result.steps);
    if (!json) renderRows(outcome.result.steps, width, io);
    const shown = outcome.result.steps.length;
    const quiet = { write: () => {} };
    outcome = await offerSetupLink(ctx, outcome, mode, { show: json ? (mode === "wait" ? io.stderr : quiet) : io.stdout, status: io.stderr });
    if (!json) {
      renderRows(outcome.result.steps.slice(shown), width, io);
      renderSummary(outcome.result, io);
    }
  } else if (!json) renderHuman(outcome, io);
  if (json) writeEnvelope(io, command, stepParts(outcome));
  io.exitCode = outcome.exitCode;
}
