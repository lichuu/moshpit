import os from "node:os";
import QRCode from "qrcode";
import { MAX_CONFIG_BYTES, parseHostConfig } from "./host-config.mjs";
import { hostPaths } from "./host-probe.mjs";
import { writeEnvelope } from "./json-output.mjs";
import { readPrivateFile } from "./private-files.mjs";

// `moshpit address`: the public origin from the config, for opening the app on
// another device. The address is not a secret and the QR holds only it; a
// device still needs Tailscale as the owner and its own approval.

export const EXIT = { ok: 0, failed: 1, usage: 2, notInstalled: 3 };
export const USAGE = "usage: moshpit address [--json]";

/** What a phone needs before the address works, for a config's owner. */
export function phoneAccessText(owner) {
  const as = owner ? `as ${owner}` : "as the host's owner";
  return `On a phone: install Tailscale, sign in ${as}, then open the address. The app asks this host to approve the phone.`;
}

async function readAddress(env) {
  const file = hostPaths(env).config;
  let text;
  try {
    text = await readPrivateFile(file, { maxBytes: MAX_CONFIG_BYTES });
  } catch (error) {
    return { exitCode: EXIT.failed, code: "config_unreadable", message: `${file} cannot be read: ${error.message}` };
  }
  if (text === null)
    return { exitCode: EXIT.notInstalled, code: "not_installed", message: `moshpit is not installed here: there is no config at ${file}. Run: moshpit setup` };
  try {
    const config = parseHostConfig(text);
    return { exitCode: EXIT.ok, origin: config.publicOrigin, owner: config.trustedOwner ?? null };
  } catch (error) {
    return { exitCode: EXIT.failed, code: "config_invalid", message: `${file} is not a usable config: ${error.message}. moshpit config check ${file} shows why.` };
  }
}

export async function main(argv, { io = process, env = process.env } = {}) {
  const json = argv.length === 1 && argv[0] === "--json";
  if (argv.length > 0 && !json) {
    io.stderr.write(`${USAGE}\n`);
    io.exitCode = EXIT.usage;
    return;
  }
  const answer = await readAddress({ ...env, HOME: env.HOME || os.homedir() });
  io.exitCode = answer.exitCode;
  if (json) {
    writeEnvelope(io, "address", answer.origin ? { exitCode: answer.exitCode, result: { origin: answer.origin } } : { exitCode: answer.exitCode, error: { code: answer.code, message: answer.message } });
    return;
  }
  if (!answer.origin) {
    io.stderr.write(`${answer.message}\n`);
    return;
  }
  const lines = [answer.origin, "", phoneAccessText(answer.owner)];
  if (io.stdout.isTTY) lines.push("", await QRCode.toString(answer.origin, { type: "terminal", small: true }));
  io.stdout.write(`${lines.join("\n")}\n`);
}
