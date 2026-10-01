import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { waitForContainerConfig } from "./container.mjs";
import { hostPaths, loopbackAuthInfo, processAlive } from "./host-probe.mjs";
import { readStatus, runSetup } from "./host-setup.mjs";

// Setup inside the container image (MOSHPIT_SUPERVISOR=container), against a
// scripted host: the Tailscale sidecar answers status and Serve status, and
// its serve.json already proxies HTTPS to the loopback bridge. Only read-only
// commands are scripted, so any systemctl, loginctl or Serve change throws.

const DNS = "moshpit.tail1.ts.net";
const OWNER = "dana@example.com";
const NOW = "2026-09-27T00:00:00.000Z";
const SERVED = "http://127.0.0.1:8801";

const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });

function serveJson(serve) {
  const TCP = {};
  const Web = {};
  for (const [port, target] of serve) {
    TCP[port] = { HTTPS: true };
    Web[`${DNS}:${port}`] = { Handlers: { "/": { Proxy: target } } };
  }
  return JSON.stringify(serve.size ? { TCP, Web } : {});
}

async function container(t, overrides = {}) {
  const dir = await mkdtemp("/tmp/mpc.");
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const volume of ["config", "state", "home", "bin"]) await mkdir(`${dir}/${volume}`, { mode: 0o700 });
  const env = {
    HOME: `${dir}/home`,
    PATH: `${dir}/bin`,
    MOSHPIT_SUPERVISOR: "container",
    MOSHPIT_CONFIG: `${dir}/config/config.json`,
    XDG_STATE_HOME: `${dir}/state`,
    ...overrides.env,
  };
  const herdr = `${dir}/bin/herdr`;
  await writeFile(herdr, "#!/bin/sh\n", { mode: 0o755 });
  const paths = hostPaths(env);
  const host = {
    tailscale: { BackendState: "Running", Self: { DNSName: `${DNS}.`, UserID: 2 }, User: { 2: { ID: 2, LoginName: OWNER } } },
    serve: new Map([[443, SERVED]]),
    // The image's `moshpit bridge` polls for the config and starts a moment
    // after it appears: here, at the first sleep once the config exists.
    bridgeStarts: true,
    bridgeUp: false,
    calls: [],
    ...overrides.host,
  };
  const table = {
    "tailscale status --json": () => ok(JSON.stringify(host.tailscale)),
    "tailscale serve status --json": () => ok(serveJson(host.serve)),
    [`${herdr} --version`]: () => ok("herdr 0.9.1\n"),
  };
  const runner = {
    async run(file, args) {
      const key = [file, ...args].join(" ");
      host.calls.push(key);
      if (!table[key]) throw new Error(`unscripted command: ${key}`);
      return table[key]();
    },
  };
  const bridgeListening = (port) => host.bridgeUp && `http://127.0.0.1:${port}` === SERVED;
  const context = (options = { yes: true }) => {
    const ctx = {
      runner,
      env,
      paths,
      uid: 10001,
      user: "moshpit",
      arch: "arm64",
      glibc: "2.36",
      isTTY: false,
      prompt: async (question) => assert.fail(`unexpected prompt: ${question}`),
      release: { version: "v1.2.3", executable: `${dir}/usr-local-bin-moshpit` },
      options,
      fetch: async (url, init) => {
        assert.equal(init.headers.Origin, ctx.plan.publicOrigin);
        const target = host.serve.get(Number(new URL(url).port || 443));
        if (!target || !bridgeListening(Number(new URL(target).port))) throw new TypeError("fetch failed");
        return { status: 200, json: async () => ({ protocol: 2 }) };
      },
      bridgeAnswers: async (port, origin) => {
        assert.equal(origin, ctx.plan.publicOrigin);
        return bridgeListening(port);
      },
      portFree: async (port) => !bridgeListening(port),
      isAlive: processAlive,
      now: () => NOW,
      approvedDevices: async () => 0,
      admin: async () => ({ result: [] }),
      sleep: async () => {
        if (host.bridgeStarts && existsSync(paths.config)) host.bridgeUp = true;
      },
      verifyAttempts: 3,
      verifyDelayMs: 0,
    };
    return ctx;
  };
  return { dir, env, paths, host, herdr, context, setup: (options) => runSetup(context(options)) };
}

async function files(root) {
  const found = {};
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else found[path.relative(root, file)] = await readFile(file, "utf8");
    }
  }
  await walk(root);
  return found;
}

