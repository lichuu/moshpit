#!/usr/bin/env node
import { lstat, mkdir, open } from "node:fs/promises";
import path from "node:path";
import { isSea } from "node:sea";
import { pathToFileURL } from "node:url";
import { commandFor } from "./command-name.mjs";
import { lifetimeOf } from "./devices.mjs";
import { readPrivateFile, writePrivateFile } from "./private-files.mjs";
import { createBrowserBoundary, PASSWORD_RETIRED, readIdentityConfig } from "./security.mjs";

// One private JSON file replaces the shell-sourced deploy/bridge.env. The
// bridge still reads environment variables: a loaded config becomes exactly
// the variables below, so every downstream reader and its checks stay as they
// are. Refusals name keys and never quote a value.

export const CONFIG_SCHEMA_VERSION = 1;
export const MAX_CONFIG_BYTES = 64 * 1024;

const CONTROL = /\p{Cc}/u;
const isText = (value) => typeof value === "string" && value.length > 0 && !CONTROL.test(value);
const digits = (text) => (/^[0-9]+$/.test(text) ? Number(text) : text);

const KINDS = {
  string: {
    valid: isText,
    reason: "must be a non-empty string without control characters",
    fromEnv: (text) => text,
    toEnv: (value) => value,
  },
  list: {
    valid: (value) => Array.isArray(value) && value.every((member) => isText(member) && !member.includes(",")),
    reason: "must be a list of non-empty strings without commas",
    fromEnv: (text) => text.split(",").map((member) => member.trim()),
    toEnv: (value) => value.join(","),
  },
  port: {
    valid: (value) => Number.isInteger(value) && value >= 1 && value <= 65535,
    reason: "must be a whole number from 1 to 65535",
    fromEnv: digits,
    toEnv: String,
  },
  path: {
    valid: (value) => isText(value) && path.isAbsolute(value),
    reason: "must be an absolute path, so the service does not depend on its working directory",
    fromEnv: (text) => text,
    toEnv: (value) => value,
  },
  lifetime: {
    valid: (value) => value === "never" || (Number.isInteger(value) && lifetimeOf(String(value)) !== undefined),
    reason: 'must be a whole number of days from 1 to 3650, or "never"',
    fromEnv: (text) => (text === "never" ? text : digits(text)),
    toEnv: String,
  },
};

const FIELDS = [
  { key: "authMode", env: "MOSHPIT_AUTH_MODE", kind: "string", required: true },
  { key: "trustedOwner", env: "MOSHPIT_TRUSTED_USER", kind: "string" },
  { key: "passwordFile", env: "MOSHPIT_PASSWORD_FILE", kind: "path" },
  { key: "publicOrigin", env: "MOSHPIT_PUBLIC_ORIGIN", kind: "string", required: true },
  { key: "allowedAuthorities", env: "MOSHPIT_ALLOWED_AUTHORITIES", kind: "list", required: true },
  { key: "allowedOrigins", env: "MOSHPIT_ALLOWED_ORIGINS", kind: "list" },
  { key: "connectOrigins", env: "MOSHPIT_CONNECT_ORIGINS", kind: "list" },
  { key: "bind", env: "MOSHPIT_BIND", kind: "string" },
  { key: "port", env: "MOSHPIT_PORT", kind: "port" },
  { key: "herdrBin", env: "MOSHPIT_HERDR_BIN", kind: "path" },
  { key: "stateDir", env: "MOSHPIT_STATE_DIR", kind: "path", required: true },
  { key: "deviceLifetimeDays", env: "MOSHPIT_DEVICE_LIFETIME_DAYS", kind: "lifetime" },
  { key: "sessionRegistry", env: "MOSHPIT_SESSION_REGISTRY", kind: "path" },
];

const BY_KEY = new Map(FIELDS.map((field) => [field.key, field]));
const BY_ENV = new Map(FIELDS.map((field) => [field.env, field]));

