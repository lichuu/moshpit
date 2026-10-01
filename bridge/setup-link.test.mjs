import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HOST_SETUP = fileURLToPath(new URL("./host-setup.mjs", import.meta.url));
const HOST_PROBE = fileURLToPath(new URL("./host-probe.mjs", import.meta.url));
const SETUP_LINK = fileURLToPath(new URL("./setup-link.mjs", import.meta.url));

// A process that waits for a browser the way `moshpit setup` does, with a
// display present so it writes the launch page, and a bridge that never approves.
const WAITER = `
import { realContext } from ${JSON.stringify(HOST_SETUP)};
import { realRunner } from ${JSON.stringify(HOST_PROBE)};
import { offerSetupLink } from ${JSON.stringify(SETUP_LINK)};
const dir = process.env.RUN_DIR;
const ok = { code: 0, stdout: "", stderr: "" };
const ctx = {
  ...realContext({ release: null, options: {} }),
  env: { XDG_RUNTIME_DIR: dir, DISPLAY: ":0", PATH: process.env.PATH },
  paths: { state: dir },
  runner: process.env.REAL_RUNNER ? realRunner : { run: async () => ok, launch: async () => ok },
  admin: async (message) => (message.action === "devices" ? { result: [] } : { result: { secret: "s3cret", expiresAt: Date.now() + 300000 } }),
  plan: { stateDir: dir, publicOrigin: "https://box.example.ts.net", tailscale: { owner: "dana@example.com" } },
};
const sink = { write: () => {} };
await offerSetupLink(ctx, { result: { steps: [] }, exitCode: 0 }, "wait", {
  show: sink,
  status: { write: (text) => text.includes("Waiting") && console.log("waiting") },
});
console.log("left " + process.listenerCount("SIGTERM") + " " + process.listenerCount("SIGHUP"));
`;

const pages = async (dir) => (await readdir(dir)).filter((name) => /^moshpit-setup-.*\.html$/.test(name));

async function waitFor(check) {
  for (const deadline = Date.now() + 15_000; Date.now() < deadline; ) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("timed out");
}

/** Starts the waiter; resolves once `ready` says it has reached the point under test. */
async function start(t, env = {}, ready = (_dir, seen) => seen.out.includes("waiting")) {
  const dir = await mkdtemp(path.join(tmpdir(), "moshpit-setup-link-"));
  t.after(async () => {
    await chmod(dir, 0o700);
    await rm(dir, { recursive: true, force: true });
  });
  const child = spawn(process.execPath, ["--input-type=module", "-e", WAITER], {
    env: { ...process.env, RUN_DIR: dir, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGKILL"));
  const seen = { out: "", err: "" };
  child.stdout.on("data", (chunk) => (seen.out += chunk));
  child.stderr.on("data", (chunk) => (seen.err += chunk));
  await waitFor(() => ready(dir, seen));
  return { dir, child, seen };
}

async function ends(child, signal) {
  child.kill(signal);
  const [code, killedBy] = await once(child, "exit");
  assert.equal(killedBy, null, "the process ends by its own exit, not the default signal action");
  return code;
}

for (const [signal, status] of [["SIGTERM", 143], ["SIGHUP", 129], ["SIGINT", 0]]) {
  test(`${signal} while waiting for the browser removes the launch page`, async (t) => {
    const { dir, child, seen } = await start(t);
    assert.equal((await pages(dir)).length, 1, "the page exists while waiting");
    assert.equal(await ends(child, signal), status);
    assert.deepEqual(await pages(dir), [], "the page is gone");
    if (signal === "SIGINT") assert.match(seen.out, /left 0 0/, "a normal end leaves no termination handlers behind");
  });
}

/** A directory on PATH whose xdg-open records that it started, then outlives the launch. */
async function slowBrowser(t) {
  const bin = await mkdtemp(path.join(tmpdir(), "moshpit-xdg-"));
  t.after(() => rm(bin, { recursive: true, force: true }));
  await writeFile(path.join(bin, "xdg-open"), `#!/bin/sh\ntouch "$RUN_DIR/launched"\nexec sleep 3\n`, { mode: 0o755 });
  return bin;
}

for (const [signal, status] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  test(`${signal} while the browser is still launching removes the launch page`, async (t) => {
    const bin = await slowBrowser(t);
    const { dir, child } = await start(t, { REAL_RUNNER: "1", PATH: `${bin}:${process.env.PATH}` }, (dir) => existsSync(path.join(dir, "launched")));
    assert.equal((await pages(dir)).length, 1, "the page exists while the browser launches");
    assert.equal(await ends(child, signal), status);
    assert.deepEqual(await pages(dir), [], "the page is gone");
  });
}

for (const [signal, status] of [["SIGTERM", 143], ["SIGHUP", 129], ["SIGINT", 0]]) {
  test(`${signal} still ends the process when the page cannot be removed`, async (t) => {
    const { dir, child, seen } = await start(t);
    await chmod(dir, 0o500);
    assert.equal(await ends(child, signal), status);
    assert.doesNotMatch(seen.err, /EACCES|at |Error/, "no stack trace");
    assert.equal((await pages(dir)).length, 1, "the page could not be removed, which is what this case forces");
  });
}
