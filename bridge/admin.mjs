#!/usr/bin/env node
import { lstat } from "node:fs/promises";
import { connect } from "node:net";
import path from "node:path";
import { isSea } from "node:sea";
import { pathToFileURL } from "node:url";
import { commandFor } from "./command-name.mjs";
import { DEFAULT_STATE_DIR, resolveStateDir } from "./host-config.mjs";
import { DeviceError, EXPIRY_TERM, lifetimeOf, LOCAL_ADMIN } from "./devices.mjs";

// Local device administration. The bridge process owns device state, so this
// command asks it over a private Unix socket and never writes devices.json.
// One newline-terminated JSON line travels each way. Every function here answers
// with `{ result }` or `{ error: { code, message } }`; nothing on this path
// throws and no error text repeats a secret.

export const SOCKET_FILE = "admin.sock";
export const MAX_REQUEST_BYTES = 4096;
export const MAX_RESPONSE_BYTES = 64 * 1024;
export const REQUEST_TIMEOUT_MS = 5000;

const MAX_FIELD = 256;
const OPTIONS = new Set(["name", "state-dir"]);

export const USAGE = [
  "Usage:",
  `  ${commandFor("admin")} pair --name "Dana's phone"`,
  `  ${commandFor("admin")} devices`,
  `  ${commandFor("admin")} revoke DEVICE_ID`,
  `  ${commandFor("admin")} expiry DEVICE_ID 90|never`,
  `  ${commandFor("admin")} requests`,
  `  ${commandFor("admin")} approve|reject REQUEST_ID`,
  "",
  "Options:",
  `  --state-dir PATH  Bridge state directory (default: the config named by $MOSHPIT_CONFIG, else $MOSHPIT_STATE_DIR, else ${DEFAULT_STATE_DIR})`,
].join("\n");

const failure = (code, message) => ({ error: { code, message } });
const usageError = (reason) => failure("admin_usage", `${reason}\n\n${USAGE}`);
const invalidRequest = (reason) => failure("admin_request_invalid", reason);

const decide = (api, id, decision) =>
  api.devices.decideEnrollment({ id, decision, owner: api.owner, approver: LOCAL_ADMIN });

/** The single-use pairing secret and the owner come from the bridge, never from argv. */
const ACTIONS = {
  pair: { fields: ["name"], run: (api, message) => api.devices.issueGrant({ name: message.name, owner: api.owner }) },
  devices: { fields: [], run: (api) => api.devices.list() },
  // Why recent setup links were refused: codes and times, never a secret or an owner.
  refusals: { fields: [], internal: true, run: (api) => api.devices.pairingRefusals() },
  revoke: { fields: ["deviceId"], run: (api, message) => api.devices.revoke(message.deviceId) },
  expiry: {
    fields: ["deviceId", "term"],
    run: (api, message) => {
      // Revalidated here: the socket is the trust boundary, not the parser.
      const lifetimeMs = lifetimeOf(message.term);
      if (lifetimeMs === undefined) throw new DeviceError(400, "device_expiry_invalid", EXPIRY_TERM);
      return api.devices.setExpiry({ deviceId: message.deviceId, lifetimeMs });
    },
  },
  // The local shell is the enrollment trust root, so the socket may decide.
  requests: { fields: [], run: (api) => api.devices.pendingRequests({ owner: api.owner }) },
  approve: { fields: ["requestId"], run: (api, message) => decide(api, message.requestId, "approve") },
  reject: { fields: ["requestId"], run: (api, message) => decide(api, message.requestId, "reject") },
};

/** Reads one request line from the socket. Bounded before it reaches JSON.parse. */
export function decodeAdminMessage(text) {
  if (typeof text !== "string" || text.length === 0)
    return invalidRequest("An administrative request cannot be empty.");
  if (Buffer.byteLength(text) > MAX_REQUEST_BYTES)
    return invalidRequest(`An administrative request must stay under ${MAX_REQUEST_BYTES} bytes.`);
  try {
    return { message: JSON.parse(text) };
  } catch {
    return invalidRequest("That administrative request is not valid JSON.");
  }
}

/** Maps one bounded message onto the device store. Returns a denial rather than throwing. */
export async function dispatchAdminRequest(message, api) {
  if (!message || typeof message !== "object" || Array.isArray(message))
    return invalidRequest("An administrative request must be a JSON object.");
  if (typeof message.action !== "string" || !Object.hasOwn(ACTIONS, message.action))
    return failure("admin_action_unknown", `Unknown action. This bridge accepts ${Object.keys(ACTIONS).filter((name) => !ACTIONS[name].internal).join(", ")}.`);
  const action = ACTIONS[message.action];
  const keys = Object.keys(message);
  if (keys.length !== action.fields.length + 1 || !action.fields.every((field) => keys.includes(field)))
    return invalidRequest(
      action.fields.length
        ? `The ${message.action} action takes exactly ${action.fields.join(", ")}.`
        : `The ${message.action} action takes no other fields.`,
    );
  for (const field of action.fields) {
    const value = message[field];
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_FIELD)
      return invalidRequest(`The ${field} field must be text of 1 to ${MAX_FIELD} characters.`);
  }
  try {
    return { result: await action.run(api, message) };
  } catch (error) {
    if (error instanceof DeviceError) return failure(error.code, error.message);
    return failure("admin_failed", "The bridge could not complete that administrative request.");
  }
}