const ENVIRONMENT_ONLY = "is a development or test setting and stays in the environment, not the host config";
const NOT_HOST = new Map([
  ["MOSHPIT_PASSWORD", PASSWORD_RETIRED],
  ["MOSHPIT_DEV_INSECURE", ENVIRONMENT_ONLY],
  ["MOSHPIT_POLL_MS", ENVIRONMENT_ONLY],
  ["MOSHPIT_PTY_POLL_MS", ENVIRONMENT_ONLY],
  ["MOSHPIT_PUSH_ENDPOINT", ENVIRONMENT_ONLY],
  ["MOSHPIT_PI_BIN", ENVIRONMENT_ONLY],
  ["MOSHPIT_SERVE_PORT", "is read by scripts/bridge.sh, not the bridge; the Serve port is already in MOSHPIT_PUBLIC_ORIGIN"],
]);

/**
 * A validated, frozen config. `devInsecure` admits the loopback http origins
 * MOSHPIT_DEV_INSECURE=1 admits, which stays an environment-only switch.
 */
export function parseHostConfig(text, { devInsecure = false } = {}) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("config is not valid JSON");
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("config must be a JSON object");
  if (raw.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    if (Number.isInteger(raw.schemaVersion) && raw.schemaVersion > CONFIG_SCHEMA_VERSION)
      throw new Error(
        `config schemaVersion ${raw.schemaVersion} is newer than this release reads (${CONFIG_SCHEMA_VERSION}); update moshpit`,
      );
    throw new Error(`config schemaVersion must be ${CONFIG_SCHEMA_VERSION}`);
  }
  const config = { schemaVersion: CONFIG_SCHEMA_VERSION };
  for (const [key, value] of Object.entries(raw)) {
    if (key === "schemaVersion") continue;
    const field = BY_KEY.get(key);
    if (!field) throw new Error(`config key ${JSON.stringify(key)} is not a moshpit setting`);
    if (!KINDS[field.kind].valid(value)) throw new Error(`config ${key} ${KINDS[field.kind].reason}`);
    config[key] = Array.isArray(value) ? Object.freeze([...value]) : value;
  }
  for (const field of FIELDS) {
    if (field.required && !Object.hasOwn(config, field.key))
      throw new Error(`config is missing ${field.key} (formerly ${field.env})`);
  }
  const env = configEnv(config);
  if (devInsecure) env.MOSHPIT_DEV_INSECURE = "1";
  createBrowserBoundary(env);
  readIdentityConfig(env);
  return Object.freeze(config);
}

/** The environment variables a config stands for, one per field present. */
export function configEnv(config) {
  const env = {};
  for (const field of FIELDS) {
    if (Object.hasOwn(config, field.key)) env[field.env] = KINDS[field.kind].toEnv(config[field.key]);
  }
  return env;
}