const rows = (result) => result.steps.map((entry) => [entry.id, entry.status]);
const detail = (result, id) => result.steps.find((entry) => entry.id === id)?.detail;
const readOnly = (key) => key === "tailscale status --json" || key === "tailscale serve status --json" || key.endsWith("/bin/herdr --version");

test("container setup changes no unit, linger or Serve route and ends awaiting its first device", async (t) => {
  const c = await container(t);
  const { result, exitCode } = await c.setup();
  assert.equal(exitCode, 0, JSON.stringify(result));
  assert.equal(result.state, "installed, awaiting first device");
  assert.deepEqual(rows(result), [
    ["preflight", "done"],
    ["confirm", "done"],
    ["staged", "skipped"],
    ["configured", "done"],
    ["service-started", "done"],
    ["persistence", "skipped"],
    ["serve-configured", "skipped"],
    ["verified", "done"],
  ]);
  assert.equal(detail(result, "preflight"), "11 checks passed; systemd skipped: container-supervised; legacy-service skipped: container-supervised; tailscale-operator skipped: container-supervised");
  for (const id of ["staged", "persistence", "serve-configured"]) assert.equal(detail(result, id), "container-supervised", id);
  assert.match(detail(result, "service-started"), /^container-supervised: /);

  assert.deepEqual(c.host.calls.filter((key) => !readOnly(key)), [], "only read-only commands ran");
  assert.equal(c.host.calls.some((key) => /^(systemctl|loginctl) /.test(key)), false);
  assert.deepEqual([...c.host.serve], [[443, SERVED]], "the sidecar's Serve route is untouched");

  assert.deepEqual(JSON.parse(await readFile(c.env.MOSHPIT_CONFIG, "utf8")), {
    schemaVersion: 1,
    authMode: "tailscale",
    trustedOwner: OWNER,
    publicOrigin: `https://${DNS}`,
    allowedAuthorities: [DNS],
    bind: "127.0.0.1",
    port: 8801,
    herdrBin: c.herdr,
    stateDir: `${c.dir}/state/moshpit`,
  });
  assert.equal((await lstat(c.env.MOSHPIT_CONFIG)).mode & 0o777, 0o600);
  const journal = JSON.parse(await readFile(c.paths.journal, "utf8"));
  assert.deepEqual(journal, {
    schemaVersion: 1,
    steps: {
      configured: { previous: { existed: false }, at: NOW },
      "service-started": { previous: { supervisor: "container-supervised" }, at: NOW },
      verified: { previous: null, at: NOW },
    },
  });
  // No release was staged and no unit written: the only files are the config and the journal.
  assert.deepEqual(Object.keys(await files(c.dir)).sort(), ["bin/herdr", "config/config.json", "state/moshpit/setup.json"]);
});

test("a container rerun changes nothing and exits 0", async (t) => {
  const c = await container(t);
  await c.setup();
  const before = await files(c.dir);
  c.host.calls.length = 0;
  const { result, exitCode } = await c.setup({});
  assert.equal(exitCode, 0, JSON.stringify(result));
  assert.equal(result.state, "installed, awaiting first device");
  assert.equal(detail(result, "confirm").endsWith("nothing to change"), true);
  assert.deepEqual(await files(c.dir), before);
  assert.deepEqual(c.host.calls.filter((key) => !readOnly(key)), []);
});

test("container status reads the same state and writes nothing", async (t) => {
  const c = await container(t);
  await c.setup();
  const before = await files(c.dir);
  const { result, exitCode } = await readStatus(c.context({}));
  assert.equal(exitCode, 0, JSON.stringify(result));
  assert.equal(result.state, "installed, awaiting first device");
  assert.deepEqual(rows(result), [
    ["staged", "skipped"],
    ["configured", "done"],
    ["service-started", "done"],
    ["persistence", "skipped"],
    ["serve-configured", "skipped"],
    ["verified", "done"],
  ]);
  assert.deepEqual(await files(c.dir), before);
});

test("a sidecar without the Serve route refuses at preflight and writes nothing", async (t) => {
  const c = await container(t, { host: { serve: new Map() } });
  const { result, exitCode } = await c.setup();
  assert.equal(exitCode, 20);
  assert.match(detail(result, "preflight"), /^https-port: .*TS_SERVE_CONFIG/);
  assert.deepEqual(Object.keys(await files(c.dir)), ["bin/herdr"]);
});