/** The socket carries a pairing secret, so refuse a path any other account could hold. */
async function checkSocketPath(directory, socketPath) {
  const uid = process.getuid?.();
  let info;
  try {
    info = await lstat(directory);
  } catch {
    return failure("admin_bridge_unreachable", `No bridge state directory at ${directory}. Start the bridge first.`);
  }
  if (!info.isDirectory() || (uid !== undefined && info.uid !== uid))
    return failure("admin_socket_unsafe", `${directory} is not a directory belonging to this user.`);
  if ((info.mode & 0o777) !== 0o700)
    return failure("admin_socket_unsafe", `${directory} is not private to this user: chmod 700 it.`);
  let socketInfo;
  try {
    socketInfo = await lstat(socketPath);
  } catch {
    return failure("admin_bridge_unreachable", `No bridge is listening on ${socketPath}. Start the bridge first.`);
  }
  if (!socketInfo.isSocket() || (uid !== undefined && socketInfo.uid !== uid))
    return failure("admin_socket_unsafe", `${socketPath} is not a socket belonging to this user.`);
  if ((socketInfo.mode & 0o777) !== 0o600)
    return failure("admin_socket_unsafe", `${socketPath} is not private to this user: chmod 600 it.`);
  return null;
}

function parseResponse(text) {
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    // The body may hold a pairing secret, so a parse failure never quotes it.
    return failure("admin_response_invalid", "The bridge answered with something this command cannot read.");
  }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope))
    return failure("admin_response_invalid", "The bridge answered with something this command cannot read.");
  if (envelope.error)
    return typeof envelope.error.code === "string" && typeof envelope.error.message === "string"
      ? { error: { code: envelope.error.code, message: envelope.error.message } }
      : failure("admin_response_invalid", "The bridge answered with an unreadable error.");
  if (envelope.result === undefined)
    return failure("admin_response_invalid", "The bridge answered without a result.");
  return { result: envelope.result };
}

function exchange(socketPath, message, timeoutMs) {
  const payload = `${JSON.stringify(message)}\n`;
  if (Buffer.byteLength(payload) > MAX_REQUEST_BYTES)
    return Promise.resolve(invalidRequest(`An administrative request must stay under ${MAX_REQUEST_BYTES} bytes.`));
  return new Promise((resolve) => {
    const socket = connect(socketPath);
    let text = "";
    let receivedBytes = 0;
    const settle = (envelope) => {
      socket.destroy();
      resolve(envelope);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs, () =>
      settle(failure("admin_timeout", `The bridge did not answer within ${timeoutMs} ms.`)),
    );
    socket.on("connect", () => socket.write(payload));
    socket.on("data", (chunk) => {
      text += chunk;
      receivedBytes += Buffer.byteLength(chunk);
      if (receivedBytes > MAX_RESPONSE_BYTES)
        return settle(failure("admin_response_invalid", "The bridge sent more than this command reads."));
      const line = text.indexOf("\n");
      if (line !== -1) settle(parseResponse(text.slice(0, line)));
    });
    socket.on("end", () => settle(parseResponse(text.trim())));
    socket.on("error", (error) =>
      settle(
        failure(
          "admin_bridge_unreachable",
          `No bridge answered on ${socketPath} (${error.code ?? "connection failed"}). Start the bridge first.`,
        ),
      ),
    );
  });
}

