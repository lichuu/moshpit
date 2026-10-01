import assert from "node:assert/strict";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sendAdminRequest } from "./admin.mjs";

const BRIDGE_DIR = path.dirname(fileURLToPath(import.meta.url));
const RELEASE_BIN = process.env.MOSHPIT_TEST_BRIDGE_BIN;
if (RELEASE_BIN !== undefined && !path.isAbsolute(RELEASE_BIN)) throw new Error("MOSHPIT_TEST_BRIDGE_BIN must be an absolute path");

/** The executable under test: the release build when MOSHPIT_TEST_BRIDGE_BIN names one, else this checkout. */
export const releaseBin = () => RELEASE_BIN;

/** `spawn` arguments that start a bridge. */
export function bridgeCommand() {
  return RELEASE_BIN ? [RELEASE_BIN, ["bridge"]] : [process.execPath, [path.join(BRIDGE_DIR, "index.mjs")]];
}

/** `spawn` arguments for a moshpit command such as `version` or `admin devices`. */
export function cliCommand(...args) {
  return RELEASE_BIN ? [RELEASE_BIN, args] : [process.execPath, [path.join(BRIDGE_DIR, "cli.mjs"), ...args]];
}

/**
 * A port reserved before the bridge starts. The bridge validates the inbound
 * authority against configuration, so a test has to know the port up front
 * rather than reading it back from the listening process.
 */
export async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** The origin and authority policy an isolated loopback bridge runs under. */
export function boundaryEnv(port) {
  return {
    MOSHPIT_PORT: String(port),
    MOSHPIT_PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
    MOSHPIT_ALLOWED_AUTHORITIES: `127.0.0.1:${port}`,
    MOSHPIT_DEV_INSECURE: "1",
  };
}

export function isolatedEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("MOSHPIT_")));
}

/** Disposable owner-only password proof for protocol-2 router tests. */
export async function passwordEnv(directory, password = "review-pass") {
  const { writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const file = join(directory, "password");
  await writeFile(file, password, { mode: 0o600 });
  return { MOSHPIT_AUTH_MODE: "password", MOSHPIT_PASSWORD_FILE: file };
}

/**
 * Pairs a browser the way an operator does: the grant comes from the running
 * bridge's private admin socket in `stateDir`, and the browser redeems it over
 * HTTP with its identity. Identity alone cannot mint a grant.
 */
export async function pairDevice(origin, headers, { stateDir, name = "test device" }) {
  const issued = await sendAdminRequest({ action: "pair", name }, { stateDir });
  if (issued.error) throw new Error(JSON.stringify(issued.error));
  const response = await fetch(`${origin}/api/devices/pairing`, {
    method: "POST",
    headers: { ...headers, origin, "content-type": "application/json" },
    body: JSON.stringify({ secret: issued.result.secret, name }),
  });
  const device = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(device));
  return `${device.deviceId}.${device.deviceSecret}`;
}

export async function terminalTicket(origin, headers, target) {
  const response = await fetch(`${origin}/api/terminal-ticket`, {
    method: "POST", headers: { ...headers, origin, "content-type": "application/json" }, body: JSON.stringify({ target }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(result));
  return `ticket=${result.ticket}`;
}

/**
 * Parses one `--json` line and asserts the shared envelope schema (see
 * json-output.mjs): a single newline-terminated line, exactly the documented
 * keys, `ok` equal to `exitCode === 0`, and an `error` of `{code, message}`
 * exactly when the command failed. Returns the envelope.
 */
export function parseEnvelope(stdout, command, { exitCode } = {}) {
  assert.ok(stdout.endsWith("\n") && !stdout.trimEnd().includes("\n"), `${command}: one JSON line, got ${JSON.stringify(stdout)}`);
  const parsed = JSON.parse(stdout);
  const keys = Object.keys(parsed).sort();
  const allowed = ["command", "error", "exitCode", "ok", "result", "schemaVersion"];
  assert.ok(keys.every((key) => allowed.includes(key)), `${command}: unexpected keys ${keys}`);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.command, command);
  assert.equal(typeof parsed.exitCode, "number");
  assert.equal(parsed.ok, parsed.exitCode === 0);
  if (exitCode !== undefined) assert.equal(parsed.exitCode, exitCode);
  if (parsed.ok) {
    assert.equal(parsed.error, undefined, `${command}: a success carries no error`);
    assert.equal(typeof parsed.result, "object", `${command}: a success carries a result`);
  } else {
    assert.deepEqual(Object.keys(parsed.error).sort(), ["code", "message"], `${command}: error is {code, message}`);
    assert.ok(typeof parsed.error.code === "string" && typeof parsed.error.message === "string" && parsed.error.message);
  }
  return parsed;
}