// Also systemd EnvironmentFile syntax, which does no shell expansion. Anything
// a shell and systemd would read differently is refused rather than guessed.
const ENV_KEY = /^MOSHPIT_[A-Z0-9_]+$/;
const SHELL_SYNTAX = /[$`'"\\\0]/;

/** The KEY=VALUE pairs of a legacy deploy/bridge.env, in file order. */
export function parseLegacyEnv(text) {
  const entries = new Map();
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  lines.forEach((line, index) => {
    const at = `line ${index + 1}`;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    if (/^export\s/.test(trimmed)) throw new Error(`${at}: remove "export"; this file holds plain KEY=VALUE lines`);
    const equals = line.indexOf("=");
    if (equals === -1) throw new Error(`${at}: expected KEY=VALUE`);
    const key = line.slice(0, equals);
    const value = line.slice(equals + 1);
    if (!ENV_KEY.test(key)) throw new Error(`${at}: ${JSON.stringify(key.slice(0, 64))} is not a MOSHPIT_ setting name`);
    if (entries.has(key)) throw new Error(`${at}: ${key} is set twice`);
    if (SHELL_SYNTAX.test(value))
      throw new Error(`${at}: ${key} contains a quote, $, backtick, backslash or NUL; write the plain value`);
    if (/\s/.test(value)) throw new Error(`${at}: ${key} has whitespace in its value, which a shell would split or end at`);
    entries.set(key, value);
  });
  return entries;
}

/** A config object from parsed legacy settings. Run it through parseHostConfig. */
export function migrateLegacyEnv(entries) {
  const config = { schemaVersion: CONFIG_SCHEMA_VERSION };
  for (const [name, text] of entries) {
    const field = BY_ENV.get(name);
    if (!field) {
      const reason = NOT_HOST.get(name);
      if (reason === PASSWORD_RETIRED) throw new Error(reason);
      if (reason) throw new Error(`${name} ${reason}`);
      throw new Error(`${name} is not a moshpit host setting`);
    }
    const kind = KINDS[field.kind];
    const value = kind.fromEnv(text);
    if (!kind.valid(value)) throw new Error(`${name} ${kind.reason}`);
    config[field.key] = value;
  }
  return config;
}

/**
 * The environment a MOSHPIT_CONFIG file stands for, or null when none is
 * named. Settings come from one place: a table variable also set in the
 * environment refuses startup.
 */
export async function loadHostConfig(env) {
  const file = env.MOSHPIT_CONFIG;
  if (file === undefined) return null;
  if (!path.isAbsolute(file)) throw new Error("MOSHPIT_CONFIG must be an absolute path");
  const text = await readPrivateFile(file, { maxBytes: MAX_CONFIG_BYTES });
  if (text === null) throw new Error(`MOSHPIT_CONFIG ${file} does not exist`);
  let config;
  try {
    config = parseHostConfig(text, { devInsecure: env.MOSHPIT_DEV_INSECURE === "1" });
  } catch (error) {
    throw new Error(`${file}: ${error.message}`);
  }
  const doubled = FIELDS.filter((field) => env[field.env] !== undefined).map((field) => field.env);
  if (doubled.length)
    throw new Error(`${doubled.join(", ")} set in the environment as well as in ${file}; unset them and keep the config`);
  return configEnv(config);
}

export const DEFAULT_STATE_DIR = "./.moshpit-state";

/**
 * The state directory this environment gives the bridge: the config named by
 * MOSHPIT_CONFIG, else MOSHPIT_STATE_DIR, else the default. `flag` is a
 * `--state-dir` and wins. A config that cannot be read throws, exactly as it
 * stops the bridge, so a command never talks to a different directory.
 */
export async function resolveStateDir(env, flag) {
  if (flag !== undefined) return flag;
  return ((await loadHostConfig(env)) ?? env).MOSHPIT_STATE_DIR ?? DEFAULT_STATE_DIR;
}

async function readBounded(file) {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    if (size > MAX_CONFIG_BYTES) throw new Error(`${file} is larger than ${MAX_CONFIG_BYTES} bytes`);
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function exists(file) {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

const devInsecure = () => process.env.MOSHPIT_DEV_INSECURE === "1";

async function migrate(envFile, configFile) {
  const target = path.resolve(configFile);
  if (await exists(target)) throw new Error(`${target} already exists; run: ${commandFor("config")} check ${target}`);
  let text;
  try {
    const config = migrateLegacyEnv(parseLegacyEnv(await readBounded(envFile)));
    text = `${JSON.stringify(config, null, 2)}\n`;
    parseHostConfig(text, { devInsecure: devInsecure() });
  } catch (error) {
    throw new Error(`${envFile}: ${error.message}`);
  }
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writePrivateFile(target, text);
  return `wrote ${target}`;
}

async function check(configFile) {
  const file = path.resolve(configFile);
  await loadHostConfig({ MOSHPIT_CONFIG: file, ...(devInsecure() ? { MOSHPIT_DEV_INSECURE: "1" } : {}) });
  return `ok ${file}`;
}

const USAGE = [
  `usage: ${commandFor("config")} migrate <env-file> <config.json>`,
  `       ${commandFor("config")} check <config.json>`,
].join("\n");

export async function main(argv) {
  const [command, ...rest] = argv;
  const run =
    command === "migrate" && rest.length === 2 ? () => migrate(rest[0], rest[1])
    : command === "check" && rest.length === 1 ? () => check(rest[0])
    : null;
  if (!run) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  try {
    process.stdout.write(`${await run()}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

// In the release executable every module shares one import.meta.url, so this
// guard would fire for each of them; bridge/cli.mjs dispatches there instead.
if (!isSea() && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2));
