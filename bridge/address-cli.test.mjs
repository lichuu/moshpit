import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import QRCode from "qrcode";
import { main } from "./address-cli.mjs";
import { cliCommand, isolatedEnv, parseEnvelope } from "./test-support.mjs";

// Runs against bridge/cli.mjs, or the release executable under test:release,
// except the terminal case, which needs a TTY and runs in process.

const ORIGIN = "https://box.tail1.ts.net:8803";
const OWNER = "dana@example.com";

async function host(t, { config = true } = {}) {
  const dir = await mkdtemp("/tmp/mpa.");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { HOME: dir, XDG_CONFIG_HOME: `${dir}/c`, XDG_STATE_HOME: `${dir}/s`, XDG_DATA_HOME: `${dir}/d` };
  if (config) {
    await mkdir(`${dir}/c/moshpit`, { recursive: true, mode: 0o700 });
    const text = JSON.stringify({
      schemaVersion: 1,
      authMode: "tailscale",
      trustedOwner: OWNER,
      publicOrigin: ORIGIN,
      allowedAuthorities: [new URL(ORIGIN).host],
      bind: "127.0.0.1",
      port: 8801,
      stateDir: `${dir}/s/moshpit`,
    });
    await writeFile(`${dir}/c/moshpit/config.json`, text, { mode: 0o600 });
  }
  return { dir, env };
}

async function run(t, args, env) {
  const child = spawn(...cliCommand("address", ...args), { env: { ...isolatedEnv(), ...env }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill("SIGKILL"));
  const out = [];
  const err = [];
  child.stdout.on("data", (chunk) => out.push(String(chunk)));
  child.stderr.on("data", (chunk) => err.push(String(chunk)));
  const [code] = await once(child, "exit");
  return { code, stdout: out.join(""), stderr: err.join("") };
}

const PHONE = `On a phone: install Tailscale, sign in as ${OWNER}, then open the address. The app asks this host to approve the phone.`;

test("address --json prints the configured origin and nothing else", { timeout: 10_000 }, async (t) => {
  const { env } = await host(t);
  const json = await run(t, ["--json"], env);
  assert.equal(json.code, 0);
  assert.equal(json.stderr, "");
  assert.deepEqual(parseEnvelope(json.stdout, "address", { exitCode: 0 }), { schemaVersion: 1, command: "address", ok: true, exitCode: 0, result: { origin: ORIGIN } });
});

test("address without a terminal prints the origin and phone access, with no QR", { timeout: 10_000 }, async (t) => {
  const { env } = await host(t);
  assert.deepEqual(await run(t, [], env), { code: 0, stdout: `${ORIGIN}\n\n${PHONE}\n`, stderr: "" });
});

test("address on a host with no config exits 3 with a clear message and changes nothing", { timeout: 10_000 }, async (t) => {
  const { dir, env } = await host(t, { config: false });
  const human = await run(t, [], env);
  assert.equal(human.code, 3);
  assert.equal(human.stdout, "");
  assert.equal(human.stderr, `moshpit is not installed here: there is no config at ${dir}/c/moshpit/config.json. Run: moshpit setup\n`);
  const json = await run(t, ["--json"], env);
  assert.equal(json.code, 3);
  assert.deepEqual(parseEnvelope(json.stdout, "address", { exitCode: 3 }).error, { code: "not_installed", message: human.stderr.trim() });
  assert.deepEqual(await readdir(dir), []);
});

test("address refuses unknown arguments with usage", { timeout: 10_000 }, async (t) => {
  const { env } = await host(t);
  assert.deepEqual(await run(t, ["--qr"], env), { code: 2, stdout: "", stderr: "usage: moshpit address [--json]\n" });
});

test("on a terminal address adds a QR of exactly the origin", async (t) => {
  const { env } = await host(t);
  const written = [];
  const io = { stdout: { isTTY: true, write: (text) => written.push(text) }, stderr: { write: (text) => assert.fail(text) } };
  await main([], { io, env });
  assert.equal(io.exitCode, 0);
  const qr = await QRCode.toString(ORIGIN, { type: "terminal", small: true });
  assert.equal(written.join(""), `${ORIGIN}\n\n${PHONE}\n\n${qr}\n`);
});
