import { createInterface } from "node:readline/promises";
import { formatAdminResult, sendAdminRequest } from "./admin.mjs";
import { DEFAULT_STATE_DIR, resolveStateDir } from "./host-config.mjs";
import { writeEnvelope } from "./json-output.mjs";

// `moshpit devices`: the device list and access-request decisions for the
// host operator. Everything goes through the running bridge's admin socket.

export const EXIT = { ok: 0, failed: 1, usage: 2, confirmBlocked: 30 };

export const USAGE = [
  "usage: moshpit devices [list] [--json]",
  "       moshpit devices pending [--json]",
  "       moshpit devices approve|reject REQUEST_ID [--yes] [--json]",
  "",
  `  --state-dir PATH  Bridge state directory (default: the config named by $MOSHPIT_CONFIG, else $MOSHPIT_STATE_DIR, else ${DEFAULT_STATE_DIR})`,
].join("\n");

const FLAGS = new Set(["json", "yes"]);

export function parseDevicesArgs(argv) {
  const flags = new Set();
  let stateDir;
  const positional = [];
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (!argument.startsWith("--")) positional.push(argument);
    else if (FLAGS.has(argument.slice(2))) flags.add(argument.slice(2));
    else if (argument === "--state-dir" || argument.startsWith("--state-dir=")) {
      if (stateDir !== undefined) return { usage: "--state-dir was given twice." };
      stateDir = argument.includes("=") ? argument.slice("--state-dir=".length) : argv[++index];
      if (!stateDir) return { usage: "--state-dir needs a value." };
    } else return { usage: `Unknown option ${argument}.` };
  }
  const [command = "list", ...rest] = positional;
  const options = { json: flags.has("json"), yes: flags.has("yes"), stateDir };
  if (command === "list" || command === "pending") {
    if (rest.length) return { usage: `devices ${command} takes no arguments.` };
    if (options.yes) return { usage: "--yes only applies to approve and reject." };
    return { ...options, command, message: { action: command === "list" ? "devices" : "requests" } };
  }
  if (command === "approve" || command === "reject") {
    if (rest.length !== 1) return { usage: `devices ${command} takes one request id. Run moshpit devices pending to list them.` };
    return { ...options, command, message: { action: command, requestId: rest[0] } };
  }
  return { usage: `Unknown devices command ${JSON.stringify(command)}.` };
}

async function ask(question) {
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await prompt.question(question)).trim());
  } finally {
    prompt.close();
  }
}

const realContext = () => ({
  isTTY: Boolean(process.stdin.isTTY && process.stderr.isTTY),
  prompt: ask,
  send: sendAdminRequest,
});

/** Runs one devices command. `context` is injectable so the prompt can be tested. */
export async function main(argv, { io = process, env = process.env, context = realContext() } = {}) {
  const parsed = parseDevicesArgs(argv, env);
  if (parsed.usage) {
    io.stderr.write(`${parsed.usage}\n\n${USAGE}\n`);
    io.exitCode = EXIT.usage;
    return;
  }
  const finish = (exitCode, outcome) => {
    io.exitCode = exitCode;
    if (parsed.json) writeEnvelope(io, "devices", { exitCode, ...(outcome.error ? { error: outcome.error } : { result: outcome.result }) });
    else if (outcome.error) io.stderr.write(`${outcome.error.message}\n`);
    else io.stdout.write(`${formatAdminResult(parsed.message.action, outcome.result)}\n`);
  };
  let stateDir;
  try {
    stateDir = await resolveStateDir(env, parsed.stateDir);
  } catch (error) {
    return finish(EXIT.failed, { error: { code: "config_invalid", message: error instanceof Error ? error.message : String(error) } });
  }
  const send = (message) => context.send(message, { stateDir });

  if (parsed.command === "approve" || parsed.command === "reject") {
    // The phrase shown here must be the one the new device shows, so read it
    // from the bridge before asking rather than trusting the id alone.
    const pending = await send({ action: "requests" });
    if (pending.error) return finish(EXIT.failed, pending);
    const request = pending.result.find((row) => row.id === parsed.message.requestId);
    if (!request)
      return finish(EXIT.failed, {
        error: { code: "enrollment_unknown", message: "No access request with that id is waiting. Run moshpit devices pending." },
      });
    if (!parsed.yes) {
      const question = `${parsed.command === "approve" ? "Approve" : "Reject"} ${JSON.stringify(request.name)} with phrase "${request.phrase}"? [y/N] `;
      if (!context.isTTY)
        return finish(EXIT.confirmBlocked, {
          error: {
            code: "confirmation_required",
            message: `${parsed.command} needs confirmation. Check that the new device shows "${request.phrase}", then rerun with --yes.`,
          },
        });
      if (!(await context.prompt(question)))
        return finish(EXIT.failed, { error: { code: "declined", message: "Declined. Nothing was changed." } });
    }
  }
  const answer = await send(parsed.message);
  return finish(answer.error ? EXIT.failed : EXIT.ok, answer);
}
