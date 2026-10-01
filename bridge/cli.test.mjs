import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { cliCommand, freePort, isolatedEnv, parseEnvelope, releaseBin } from "./test-support.mjs";
import { READABLE_VERSIONS, STATE_VERSION } from "./devices.mjs";

// Runs against bridge/cli.mjs, or the release executable under test:release.

async function scratch(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "moshpit-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function run(t, args, env = {}) {
  const child = spawn(...cliCommand(...args), { env: { ...isolatedEnv(), ...env }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill("SIGKILL"));
  const out = [];
  const err = [];
  child.stdout.on("data", (chunk) => out.push(String(chunk)));
  child.stderr.on("data", (chunk) => err.push(String(chunk)));
  const [code] = await once(child, "exit");
  return { code, stdout: out.join(""), stderr: err.join("") };
}

/** The environment a bridge would start from, so a stray server start would leave a state directory. */
async function bridgeReadyEnv(dir) {
  const port = await freePort();
  await writeFile(path.join(dir, "password"), "pw", { mode: 0o600 });
  return {
    MOSHPIT_PORT: String(port),
    MOSHPIT_PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
    MOSHPIT_ALLOWED_AUTHORITIES: `127.0.0.1:${port}`,
    MOSHPIT_DEV_INSECURE: "1",
    MOSHPIT_AUTH_MODE: "password",
    MOSHPIT_PASSWORD_FILE: path.join(dir, "password"),
    MOSHPIT_HERDR_BIN: "",
    MOSHPIT_STATE_DIR: path.join(dir, "state"),
  };
}

test("version prints the release line, and nothing else", { timeout: 10_000 }, async (t) => {
  const result = await run(t, ["version"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^moshpit \S.* \(node v\d+\.\d+\.\d+, (x64|arm64), config schema 1\)\n$/);
  assert.equal(result.stderr, "");
});

test("version --json reports the release info and the state versions it reads", { timeout: 10_000 }, async (t) => {
  const result = await run(t, ["version", "--json"]);
  assert.equal(result.code, 0);
  const info = parseEnvelope(result.stdout, "version", { exitCode: 0 }).result;
  assert.deepEqual(info.stateVersions, { devices: { write: STATE_VERSION, read: [...READABLE_VERSIONS] } });
  assert.equal(info.configSchemaVersion, 1);
  assert.equal("signing" in info, false);
});

test("a missing or unknown command prints usage and exits 2", { timeout: 10_000 }, async (t) => {
  for (const args of [[], ["serve"]]) {
    const result = await run(t, args);
    assert.equal(result.code, 2, args.join(" "));
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^usage: moshpit bridge\n/);
  }
});

test("admin answers without starting a bridge", { timeout: 10_000 }, async (t) => {
  const dir = await scratch(t);
  const env = await bridgeReadyEnv(dir);
  const result = await run(t, ["admin", "devices"], env);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, `No bridge state directory at ${env.MOSHPIT_STATE_DIR}. Start the bridge first.\n`);
  assert.deepEqual(await readdir(dir), ["password"]);
});

test("config checks a file without starting a bridge", { timeout: 10_000 }, async (t) => {
  const dir = await scratch(t);
  const env = await bridgeReadyEnv(dir);
  const config = path.join(dir, "config.json");
  await writeFile(
    config,
    JSON.stringify({
      schemaVersion: 1,
      authMode: "password",
      passwordFile: env.MOSHPIT_PASSWORD_FILE,
      publicOrigin: env.MOSHPIT_PUBLIC_ORIGIN,
      allowedAuthorities: [env.MOSHPIT_ALLOWED_AUTHORITIES],
      port: Number(env.MOSHPIT_PORT),
      stateDir: env.MOSHPIT_STATE_DIR,
    }),
    { mode: 0o600 },
  );
  const result = await run(t, ["config", "check", config], env);
  assert.deepEqual(result, { code: 0, stdout: `ok ${config}\n`, stderr: "" });
  assert.deepEqual((await readdir(dir)).sort(), ["config.json", "password"]);

  const usage = await run(t, ["config"], env);
  assert.equal(usage.code, 2);
  assert.equal(usage.stdout, "");
  assert.match(usage.stderr, /^usage: .* migrate <env-file> <config.json>\n.* check <config.json>\n$/);
});

test("usage and hints name moshpit subcommands in the executable and node modules in a checkout", { timeout: 10_000 }, async (t) => {
  const [admin, config] = releaseBin() ? ["moshpit admin", "moshpit config"] : ["node bridge/admin.mjs", "node bridge/host-config.mjs"];
  const dir = await scratch(t);

  const usage = await run(t, ["admin", "bogus"]);
  assert.equal(usage.code, 1);
  assert.match(usage.stderr, new RegExp(`^Unknown command "bogus"\\.\\n\\nUsage:\\n  ${admin} pair --name "Dana's phone"\\n  ${admin} devices\\n`));

  const configUsage = await run(t, ["config"]);
  assert.equal(configUsage.stderr, `usage: ${config} migrate <env-file> <config.json>\n       ${config} check <config.json>\n`);

  const existing = path.join(dir, "config.json");
  await writeFile(existing, "{}", { mode: 0o600 });
  const hint = await run(t, ["config", "migrate", path.join(dir, "bridge.env"), existing]);
  assert.equal(hint.code, 1);
  assert.equal(hint.stderr, `${existing} already exists; run: ${config} check ${existing}\n`);

  if (releaseBin()) for (const text of [usage.stderr, configUsage.stderr, hint.stderr]) assert.doesNotMatch(text, /node bridge\//);
});

test("status reads an empty host without changing it and prints one JSON result", { timeout: 20_000 }, async (t) => {
  const dir = await scratch(t);
  const env = { HOME: dir, XDG_CONFIG_HOME: `${dir}/c`, XDG_STATE_HOME: `${dir}/s`, XDG_DATA_HOME: `${dir}/d`, PATH: process.env.PATH };
  const result = await run(t, ["status", "--json"], env);
  assert.equal(result.code, 3, result.stderr);
  const envelope = parseEnvelope(result.stdout, "status", { exitCode: 3 });
  assert.equal(envelope.result.state, "not installed");
  assert.equal(envelope.error.code, "incomplete");
  assert.equal("ok" in envelope.result, false, "ok lives on the envelope only");
  assert.deepEqual(await readdir(dir), []);
});