/** Sends one message to the running bridge and returns its envelope. */
export async function sendAdminRequest(message, { stateDir, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const directory = path.resolve(stateDir);
  const socketPath = path.join(directory, SOCKET_FILE);
  return (await checkSocketPath(directory, socketPath)) ?? (await exchange(socketPath, message, timeoutMs));
}

/** Sends a parsed command to the bridge whose state directory this environment names. */
async function sendToBridge({ message, stateDir }) {
  try {
    return await sendAdminRequest(message, { stateDir: await resolveStateDir(process.env, stateDir) });
  } catch (error) {
    return failure("admin_config_invalid", error instanceof Error ? error.message : String(error));
  }
}

export function parseAdminArgs(argv) {
  const options = new Map();
  const positional = [];
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      positional.push(argument);
      continue;
    }
    const separator = argument.indexOf("=");
    const key = separator === -1 ? argument.slice(2) : argument.slice(2, separator);
    if (!OPTIONS.has(key)) return usageError(`Unknown option --${key}.`);
    if (options.has(key)) return usageError(`--${key} was given twice.`);
    const value = separator === -1 ? argv[++index] : argument.slice(separator + 1);
    if (value === undefined || (separator === -1 && value.startsWith("--")))
      return usageError(`--${key} needs a value.`);
    options.set(key, value);
  }
  const stateDir = options.get("state-dir");
  const [action, ...rest] = positional;
  if (action === undefined) return usageError("Name a command.");
  if (!Object.hasOwn(ACTIONS, action) || ACTIONS[action].internal) return usageError(`Unknown command ${JSON.stringify(action)}.`);
  if (action !== "pair" && options.has("name")) return usageError("--name only applies to pair.");
  if (action === "pair") {
    if (rest.length) return usageError("pair takes no arguments besides --name.");
    const name = options.get("name");
    if (name === undefined) return usageError('pair needs --name "Dana\'s phone".');
    return { stateDir, message: { action, name } };
  }
  if (action === "devices" || action === "requests") {
    if (rest.length) return usageError(`${action} takes no arguments.`);
    return { stateDir, message: { action } };
  }
  if (action === "approve" || action === "reject") {
    if (rest.length !== 1) return usageError(`${action} takes one request id. Run requests to list them.`);
    return { stateDir, message: { action, requestId: rest[0] } };
  }
  if (action === "expiry") {
    if (rest.length !== 2) return usageError('expiry needs a device id and either a number of days or "never".');
    const [deviceId, term] = rest;
    // "never" is the only word accepted: a typo must not silently pick a term.
    if (lifetimeOf(term) === undefined) return usageError(EXPIRY_TERM);
    return { stateDir, message: { action, deviceId, term } };
  }
  if (rest.length === 0) return usageError("revoke needs a device id. Run devices to list them.");
  if (rest.length > 1) return usageError("revoke takes one device id.");
  return { stateDir, message: { action, deviceId: rest[0] } };
}

const at = (ms) => `${new Date(ms).toISOString().slice(0, 19).replace("T", " ")} UTC`;
/** A device with no expiry reads as "never" everywhere a date would go. */
const expiryOf = (device) => (device.expiresAt === null ? "never" : at(device.expiresAt));
const statusOf = (device) => (device.revokedAt !== null ? "revoked" : device.active ? "active" : "expired");

function formatDevices(devices) {
  if (devices.length === 0) return "No devices are approved. Run pair to approve one.";
  return table(
    ["DEVICE ID", "NAME", "OWNER", "STATUS", "EXPIRES"],
    devices.map((device) => [device.id, device.name, device.owner, statusOf(device), expiryOf(device)]),
  );
}

function table(header, rows) {
  const widths = header.map((cell, column) => Math.max(cell.length, ...rows.map((row) => row[column].length)));
  return [header, ...rows]
    .map((row) => row.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd())
    .join("\n");
}

const ageOf = (ms) => (ms < 60_000 ? `${Math.floor(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m`);

function formatRequests(requests) {
  if (requests.length === 0) return "No access requests are waiting.";
  return table(
    ["REQUEST ID", "NAME", "PHRASE", "AGE"],
    requests.map((request) => [request.id, request.name, request.phrase, ageOf(request.ageMs)]),
  );
}

/** Human-readable output. The pairing secret is printed here, once, and never as a URL. */
export function formatAdminResult(action, result) {
  if (action === "pair")
    return [
      `Pairing secret for ${JSON.stringify(result.name)}, single use, expires ${at(result.expiresAt)}:`,
      "",
      `  ${result.secret}`,
      "",
      "Type or scan it on that device after signing in. The bridge shows it once.",
    ].join("\n");
  if (action === "devices") return formatDevices(result);
  if (action === "requests") return formatRequests(result);
  if (action === "approve" || action === "reject")
    return `Request ${JSON.stringify(result.name)} (${result.id}), phrase "${result.phrase}", is ${result.status}.`;
  if (action === "expiry")
    return result.expiresAt === null
      ? `Device ${JSON.stringify(result.name)} (${result.id}) no longer expires. Revoke it to take access away.`
      : `Device ${JSON.stringify(result.name)} (${result.id}) now expires ${at(result.expiresAt)}.`;
  return [
    `Device ${JSON.stringify(result.name)} (${result.id}) is revoked as of ${at(result.revokedAt)}.`,
    "It stays denied until it is paired again.",
  ].join("\n");
}

export async function main(argv) {
  const parsed = parseAdminArgs(argv);
  const answer = parsed.error ? parsed : await sendToBridge(parsed);
  if (answer.error) {
    process.exitCode = 1;
    process.stderr.write(`${answer.error.message}\n`);
    return;
  }
  process.stdout.write(`${formatAdminResult(parsed.message.action, answer.result)}\n`);
}

// In the release executable every module shares one import.meta.url, so this
// guard would fire for each of them; bridge/cli.mjs dispatches there instead.
if (!isSea() && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2));
