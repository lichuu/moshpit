import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { configEnv, DEFAULT_STATE_DIR, loadHostConfig, migrateLegacyEnv, parseHostConfig, parseLegacyEnv, resolveStateDir } from "./host-config.mjs";
import { bridgeCommand, freePort, isolatedEnv, passwordEnv } from "./test-support.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODULE = path.join(ROOT, "bridge", "host-config.mjs");
const SECRET = "s3cret-value";

const migrateText = (text, options) =>
  parseHostConfig(JSON.stringify(migrateLegacyEnv(parseLegacyEnv(text))), options);

const baseConfig = (overrides = {}) => ({
  schemaVersion: 1,
  authMode: "tailscale",
  trustedOwner: "you@example.com",
  publicOrigin: "https://host.example.ts.net:8803",
  allowedAuthorities: ["host.example.ts.net:8803"],
  stateDir: "/var/lib/moshpit",
  ...overrides,
});

async function scratch(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "moshpit-host-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function run(args, env = {}) {
  const child = spawn(process.execPath, [MODULE, ...args], {
    env: { ...isolatedEnv(), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = [];
  const err = [];
  child.stdout.on("data", (chunk) => out.push(String(chunk)));
  child.stderr.on("data", (chunk) => err.push(String(chunk)));
  return once(child, "exit").then(([code]) => ({ code, stdout: out.join(""), stderr: err.join("") }));
}

test("the committed env example migrates to a config that converts back to the same variables", async () => {
  const entries = parseLegacyEnv(await readFile(path.join(ROOT, "deploy", "bridge.env.example"), "utf8"));
  const config = migrateText(await readFile(path.join(ROOT, "deploy", "bridge.env.example"), "utf8"));
  assert.equal(config.port, 8801);
  assert.deepEqual(config.allowedAuthorities, ["your-host.your-tailnet.ts.net:8803"]);
  assert.deepEqual(configEnv(config), Object.fromEntries(entries));
});

test("every value kind survives the round trip", () => {
  const text = [
    "MOSHPIT_AUTH_MODE=tailscale+password",
    "MOSHPIT_TRUSTED_USER=you@example.com",
    "MOSHPIT_PASSWORD_FILE=/home/you/.config/moshpit/password",
    "MOSHPIT_PUBLIC_ORIGIN=https://host.example.ts.net",
    "MOSHPIT_ALLOWED_AUTHORITIES=host.example.ts.net,127.0.0.1:8801",
    "MOSHPIT_ALLOWED_ORIGINS=https://other.example.ts.net",
    "MOSHPIT_CONNECT_ORIGINS=https://a.example.ts.net,https://b.example.ts.net",
    "MOSHPIT_BIND=::1",
    "MOSHPIT_PORT=8801",
    "MOSHPIT_HERDR_BIN=/usr/bin/herdr",
    "MOSHPIT_STATE_DIR=/var/lib/moshpit",
    "MOSHPIT_DEVICE_LIFETIME_DAYS=never",
    "MOSHPIT_SESSION_REGISTRY=/home/you/.config/herdr/sessions.json",
    "",
  ].join("\n");
  const config = migrateText(text);
  assert.deepEqual(config.connectOrigins, ["https://a.example.ts.net", "https://b.example.ts.net"]);
  assert.equal(config.deviceLifetimeDays, "never");
  assert.deepEqual(configEnv(config), Object.fromEntries(parseLegacyEnv(text)));
  assert.equal(migrateText(text.replace("=never", "=30")).deviceLifetimeDays, 30);
});

test("a password-mode config names its password file without reading it", () => {
  const config = parseHostConfig(
    JSON.stringify(baseConfig({ authMode: "password", trustedOwner: undefined, passwordFile: "/nonexistent/password" })),
  );
  assert.equal(configEnv(config).MOSHPIT_PASSWORD_FILE, "/nonexistent/password");
});

test("config structure refusals name the key", () => {
  const cases = [
    [baseConfig({ listenAddress: "x" }), /"listenAddress" is not a moshpit setting/],
    [baseConfig({ schemaVersion: 2 }), /newer than this release reads/],
    [baseConfig({ schemaVersion: undefined }), /schemaVersion must be 1/],
    [baseConfig({ port: "8801" }), /config port must be a whole number/],
    [baseConfig({ port: 70000 }), /config port must be a whole number/],
    [baseConfig({ stateDir: "state" }), /config stateDir must be an absolute path/],
    [baseConfig({ allowedAuthorities: "host.example.ts.net" }), /config allowedAuthorities must be a list/],
    [baseConfig({ allowedAuthorities: ["a,b"] }), /config allowedAuthorities must be a list/],
    [baseConfig({ deviceLifetimeDays: 0 }), /config deviceLifetimeDays must be/],
    [baseConfig({ stateDir: undefined }), /missing stateDir \(formerly MOSHPIT_STATE_DIR\)/],
  ];
  for (const [config, pattern] of cases) assert.throws(() => parseHostConfig(JSON.stringify(config)), pattern);
  assert.throws(() => parseHostConfig("[]"), /must be a JSON object/);
  assert.throws(() => parseHostConfig("{"), /not valid JSON/);
});

test("semantic checks reuse the bridge's own readers", () => {
  assert.throws(
    () => parseHostConfig(JSON.stringify(baseConfig({ trustedOwner: undefined }))),
    /MOSHPIT_TRUSTED_USER is required in tailscale mode/,
  );
  assert.throws(
    () => parseHostConfig(JSON.stringify(baseConfig({ passwordFile: "/home/you/password" }))),
    /MOSHPIT_PASSWORD_FILE has no meaning in tailscale mode/,
  );
  const loopback = baseConfig({ publicOrigin: "http://127.0.0.1:8801", allowedAuthorities: ["127.0.0.1:8801"] });
  assert.throws(() => parseHostConfig(JSON.stringify(loopback)), /MOSHPIT_PUBLIC_ORIGIN .* must use https/);
  assert.equal(parseHostConfig(JSON.stringify(loopback), { devInsecure: true }).publicOrigin, "http://127.0.0.1:8801");
  assert.throws(() => parseHostConfig(JSON.stringify(baseConfig({ authMode: "open" }))), /MOSHPIT_AUTH_MODE/);
});

test("the legacy parser refuses shell syntax by line and key, never quoting the value", () => {
  const valid = "MOSHPIT_AUTH_MODE=tailscale\n# comment\n\n";
  const cases = [
    [`export MOSHPIT_TRUSTED_USER=${SECRET}`, /line 4: remove "export"/],
    [`MOSHPIT_TRUSTED_USER="${SECRET}"`, /line 4: MOSHPIT_TRUSTED_USER contains a quote/],
    [`MOSHPIT_TRUSTED_USER='${SECRET}'`, /line 4: MOSHPIT_TRUSTED_USER contains a quote/],
    [`MOSHPIT_STATE_DIR=$HOME/${SECRET}`, /line 4: MOSHPIT_STATE_DIR contains a quote, \$/],
    [`MOSHPIT_STATE_DIR=\`${SECRET}\``, /line 4: MOSHPIT_STATE_DIR contains/],
    [`MOSHPIT_STATE_DIR=/a\\ ${SECRET}`, /line 4: MOSHPIT_STATE_DIR contains/],
    [`MOSHPIT_TRUSTED_USER=${SECRET}\0`, /line 4: MOSHPIT_TRUSTED_USER contains/],
    [`MOSHPIT_TRUSTED_USER= ${SECRET}`, /line 4: MOSHPIT_TRUSTED_USER has whitespace/],
    [`MOSHPIT_TRUSTED_USER=${SECRET}\r`, /line 4: MOSHPIT_TRUSTED_USER has whitespace/],
    [`MOSHPIT_TRUSTED_USER=${SECRET} # me`, /line 4: MOSHPIT_TRUSTED_USER has whitespace/],
    [`MOSHPIT_TRUSTED_USER ${SECRET}`, /line 4: expected KEY=VALUE/],
    [`HOME=/${SECRET}`, /line 4: "HOME" is not a MOSHPIT_ setting name/],
    [`MOSHPIT_AUTH_MODE=${SECRET}`, /line 4: MOSHPIT_AUTH_MODE is set twice/],
  ];
  for (const [line, pattern] of cases) {
    assert.throws(
      () => parseLegacyEnv(`${valid}${line}\n`),
      (error) => pattern.test(error.message) && !error.message.includes(SECRET),
      line,
    );
  }
});

test("migration refuses settings that are not host settings, never quoting the value", () => {
  const cases = [
    [`MOSHPIT_PASSWORD=${SECRET}`, /MOSHPIT_PASSWORD is no longer read: remove it and set MOSHPIT_PASSWORD_FILE/],
    [`MOSHPIT_DEV_INSECURE=${SECRET}`, /MOSHPIT_DEV_INSECURE is a development or test setting/],
    [`MOSHPIT_PUSH_ENDPOINT=https://${SECRET}`, /MOSHPIT_PUSH_ENDPOINT is a development or test setting/],
    [`MOSHPIT_FROB=${SECRET}`, /MOSHPIT_FROB is not a moshpit host setting/],
    [`MOSHPIT_STATE_DIR=.moshpit-state/${SECRET}`, /MOSHPIT_STATE_DIR must be an absolute path/],
    [`MOSHPIT_PORT=${SECRET}`, /MOSHPIT_PORT must be a whole number/],
    ["MOSHPIT_ALLOWED_AUTHORITIES=a,,b", /MOSHPIT_ALLOWED_AUTHORITIES must be a list of non-empty strings/],
  ];
  for (const [line, pattern] of cases) {
    assert.throws(
      () => migrateLegacyEnv(parseLegacyEnv(`MOSHPIT_AUTH_MODE=tailscale\n${line}\n`)),
      (error) => pattern.test(error.message) && !error.message.includes(SECRET),
      line,
    );
  }
});

test("without MOSHPIT_CONFIG the environment is used as before", async () => {
  assert.equal(await loadHostConfig({ MOSHPIT_PORT: "8801" }), null);
});

test("resolveStateDir follows the bridge: the flag, then the named config, then the environment, then the default", async (t) => {
  const dir = await scratch(t);
  const file = path.join(dir, "config.json");
  await writeFile(file, JSON.stringify(baseConfig({ stateDir: "/from/config" })), { mode: 0o600 });
  assert.equal(await resolveStateDir({ MOSHPIT_CONFIG: file }), "/from/config");
  assert.equal(await resolveStateDir({ MOSHPIT_CONFIG: file }, "/from/flag"), "/from/flag");
  assert.equal(await resolveStateDir({ MOSHPIT_STATE_DIR: "/from/env" }), "/from/env");
  assert.equal(await resolveStateDir({}), DEFAULT_STATE_DIR);
});

test("resolveStateDir refuses what the bridge refuses: a doubled setting or an unreadable config", async (t) => {
  const dir = await scratch(t);
  const file = path.join(dir, "config.json");
  await writeFile(file, JSON.stringify(baseConfig()), { mode: 0o600 });
  await assert.rejects(() => resolveStateDir({ MOSHPIT_CONFIG: file, MOSHPIT_STATE_DIR: "/x" }), /MOSHPIT_STATE_DIR/);
  await assert.rejects(() => resolveStateDir({ MOSHPIT_CONFIG: path.join(dir, "missing.json") }));
});

test("migrate writes a private config once, and check accepts it", async (t) => {
  const dir = await scratch(t);
  const envFile = path.join(dir, "bridge.env");
  await writeFile(envFile, await readFile(path.join(ROOT, "deploy", "bridge.env.example")));
  const target = path.join(dir, "config", "moshpit", "config.json");

  const migrated = await run(["migrate", envFile, target]);
  assert.equal(migrated.code, 0, migrated.stderr);
  assert.equal((await stat(target)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(target))).mode & 0o777, 0o700);
  assert.equal(JSON.parse(await readFile(target, "utf8")).schemaVersion, 1);

  const before = await readFile(target, "utf8");
  const again = await run(["migrate", envFile, target]);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /already exists; run: .* check /);
  assert.equal(await readFile(target, "utf8"), before);

  const checked = await run(["check", target]);
  assert.deepEqual([checked.code, checked.stdout], [0, `ok ${target}\n`]);

  assert.equal((await run(["migrate", envFile])).code, 2);
});

test("migrate refuses a legacy file with shell syntax and writes nothing", async (t) => {
  const dir = await scratch(t);
  const envFile = path.join(dir, "bridge.env");
  await writeFile(envFile, `MOSHPIT_AUTH_MODE=tailscale\nMOSHPIT_TRUSTED_USER=$(${SECRET})\n`);
  const target = path.join(dir, "config.json");
  const result = await run(["migrate", envFile, target]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /line 2: MOSHPIT_TRUSTED_USER contains/);
  assert.ok(!result.stderr.includes(SECRET));
  await assert.rejects(stat(target), { code: "ENOENT" });
});

async function bridgeConfig(t) {
  const dir = await scratch(t);
  const port = await freePort();
  const herdr = path.join(dir, "herdr-fixture");
  await writeFile(herdr, `#!${process.execPath}\nconsole.log("{}");\n`, { mode: 0o700 });
  const { MOSHPIT_PASSWORD_FILE } = await passwordEnv(dir);
  const config = path.join(dir, "config.json");
  const body = {
    schemaVersion: 1,
    authMode: "password",
    passwordFile: MOSHPIT_PASSWORD_FILE,
    publicOrigin: `http://127.0.0.1:${port}`,
    allowedAuthorities: [`127.0.0.1:${port}`],
    port,
    herdrBin: herdr,
    stateDir: path.join(dir, "state"),
  };
  await writeFile(config, JSON.stringify(body), { mode: 0o600 });
  return { dir, port, config };
}

function startBridge(t, env) {
  const child = spawn(...bridgeCommand(), {
    env: { ...isolatedEnv(), MOSHPIT_DEV_INSECURE: "1", MOSHPIT_POLL_MS: "600000", ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const err = [];
  child.stderr.on("data", (chunk) => err.push(String(chunk)));
  const exited = once(child, "exit").then(([code]) => code);
  t.after(async () => {
    child.kill("SIGKILL");
    await exited;
  });
  const exitCode = () =>
    Promise.race([exited, delay(10_000, undefined, { ref: false }).then(() => assert.fail(`bridge kept running: ${err.join("")}`))]);
  return { child, exitCode, stderr: () => err.join("") };
}

test("a bridge started with only MOSHPIT_CONFIG serves under that config", async (t) => {
  const { port, config } = await bridgeConfig(t);
  const bridge = startBridge(t, { MOSHPIT_CONFIG: config });
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    assert.equal(bridge.child.exitCode, null, bridge.stderr());
    try {
      const response = await fetch(`${origin}/api/auth-info`, { headers: { origin } });
      assert.deepEqual((await response.json()).requiredFactors, ["password"]);
      break;
    } catch (error) {
      if (error instanceof assert.AssertionError || Date.now() > deadline) throw error;
      await delay(50);
    }
  }
});

test("a bridge refuses a setting given both in MOSHPIT_CONFIG and the environment", async (t) => {
  const { port, config } = await bridgeConfig(t);
  const bridge = startBridge(t, { MOSHPIT_CONFIG: config, MOSHPIT_PORT: String(port) });
  assert.equal(await bridge.exitCode(), 1);
  assert.match(bridge.stderr(), /MOSHPIT_PORT set in the environment as well as in /);
});

test("a bridge refuses a MOSHPIT_CONFIG that is a symbolic link", async (t) => {
  const { dir, config } = await bridgeConfig(t);
  const link = path.join(dir, "linked.json");
  await symlink(config, link);
  const bridge = startBridge(t, { MOSHPIT_CONFIG: link });
  assert.equal(await bridge.exitCode(), 1);
  assert.match(bridge.stderr(), /linked\.json is a symbolic link/);
});