test("a route that is not a loopback proxy is not adopted, and 8803 is used when it is", async (t) => {
  const c = await container(t, { host: { serve: new Map([[443, "tcp forward to 127.0.0.1:22"], [8803, SERVED]]) } });
  const { result, exitCode } = await c.setup();
  assert.equal(exitCode, 0, JSON.stringify(result));
  assert.equal(JSON.parse(await readFile(c.env.MOSHPIT_CONFIG, "utf8")).publicOrigin, `https://${DNS}:8803`);
  assert.deepEqual([...c.host.serve].map(([port]) => port), [443, 8803]);
});

test("an installed container refuses once serve.json no longer reaches its bridge", async (t) => {
  const c = await container(t);
  await c.setup();
  c.host.serve = new Map([[443, "http://127.0.0.1:9999"]]);
  const { result, exitCode } = await c.setup();
  assert.equal(exitCode, 20);
  assert.match(detail(result, "preflight"), /proxy port 443 to http:\/\/127\.0\.0\.1:8801, but it proxies it to http:\/\/127\.0\.0\.1:9999/);
});

test("a tagged sidecar node is refused before any change", async (t) => {
  const c = await container(t);
  c.host.tailscale.Self.Tags = ["tag:server"];
  const { result, exitCode } = await c.setup();
  assert.equal(exitCode, 17);
  assert.match(detail(result, "preflight"), /^owner: This Tailscale node is tagged.*auth key created without tags/);
  assert.deepEqual(Object.keys(await files(c.dir)), ["bin/herdr"]);
});

test("an unknown MOSHPIT_SUPERVISOR is refused at the systemd row", async (t) => {
  const c = await container(t, { env: { MOSHPIT_SUPERVISOR: "docker" } });
  const { result, exitCode } = await c.setup();
  assert.equal(exitCode, 14);
  assert.match(detail(result, "preflight"), /^systemd: MOSHPIT_SUPERVISOR is "docker"/);
});

test("a bridge that never answers fails the service step, and a rerun resumes", async (t) => {
  const c = await container(t, { host: { bridgeStarts: false } });
  const failed = await c.setup();
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.result.state, "configured");
  assert.match(detail(failed.result, "service-started"), /did not answer on 127\.0\.0\.1:8801.*docker compose logs moshpit/);
  c.host.bridgeStarts = true;
  const resumed = await c.setup();
  assert.equal(resumed.exitCode, 0, JSON.stringify(resumed.result));
  assert.equal(resumed.result.state, "installed, awaiting first device");
});

test("the container bridge waits for setup's config, and only in the container", async (t) => {
  const dir = await mkdtemp("/tmp/mpc.");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = `${dir}/config.json`;
  const logged = [];
  const log = (line) => logged.push(line);
  assert.equal(await waitForContainerConfig({ MOSHPIT_CONFIG: config }, { log }), true, "outside the container the bridge reports the missing config itself");
  const waiting = waitForContainerConfig({ MOSHPIT_SUPERVISOR: "container", MOSHPIT_CONFIG: config }, { log, intervalMs: 5 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  await writeFile(config, "{}");
  assert.equal(await waiting, true);
  assert.deepEqual(logged, [`moshpit: waiting for ${config}. Run: docker compose exec moshpit moshpit setup`]);
  const stop = new AbortController();
  const stopped = waitForContainerConfig({ MOSHPIT_SUPERVISOR: "container", MOSHPIT_CONFIG: `${dir}/never.json` }, { log, intervalMs: 60_000, signal: stop.signal });
  stop.abort();
  assert.equal(await stopped, false, "docker stop ends the wait");
});

test("the loopback probe asks as the public origin and needs a protocol", async (t) => {
  let answer = { protocol: 2 };
  const server = createServer((req, res) => {
    const allowed = req.headers.host === DNS && req.headers.origin === `https://${DNS}`;
    res.writeHead(allowed ? 200 : 403, { "content-type": "application/json" });
    res.end(JSON.stringify(allowed ? answer : { error: "host" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const { port } = server.address();
  assert.equal(await loopbackAuthInfo(port, `https://${DNS}`), true);
  assert.equal(await loopbackAuthInfo(port, "https://other.tail1.ts.net"), false);
  answer = { protocol: "2" };
  assert.equal(await loopbackAuthInfo(port, `https://${DNS}`), false);
  server.close();
  await once(server, "close");
  assert.equal(await loopbackAuthInfo(port, `https://${DNS}`), false, "nothing listening");
});
