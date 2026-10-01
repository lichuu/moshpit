import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, unlink, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { hostPaths, parseOperatorUser, parseServeStatus, parseTailscaleStatus, processAlive } from "./host-probe.mjs";
import { main, readStatus, runSetup } from "./host-setup.mjs";
import { STEPS, unitText } from "./host-steps.mjs";
import { LAUNCH_FAILED, REFUSAL_NOTES, SNAP_BROWSER, UNREACHABLE_NOTE } from "./setup-link.mjs";
import { parseEnvelope } from "./test-support.mjs";

// A scripted host: every command setup may issue is a row keyed by its argv,
// marked mutating or not here, independently of the code under test. Files
// live under a fresh /tmp/mps.* directory; systemd, Tailscale and loginctl are
// modelled in memory. Anything unscripted throws.

const DNS = "box.tail1.ts.net";
const OWNER = "dana@example.com";
const USER = "dana";
const VERSION = "v1.2.3";
const NOW = "2026-09-26T00:00:00.000Z";

function makeHost(overrides = {}) {
  const host = {
    tailscaleInstalled: true,
    // OperatorUser in tailscale debug prefs; prefs replaces the whole answer.
    operator: USER,
    prefs: null,
    // The first user listed is not this node's owner: owner comes from Self.UserID.
    tailscale: {
      BackendState: "Running",
      Self: { DNSName: `${DNS}.`, UserID: 2 },
      User: { 1: { ID: 1, LoginName: "tagged-devices" }, 2: { ID: 2, LoginName: OWNER } },
    },
    serve: new Map(),
    manager: "running",
    legacy: false,
    legacyQueryFails: false,
    loadedUnit: null,
    loadedStamp: null,
    enabled: false,
    active: false,
    linger: false,
    lingerAllowed: true,
    herdrWorks: true,
    busyPorts: new Set(),
    devices: [],
    grants: [],
    adminCalls: [],
    adminDown: false,
    refusals: [],
    defaultBrowser: null,
    clock: Date.parse(NOW),
    onSleep: () => {},
    calls: [],
    launches: [],
    launchResult: { code: 0, stdout: "", stderr: "" },
    mutations: [],
    crashAtMutation: 0,
    onMutation: () => {},
    ...overrides,
  };
  return host;
}

const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });

function serveJson(host) {
  if (host.serve.size === 0) return "{}";
  const TCP = {};
  const Web = {};
  for (const [port, target] of host.serve) {
    TCP[port] = { HTTPS: true };
    Web[`${DNS}:${port}`] = { Handlers: { "/": { Proxy: target } } };
  }
  return JSON.stringify({ TCP, Web });
}

function fakeRunner(host, paths, herdr) {
  const unitOnDisk = () => (existsSync(paths.unit) ? readFileSync(paths.unit, "utf8") : null);
  // Like systemd, a reload is needed when the file changed on disk since the last load, even back to the same text.
  const unitStamp = () => (existsSync(paths.unit) ? statSync(paths.unit, { bigint: true }).mtimeNs : null);
  const table = {
    "tailscale status --json": { read: () => (host.tailscaleInstalled ? ok(JSON.stringify(host.tailscale)) : { code: 127, stdout: "", stderr: "ENOENT" }) },
    "tailscale debug prefs": { read: () => host.prefs ?? ok(JSON.stringify({ WantRunning: true, OperatorUser: host.operator, Hostname: "" }, null, "\t")) },
    "tailscale serve status --json": { read: () => ok(serveJson(host)) },
    "systemctl --user is-system-running": { read: () => ({ code: host.manager === "running" ? 0 : 1, stdout: `${host.manager}\n`, stderr: "" }) },
    "systemctl --user show moshpit-bridge.service --property=LoadState,NeedDaemonReload,UnitFileState,ActiveState": {
      read: () =>
        host.legacyQueryFails ? { code: 1, stdout: "", stderr: "Failed to connect to bus: No medium found\n" }
        : ok(`LoadState=${host.legacy ? "loaded" : "not-found"}\nNeedDaemonReload=no\nUnitFileState=${host.legacy ? "enabled" : ""}\nActiveState=${host.legacy ? "active" : "inactive"}\n`),
    },
    "systemctl --user show moshpit.service --property=LoadState,NeedDaemonReload,UnitFileState,ActiveState": {
      read: () =>
        ok(
          [
            `LoadState=${host.loadedUnit === null ? "not-found" : "loaded"}`,
            `NeedDaemonReload=${host.loadedUnit !== null && host.loadedStamp !== unitStamp() ? "yes" : "no"}`,
            `UnitFileState=${host.enabled ? "enabled" : "disabled"}`,
            `ActiveState=${host.active ? "active" : "inactive"}`,
            "",
          ].join("\n"),
        ),
    },
    "systemctl --user daemon-reload": {
      mutate: () => {
        host.loadedUnit = unitOnDisk();
        host.loadedStamp = unitStamp();
        return ok();
      },
    },
    "systemctl --user enable --now moshpit.service": {
      mutate: () => {
        if (host.loadedUnit === null) return { code: 1, stdout: "", stderr: "Unit moshpit.service not found." };
        host.enabled = true;
        host.active = true;
        return ok();
      },
    },
    [`loginctl show-user ${USER} --property=Linger --value`]: { read: () => ok(host.linger ? "yes\n" : "no\n") },
    [`loginctl enable-linger ${USER}`]: {
      mutate: () => {
        if (!host.lingerAllowed) return { code: 1, stdout: "", stderr: "Access denied" };
        host.linger = true;
        return ok();
      },
    },
    "xdg-settings get default-web-browser": {
      read: () => (host.defaultBrowser ? ok(`${host.defaultBrowser}\n`) : { code: 1, stdout: "", stderr: "no default browser" }),
    },
    [`${herdr} --version`]: { read: () => (host.herdrWorks ? ok("herdr 0.8.2\n") : { code: 1, stdout: "", stderr: "herdr: broken\n" }) },
  };
  return {
    // A launched program (the browser) is recorded with the page it was given,
    // read at launch time, since setup removes that page afterwards.
    async launch(file, args) {
      if (file !== "xdg-open" || args.length !== 1) throw new Error(`unscripted launch: ${[file, ...args].join(" ")}`);
      host.calls.push(`xdg-open ${args[0]}`);
      host.launches.push({ target: args[0], page: existsSync(args[0]) ? readFileSync(args[0], "utf8") : null, mode: existsSync(args[0]) ? statSync(args[0]).mode & 0o777 : null });
      return host.launchResult;
    },
    async run(file, args) {
      const key = [file, ...args].join(" ");
      if (key.startsWith("tailscale serve --bg --https ")) {
        host.calls.push(key);
        host.mutations.push(key);
        const [port, target] = args.slice(3);
        // Real Serve replaces an existing route, so only setup's own check protects one.
        host.serve.set(Number(port), target);
        return afterMutation(key, ok());
      }
      const row = table[key];
      if (!row) throw new Error(`unscripted command: ${key}`);
      host.calls.push(key);
      if (row.read) return row.read();
      host.mutations.push(key);
      return afterMutation(key, row.mutate());
    },
  };
  function afterMutation(key, result) {
    host.onMutation(key);
    if (host.mutations.length === host.crashAtMutation) throw new Error(`crash after ${key}`);
    return result;
  }
}

/** The bridge's private admin socket: it lists host.devices and issues grants that expire five minutes after host.clock. */
function fakeAdmin(host) {
  return async (message, stateDir) => {
    host.adminCalls.push({ ...message, stateDir });
    if (host.adminDown) return { error: { code: "admin_bridge_unreachable", message: "No bridge answered on admin.sock. Start the bridge first." } };
    if (message.action === "devices") return { result: host.devices.map((device) => ({ ...device })) };
    if (message.action === "refusals") return { result: host.refusals.map((entry) => ({ ...entry })) };
    if (message.action === "pair") {
      const secret = randomBytes(16).toString("base64url");
      host.grants.push(secret);
      return { result: { secret, name: message.name, owner: OWNER, expiresAt: host.clock + 5 * 60 * 1000 } };
    }
    throw new Error(`unscripted admin action: ${message.action}`);
  };
}

function approve(host, name) {
  host.devices.push({ id: randomUUID(), name, owner: OWNER, createdAt: host.clock, expiresAt: null, revokedAt: null, active: true });
}

function fakeFetch(host, getPlan) {
  return async (url, init) => {
    const origin = new URL(url);
    const port = Number(origin.port || 443);
    const plan = getPlan();
    assert.equal(init.headers.Origin, plan.publicOrigin);
    if (!host.active || host.serve.get(port) !== `http://127.0.0.1:${plan.bridgePort}`) throw new TypeError("fetch failed");
    return { status: 200, json: async () => ({ protocol: 2 }) };
  };
}

async function scratch(t) {
  const dir = await mkdtemp("/tmp/mps.");
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A disposable machine: temp XDG dirs, an executable herdr and a release file. */
async function machine(t, hostOverrides = {}, { xdg = {} } = {}) {
  const dir = await scratch(t);
  const env = { HOME: dir, XDG_CONFIG_HOME: `${dir}/c`, XDG_STATE_HOME: `${dir}/s`, XDG_DATA_HOME: `${dir}/d`, PATH: `${dir}/bin` };
  for (const [name, leaf] of Object.entries(xdg)) env[name] = `${dir}/${leaf}`;
  await mkdir(`${dir}/bin`);
  const herdr = `${dir}/bin/herdr`;
  await writeFile(herdr, "#!/bin/sh\n", { mode: 0o755 });
  const executable = `${dir}/moshpit-download`;
  await writeFile(executable, "release bytes", { mode: 0o700 });
  const paths = hostPaths(env);
  const host = makeHost(hostOverrides);
  const runner = fakeRunner(host, paths, herdr);
  const context = (options = {}, overrides = {}) => {
    const ctx = {
      runner,
      env,
      paths,
      uid: 1000,
      user: USER,
      arch: "x64",
      glibc: "2.39",
      isTTY: false,
      prompt: async (question) => assert.fail(`unexpected prompt: ${question}`),
      release: { version: VERSION, executable },
      options,
      fetch: fakeFetch(host, () => ctx.plan),
      portFree: async (port) => !host.busyPorts.has(port),
      isAlive: processAlive,
      stdoutIsTTY: false,
      now: () => host.clock,
      admin: fakeAdmin(host),
      onInterrupt: () => () => {},
      sleep: async (ms, signal) => {
        host.clock += ms;
        host.onSleep(ms, signal);
      },
      verifyAttempts: 1,
      verifyDelayMs: 0,
      ...overrides,
    };
    return ctx;
  };
  const setup = (options = { yes: true, allowLinger: true }, overrides = {}, tables = {}) => runSetup(context(options, overrides), tables);
  return { dir, env, paths, host, herdr, executable, context, setup };
}

/** Every file and link under the machine, with the temp prefix replaced, plus the modelled host. */
async function snapshot(m) {
  const entries = {};
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      const key = path.relative(m.dir, file);
      if (entry.isDirectory()) {
        entries[key] = `dir ${((await lstat(file)).mode & 0o777).toString(8)}`;
        await walk(file);
      }
      else if (entry.isSymbolicLink()) entries[key] = `-> ${await readlink(file)}`;
      else entries[key] = `${((await lstat(file)).mode & 0o777).toString(8)} ${(await readFile(file, "utf8")).replaceAll(m.dir, "<dir>")}`;
    }
  }
  await walk(m.dir);
  const { serve, loadedUnit, enabled, active, linger } = m.host;
  return { entries, serve: [...serve], loadedUnit: loadedUnit?.replaceAll(m.dir, "<dir>") ?? null, enabled, active, linger };
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

const statusOf = (result, id) => result.steps.find((entry) => entry.id === id)?.status;

const FRESH_MUTATIONS = [
  "systemctl --user daemon-reload",
  "systemctl --user enable --now moshpit.service",
  `loginctl enable-linger ${USER}`,
  "tailscale serve --bg --https 443 http://127.0.0.1:8801",
];

test("parseTailscaleStatus takes the owner from Self.UserID, strips the DNS dot, and reads tags", () => {
  const json = (self) =>
    JSON.stringify({ BackendState: "Running", Self: self, User: { 7: { LoginName: "first@example.com" }, 9: { LoginName: OWNER } } });
  assert.deepEqual(parseTailscaleStatus(json({ DNSName: `${DNS}.`, UserID: 9 })), { running: true, dnsName: DNS, owner: OWNER, tagged: false });
  assert.equal(parseTailscaleStatus(json({ DNSName: `${DNS}.`, UserID: 9, Tags: ["tag:server"] })).tagged, true);
  assert.equal(parseTailscaleStatus(json({ DNSName: `${DNS}.`, UserID: 5 })).owner, null);
  assert.equal(parseTailscaleStatus(JSON.stringify({ BackendState: "NeedsLogin", Self: {} })).running, false);
});

test("parseServeStatus maps each occupied port to its proxy target", () => {
  const observed = '{"TCP":{"8803":{"HTTPS":true}},"Web":{"host:8803":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:8801"}}}}}';
  assert.deepEqual([...parseServeStatus(observed)], [[8803, "http://127.0.0.1:8801"]]);
  assert.deepEqual([...parseServeStatus("{}")], []);
  const forward = JSON.stringify({ TCP: { 443: { TCPForward: "127.0.0.1:22" } } });
  assert.deepEqual([...parseServeStatus(forward)], [[443, "tcp forward to 127.0.0.1:22"]]);
});

test("a fresh install runs the expected commands once and ends awaiting its first device", async (t) => {
  const m = await machine(t);
  const { result, exitCode } = await m.setup();
  assert.equal(exitCode, 0, JSON.stringify(result));
  assert.equal(result.state, "installed, awaiting first device");
  assert.deepEqual(
    result.steps.map((entry) => [entry.id, entry.status]),
    [
      ["preflight", "done"],
      ["confirm", "done"],
      ["staged", "done"],
      ["configured", "done"],
      ["service-started", "done"],
      ["persistence", "done"],
      ["serve-configured", "done"],
      ["verified", "done"],
    ],
  );
  const show = "systemctl --user show moshpit.service --property=LoadState,NeedDaemonReload,UnitFileState,ActiveState";
  assert.deepEqual(m.host.calls, [
    // preflight
    "systemctl --user is-system-running",
    "systemctl --user show moshpit-bridge.service --property=LoadState,NeedDaemonReload,UnitFileState,ActiveState",
    "tailscale status --json",
    "tailscale debug prefs",
    `${m.herdr} --version`,
    "tailscale serve status --json",
    // confirm: which steps would change
    "tailscale serve status --json",
    // service-started: apply (show, reload, show, enable), then isDone
    show,
    "systemctl --user daemon-reload",
    show,
    "systemctl --user enable --now moshpit.service",
    show,
    // persistence: isDone, snapshot, apply, isDone
    `loginctl show-user ${USER} --property=Linger --value`,
    `loginctl show-user ${USER} --property=Linger --value`,
    `loginctl enable-linger ${USER}`,
    `loginctl show-user ${USER} --property=Linger --value`,
    // serve-configured: isDone, conflict, snapshot, apply, isDone
    "tailscale serve status --json",
    "tailscale serve status --json",
    "tailscale serve status --json",
    "tailscale serve --bg --https 443 http://127.0.0.1:8801",
    "tailscale serve status --json",
  ]);
  assert.deepEqual(m.host.mutations, FRESH_MUTATIONS);

  const config = JSON.parse(await readFile(m.paths.config, "utf8"));
  assert.deepEqual(config, {
    schemaVersion: 1,
    authMode: "tailscale",
    trustedOwner: OWNER,
    publicOrigin: `https://${DNS}`,
    allowedAuthorities: [DNS],
    bind: "127.0.0.1",
    port: 8801,
    herdrBin: m.herdr,
    stateDir: m.paths.state,
  });
  assert.equal((await lstat(m.paths.config)).mode & 0o777, 0o600);
  assert.equal(await readlink(m.paths.current), `releases/${VERSION}`);
  assert.equal((await lstat(m.paths.release(VERSION))).mode & 0o777, 0o755);
  assert.equal(await readFile(m.paths.currentExecutable, "utf8"), "release bytes");
  const unit = await readFile(m.paths.unit, "utf8");
  assert.match(unit, new RegExp(`^ExecStart="${m.dir}/d/moshpit/current/moshpit" bridge$`, "m"));
  assert.match(unit, new RegExp(`^Environment="MOSHPIT_CONFIG=${m.paths.config}"$`, "m"));
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^WantedBy=default.target$/m);
  const journal = JSON.parse(await readFile(m.paths.journal, "utf8"));
  assert.deepEqual(Object.keys(journal.steps), ["staged", "configured", "service-started", "persistence", "serve-configured", "verified"]);
  assert.equal(journal.schemaVersion, 1);
  assert.deepEqual(journal.steps["serve-configured"], { previous: { port: 443, target: null }, at: NOW });
  assert.equal(existsSync(m.paths.lock), false, "the lock is released");
});

test("a rerun on a finished host changes nothing and exits 0", async (t) => {
  const m = await machine(t);
  await m.setup();
  const before = await snapshot(m);
  m.host.mutations.length = 0;
  const { result, exitCode } = await m.setup();
  assert.equal(exitCode, 0);
  assert.deepEqual(m.host.mutations, []);
  assert.deepEqual(await snapshot(m), before);
  assert.equal(statusOf(result, "confirm"), "skipped");
  for (const step of STEPS) assert.equal(statusOf(result, step.id), step.id === "verified" ? "done" : "skipped", step.id);
  // Without --yes on a non-TTY too: nothing to confirm when nothing changes.
  assert.equal((await m.setup({ allowLinger: true })).exitCode, 0);
  assert.deepEqual(m.host.mutations, []);
});

test("the state is complete once the admin socket reports an approved device", async (t) => {
  const m = await machine(t);
  approve(m.host, "Dana's phone");
  assert.equal((await m.setup()).result.state, "complete");
});

async function reference(t) {
  const m = await machine(t);
  const { exitCode } = await m.setup();
  assert.equal(exitCode, 0);
  return { snapshot: await snapshot(m), mutations: [...m.host.mutations] };
}

test("a crash after any mutating command resumes without repeating it", async (t) => {
  const expected = await reference(t);
  for (let crashAt = 1; crashAt <= FRESH_MUTATIONS.length; crashAt++) {
    const m = await machine(t, { crashAtMutation: crashAt });
    const crashed = await m.setup();
    assert.notEqual(crashed.exitCode, 0, `crash ${crashAt}`);
    m.host.crashAtMutation = 0;
    const resumed = await m.setup();
    assert.equal(resumed.exitCode, 0, `resume after crash ${crashAt}: ${JSON.stringify(resumed.result)}`);
    assert.deepEqual(m.host.mutations, expected.mutations, `crash ${crashAt}: no mutating command repeated`);
    assert.deepEqual(await snapshot(m), expected.snapshot, `crash ${crashAt}: same end state`);
  }
});

test("a crash after each step's apply resumes to the same journal and resources", async (t) => {
  const expected = await reference(t);
  for (const target of STEPS.filter((step) => step.id !== "verified")) {
    const m = await machine(t);
    const steps = STEPS.map((step) =>
      step.id === target.id ?
        {
          ...step,
          async apply(ctx) {
            await step.apply(ctx);
            throw new Error(`crash after ${step.id}`);
          },
        }
      : step,
    );
    const crashed = await m.setup(undefined, {}, { steps });
    assert.equal(statusOf(crashed.result, target.id), "failed", target.id);
    const resumed = await m.setup();
    assert.equal(resumed.exitCode, 0, `${target.id}: ${JSON.stringify(resumed.result)}`);
    assert.equal(statusOf(resumed.result, target.id), "skipped", `${target.id} is found in place`);
    assert.deepEqual(m.host.mutations, expected.mutations, `${target.id}: no mutating command repeated`);
    assert.deepEqual(await snapshot(m), expected.snapshot, `${target.id}: same journal and resources`);
  }
});

test("a failure inside each step's apply, before it changes anything, resumes", async (t) => {
  const expected = await reference(t);
  for (const target of STEPS.filter((step) => step.id !== "verified")) {
    const m = await machine(t);
    const steps = STEPS.map((step) =>
      step.id === target.id ?
        {
          ...step,
          async apply() {
            throw new Error(`failed inside ${step.id}`);
          },
        }
      : step,
    );
    const failed = await m.setup(undefined, {}, { steps });
    assert.equal(statusOf(failed.result, target.id), "failed", target.id);
    const resumed = await m.setup();
    assert.equal(resumed.exitCode, 0, `${target.id}: ${JSON.stringify(resumed.result)}`);
    assert.deepEqual(m.host.mutations, expected.mutations, `${target.id}: no mutating command repeated`);
    assert.deepEqual(await snapshot(m), expected.snapshot, `${target.id}: same journal and resources`);
  }
});

const PREFLIGHT_FAILURES = [
  { name: "source checkout", code: 10, ctx: { release: null } },
  { name: "unsafe release version", code: 10, ctx: { release: { version: "../x", executable: "/bin/true" } } },
  { name: "unsupported arch", code: 11, ctx: { arch: "ia32" } },
  { name: "musl", code: 12, ctx: { glibc: null }, detail: /container image/ },
  { name: "root", code: 13, ctx: { uid: 0 }, detail: /useradd/ },
  { name: "no user manager", code: 14, host: { manager: "offline" } },
  { name: "legacy service", code: 15, host: { legacy: true }, detail: /moshpit config migrate/ },
  { name: "tailscale missing", code: 16, host: { tailscaleInstalled: false } },
  {
    name: "tailscale signed out",
    code: 16,
    host: { tailscale: { BackendState: "NeedsLogin", Self: { DNSName: "", UserID: 2 }, User: {} } },
  },
  {
    name: "tagged node",
    code: 17,
    host: {
      tailscale: { BackendState: "Running", Self: { DNSName: `${DNS}.`, UserID: 1, Tags: ["tag:server"] }, User: { 1: { LoginName: "tagged-devices" } } },
    },
    detail: /tagged, so no user owns it/,
  },
  { name: "no Tailscale operator", code: 23, host: { operator: "" }, detail: /operator is not set, not dana\. .*\n {2}sudo tailscale set --operator=dana$/ },
  { name: "another Tailscale operator", code: 23, host: { operator: "root" }, detail: /operator is root, not dana\. .*\n {2}sudo tailscale set --operator=dana$/ },
  { name: "config for another owner", code: 18, config: { trustedOwner: "someone@example.com" }, detail: /never changes the owner/ },
  { name: "unreadable config", code: 18, configText: "{" },
  { name: "unreadable journal", code: 18, journalText: '{"schemaVersion":9}', detail: /restore it/ },
  { name: "herdr broken", code: 19, host: { herdrWorks: false } },
  { name: "herdr missing", code: 19, noHerdr: true },
  {
    name: "both HTTPS ports taken",
    code: 20,
    host: { serve: new Map([[443, "http://127.0.0.1:3000"], [8803, "http://127.0.0.1:4000"]]) },
  },
  { name: "no loopback port", code: 21, host: { busyPorts: new Set([8801, 8802, 8803, 8804, 8805, 8806, 8807, 8808, 8809, 8810]) } },
];

const existingConfig = (m, overrides = {}) => ({
  schemaVersion: 1,
  authMode: "tailscale",
  trustedOwner: OWNER,
  publicOrigin: `https://${DNS}:8803`,
  allowedAuthorities: [`${DNS}:8803`],
  bind: "127.0.0.1",
  port: 8801,
  herdrBin: m.herdr,
  stateDir: m.paths.state,
  ...overrides,
});

async function writeConfig(m, text) {
  await mkdir(path.dirname(m.paths.config), { recursive: true, mode: 0o700 });
  await writeFile(m.paths.config, text, { mode: 0o600 });
}

test("each preflight failure has its own exit code and changes nothing", async (t) => {
  for (const scenario of PREFLIGHT_FAILURES) {
    const m = await machine(t, scenario.host);
    if (scenario.config) await writeConfig(m, JSON.stringify(existingConfig(m, scenario.config)));
    if (scenario.configText) await writeConfig(m, scenario.configText);
    if (scenario.noHerdr) await unlink(m.herdr);
    if (scenario.journalText) {
      await mkdir(m.paths.state, { recursive: true, mode: 0o700 });
      await writeFile(m.paths.journal, scenario.journalText, { mode: 0o600 });
    }
    const before = await snapshot(m);
    const { result, exitCode } = await m.setup({ yes: true, allowLinger: true }, scenario.ctx);
    assert.equal(exitCode, scenario.code, `${scenario.name}: ${JSON.stringify(result)}`);
    assert.equal(result.ok, false);
    assert.equal(statusOf(result, "preflight"), "failed", scenario.name);
    if (scenario.detail) assert.match(result.steps[0].detail, scenario.detail, scenario.name);
    assert.deepEqual(m.host.mutations, [], `${scenario.name}: no mutating command`);
    assert.deepEqual(await snapshot(m), before, `${scenario.name}: no file changed`);
  }
});

test("parseOperatorUser reads only OperatorUser and refuses anything else", () => {
  assert.equal(parseOperatorUser('{"OperatorUser":"dana","Config":{"PrivateNodeKey":"privkey:0"}}'), "dana");
  assert.equal(parseOperatorUser('{"OperatorUser":""}'), "");
  for (const text of ["", "not json", "null", "{}", '{"OperatorUser":null}', '{"OperatorUser":7}'])
    assert.throws(() => parseOperatorUser(text), text);
});

test("the operator row passes for this user and reports unknown, without failing, when debug prefs cannot be read", async (t) => {
  const set = await machine(t);
  const installed = await set.setup();
  assert.equal(installed.exitCode, 0, JSON.stringify(installed.result));
  assert.equal(installed.result.steps[0].detail, "14 checks passed");

  const unreadable = [
    ["not JSON", { code: 0, stdout: "Prefs{ra=false mesh=true}\n", stderr: "" }],
    ["no OperatorUser", ok('{"WantRunning":true}')],
    ["a failed command", { code: 1, stdout: "", stderr: "tailscale: unknown subcommand debug\n" }],
  ];
  for (const [name, prefs] of unreadable) {
    const m = await machine(t, { prefs });
    const { result, exitCode } = await m.setup();
    assert.equal(exitCode, 0, `${name}: ${JSON.stringify(result)}`);
    assert.equal(result.state, "installed, awaiting first device", name);
    assert.match(result.steps[0].detail, /^13 checks passed; tailscale-operator unknown: tailscale debug prefs did not give an operator/, name);
    assert.deepEqual(m.host.mutations, FRESH_MUTATIONS, name);
  }
});

test("an installed host whose Serve route is in place skips the operator row on a rerun and on --recover", async (t) => {
  const m = await machine(t);
  assert.equal((await m.setup()).exitCode, 0);
  m.host.operator = "";
  const before = await snapshot(m);
  const installCalls = m.host.calls.length;
  const rerun = await m.setup();
  assert.equal(rerun.exitCode, 0, JSON.stringify(rerun.result));
  assert.equal(rerun.result.steps[0].detail, "13 checks passed; tailscale-operator skipped: Serve already proxies port 443 to this bridge");
  assert.equal(m.host.calls.slice(installCalls).includes("tailscale debug prefs"), false, "the rerun never asked for the operator");
  approve(m.host, "Chrome on Android");
  const recovered = await runCli(m, ["--recover", "--emit-link", "--json"]);
  assert.equal(recovered.exitCode, 0, recovered.stderr);
  assert.deepEqual(m.host.mutations, FRESH_MUTATIONS, "nothing changed on the host");
  assert.deepEqual((await snapshot(m)).serve, before.serve);

  // A migrated config whose route is already in place has no journal, and needs no operator either.
  const migrated = await machine(t, { operator: "", serve: new Map([[8803, "http://127.0.0.1:8801"]]) });
  await writeConfig(migrated, JSON.stringify(existingConfig(migrated)));
  const adopted = await migrated.setup();
  assert.equal(adopted.exitCode, 0, JSON.stringify(adopted.result));
  assert.match(adopted.result.steps[0].detail, /tailscale-operator skipped: Serve already proxies port 8803 to this bridge/);
  assert.equal(migrated.host.mutations.some((call) => call.startsWith("tailscale serve")), false);

  // Without its route the host needs Serve again, so the operator matters.
  m.host.serve.delete(443);
  const moved = await m.setup();
  assert.equal(moved.exitCode, 23, JSON.stringify(moved.result));
  assert.equal(m.host.mutations.length, FRESH_MUTATIONS.length, "refused before any change");
});

test("443 taken by another target moves a fresh install to 8803 and leaves 443 alone", async (t) => {
  const m = await machine(t, { serve: new Map([[443, "http://127.0.0.1:3000"]]) });
  const { result, exitCode } = await m.setup();
  assert.equal(exitCode, 0, JSON.stringify(result));
  assert.equal(JSON.parse(await readFile(m.paths.config, "utf8")).publicOrigin, `https://${DNS}:8803`);
  assert.deepEqual([...m.host.serve], [[443, "http://127.0.0.1:3000"], [8803, "http://127.0.0.1:8801"]]);
});

test("--port only requests a port on a fresh install and never moves an existing origin", async (t) => {
  const requested = await machine(t);
  assert.equal((await requested.setup({ yes: true, allowLinger: true, port: 8803 })).exitCode, 0);
  assert.equal(JSON.parse(await readFile(requested.paths.config, "utf8")).publicOrigin, `https://${DNS}:8803`);

  const taken = await machine(t, { serve: new Map([[443, "http://127.0.0.1:3000"]]) });
  const refused = await taken.setup({ yes: true, allowLinger: true, port: 443 });
  assert.equal(refused.exitCode, 20);
  assert.deepEqual(taken.host.mutations, []);

  const m = await machine(t);
  await m.setup();
  m.host.mutations.length = 0;
  const moved = await m.setup({ yes: true, allowLinger: true, port: 8803 });
  assert.equal(moved.exitCode, 20);
  assert.match(moved.result.steps[0].detail, /cannot move an existing origin/);
  assert.deepEqual(m.host.mutations, []);
  assert.equal(JSON.parse(await readFile(m.paths.config, "utf8")).publicOrigin, `https://${DNS}`);
});

test("a Serve route that points elsewhere is a conflict, is not overwritten, and unrelated routes survive", async (t) => {
  // Another process takes 443 while setup is starting the service.
  const m = await machine(t, { serve: new Map([[8802, "http://127.0.0.1:9000"]]) });
  m.host.onMutation = (key) => {
    if (key.startsWith("systemctl --user enable")) m.host.serve.set(443, "http://127.0.0.1:3000");
  };
  const { result, exitCode } = await m.setup();
  assert.equal(exitCode, 33, JSON.stringify(result));
  assert.equal(statusOf(result, "serve-configured"), "failed");
  assert.equal(statusOf(result, "verified"), "pending");
  assert.deepEqual([...m.host.serve], [[8802, "http://127.0.0.1:9000"], [443, "http://127.0.0.1:3000"]]);
  assert.equal(m.host.mutations.some((call) => call.startsWith("tailscale serve --bg")), false);

  // On a rerun the configured port is checked in preflight, before any change.
  m.host.onMutation = () => {};
  m.host.mutations.length = 0;
  const rerun = await m.setup();
  assert.equal(rerun.exitCode, 20);
  assert.deepEqual(m.host.mutations, []);
  assert.equal(m.host.serve.get(443), "http://127.0.0.1:3000");
});

test("linger is blocked without --allow-linger, never implied by --yes, and applied with the flag", async (t) => {
  const m = await machine(t);
  const blocked = await m.setup({ yes: true });
  assert.equal(blocked.exitCode, 32, JSON.stringify(blocked.result));
  assert.equal(statusOf(blocked.result, "persistence"), "blocked");
  assert.equal(statusOf(blocked.result, "serve-configured"), "done", "later steps continue");
  assert.equal(statusOf(blocked.result, "verified"), "done");
  assert.equal(blocked.result.state, "installed, awaiting persistence");
  assert.equal(m.host.mutations.includes(`loginctl enable-linger ${USER}`), false);
  assert.equal(m.host.linger, false);

  const allowed = await m.setup({ yes: true, allowLinger: true });
  assert.equal(allowed.exitCode, 0);
  assert.equal(allowed.result.state, "installed, awaiting first device");
  assert.deepEqual(m.host.mutations.filter((call) => call.startsWith("loginctl")), [`loginctl enable-linger ${USER}`]);
});

test("on a TTY the operator confirms the machine and is asked about linger separately", async (t) => {
  const m = await machine(t);
  const questions = [];
  const prompt = async (question) => {
    questions.push(question);
    return !question.startsWith("Keep moshpit running");
  };
  const { result, exitCode } = await m.setup({}, { isTTY: true, prompt });
  assert.equal(exitCode, 32);
  assert.match(questions[0], new RegExp(`${DNS} for ${OWNER}`));
  assert.match(questions[1], /enable-linger dana/);
  assert.equal(questions.length, 2);
  assert.equal(statusOf(result, "persistence"), "blocked");

  const declined = await machine(t);
  const refused = await declined.setup({}, { isTTY: true, prompt: async () => false });
  assert.equal(refused.exitCode, 30);
  assert.deepEqual(declined.host.mutations, []);
});

test("a non-TTY run without --yes is blocked before any change", async (t) => {
  const m = await machine(t);
  const before = await snapshot(m);
  const { result, exitCode } = await m.setup({ allowLinger: true });
  assert.equal(exitCode, 30);
  assert.equal(statusOf(result, "confirm"), "blocked");
  assert.match(result.steps[1].detail, new RegExp(`machine ${DNS}, account ${OWNER}`));
  assert.deepEqual(m.host.mutations, []);
  assert.deepEqual(await snapshot(m), before);
});

async function deadPid() {
  const child = spawn(process.execPath, ["-e", ""]);
  await once(child, "exit");
  return child.pid;
}

test("the lock refuses a concurrent run and takes over a stale one", async (t) => {
  const m = await machine(t);
  await mkdir(m.paths.state, { recursive: true, mode: 0o700 });
  await writeFile(m.paths.lock, `${process.pid}\n`);
  const locked = await m.setup();
  assert.equal(locked.exitCode, 31);
  assert.equal(statusOf(locked.result, "lock"), "blocked");
  assert.deepEqual(m.host.mutations, []);
  assert.equal(await readFile(m.paths.lock, "utf8"), `${process.pid}\n`, "a live holder's lock is left alone");

  await writeFile(m.paths.lock, `${await deadPid()}\n`);
  const { exitCode } = await m.setup();
  assert.equal(exitCode, 0);
  assert.equal(existsSync(m.paths.lock), false);
});

function captureIo() {
  const out = [];
  const err = [];
  return { io: { stdout: { write: (text) => out.push(text) }, stderr: { write: (text) => err.push(text) }, exitCode: undefined }, out, err };
}

/** The result of one `--json` run, after the envelope schema and the step-result shape are asserted. */
function resultOf(stdout, command, exitCode) {
  const envelope = parseEnvelope(stdout, command, { exitCode });
  assertResultShape(envelope.result);
  return envelope.result;
}

function assertResultShape(result) {
  assert.deepEqual(
    Object.keys(result).filter((key) => !["state", "steps", "next", "setupLink"].includes(key)),
    [],
    "ok lives on the envelope, not the result",
  );
  assert.equal(typeof result.state, "string");
  if ("next" in result) assert.equal(typeof result.next, "string");
  for (const entry of result.steps) {
    assert.deepEqual(Object.keys(entry), ["id", "status", "detail"]);
    assert.ok(["done", "skipped", "blocked", "failed", "pending"].includes(entry.status), entry.status);
    assert.equal(typeof entry.detail, "string");
  }
}

test("--json prints exactly one result object, on success and on failure", async (t) => {
  for (const [hostOverrides, expectedCode] of [[{}, 0], [{ legacy: true }, 15]]) {
    const m = await machine(t, hostOverrides);
    const { io, out, err } = captureIo();
    await main("setup", ["--json", "--yes", "--allow-linger"], { io, context: ({ options }) => m.context(options) });
    assert.equal(io.exitCode, expectedCode);
    assert.equal(out.length, 1);
    const envelope = parseEnvelope(out[0], "setup", { exitCode: expectedCode });
    assertResultShape(envelope.result);
    if (expectedCode) assert.equal(envelope.error.code, envelope.result.steps.find((entry) => entry.status === "failed" || entry.status === "blocked").id, "the error names the step that stopped the run");
    assert.deepEqual(err, []);
  }
});

test("human output and --json carry the same wording", async (t) => {
  const m = await machine(t, { legacy: true });
  const json = captureIo();
  await main("setup", ["--json"], { io: json.io, context: ({ options }) => m.context(options) });
  const human = captureIo();
  await main("setup", [], { io: human.io, context: ({ options }) => m.context(options) });
  const detail = resultOf(json.out[0], "setup", 15).steps[0].detail;
  assert.equal(human.io.exitCode, 15);
  assert.ok(human.err.join("").includes(detail.split("\n")[0]), "the failure prose goes to stderr");
  assert.match(human.out.join(""), /^state: not installed$/m);
});

test("status reads without changing anything or taking the lock", async (t) => {
  const m = await machine(t);
  const empty = await snapshot(m);
  const fresh = await readStatus(m.context());
  assert.equal(fresh.exitCode, 3);
  assert.equal(fresh.result.state, "not installed");
  assert.deepEqual(await snapshot(m), empty);

  await m.setup();
  m.host.calls.length = 0;
  m.host.mutations.length = 0;
  const before = await snapshot(m);
  const { io, out } = captureIo();
  await main("status", ["--json"], { io, context: ({ options }) => m.context(options) });
  const result = resultOf(out[0], "status", 0);
  assert.equal(io.exitCode, 0);
  assert.equal(result.state, "installed, awaiting first device");
  assert.match(result.steps.find((entry) => entry.id === "staged").detail, new RegExp(VERSION));
  for (const step of STEPS) assert.equal(statusOf(result, step.id), "done", step.id);
  assert.deepEqual(m.host.mutations, []);
  assert.ok(m.host.calls.length > 0);
  assert.deepEqual(await snapshot(m), before);
});

test("a step the journal marks done is applied again when its resource drifted", async (t) => {
  const m = await machine(t);
  await m.setup();
  // Someone removed the unit and reloaded the manager, which stops the service.
  await unlink(m.paths.unit);
  Object.assign(m.host, { loadedUnit: null, enabled: false, active: false });
  m.host.mutations.length = 0;
  const status = await readStatus(m.context());
  assert.equal(statusOf(status.result, "service-started"), "pending");
  assert.match(status.result.steps.find((entry) => entry.id === "service-started").detail, /journal says done/);

  const { result, exitCode } = await m.setup();
  assert.equal(exitCode, 0, JSON.stringify(result));
  assert.equal(statusOf(result, "service-started"), "done");
  assert.match(result.steps.find((entry) => entry.id === "service-started").detail, /had drifted/);
  assert.ok(existsSync(m.paths.unit));
  assert.deepEqual(m.host.mutations, ["systemctl --user daemon-reload", "systemctl --user enable --now moshpit.service"]);
});

test("a deleted unit of a running service is rewritten and reloaded without re-enabling it", async (t) => {
  const m = await machine(t);
  await m.setup();
  await unlink(m.paths.unit);
  m.host.mutations.length = 0;
  const { result, exitCode } = await m.setup();
  assert.equal(exitCode, 0, JSON.stringify(result));
  assert.match(result.steps.find((entry) => entry.id === "service-started").detail, /had drifted/);
  assert.deepEqual(m.host.mutations, ["systemctl --user daemon-reload"]);
  assert.match(await readFile(m.paths.unit, "utf8"), /bridge\n/);
});

test("verification needs a 200 with a numeric protocol and never reports the host installed without it", async (t) => {
  for (const [name, answer] of [
    ["not a bridge", async () => ({ status: 200, json: async () => ({ hello: "world" }) })],
    ["refused", async () => ({ status: 403, json: async () => ({ protocol: 2 }) })],
    ["unreachable", async () => Promise.reject(new TypeError("fetch failed"))],
  ]) {
    const m = await machine(t);
    const { result, exitCode } = await m.setup(undefined, { fetch: answer });
    assert.equal(exitCode, 34, name);
    assert.equal(statusOf(result, "verified"), "failed", name);
    assert.equal(result.state, "serve-configured", name);
    assert.equal(JSON.parse(await readFile(m.paths.journal, "utf8")).steps.verified.at, undefined, name);
  }
});

test("a checkout refuses setup through the CLI", async (t) => {
  const m = await machine(t);
  const { io, out } = captureIo();
  await main("setup", ["--json"], { release: null, io, context: ({ release, options }) => m.context(options, { release }) });
  assert.equal(io.exitCode, 10);
  assert.match(resultOf(out[0], "setup", 10).steps[0].detail, /npm run build:release/);
  assert.deepEqual(m.host.calls, []);
});

test("a config moved aside on an installed host refuses before any change and names the origin", async (t) => {
  const m = await machine(t);
  await m.setup();
  const aside = `${m.paths.config}.aside`;
  await writeFile(aside, await readFile(m.paths.config));
  await unlink(m.paths.config);
  m.host.mutations.length = 0;
  const before = await snapshot(m);
  const { result, exitCode } = await m.setup();
  assert.equal(exitCode, 18, JSON.stringify(result));
  assert.match(result.steps[0].detail, /restore/i);
  assert.match(result.steps[0].detail, new RegExp(`https://${DNS}(?![:0-9])`));
  assert.doesNotMatch(result.steps[0].detail, /move it aside/);
  assert.deepEqual(m.host.mutations, []);
  assert.deepEqual(await snapshot(m), before);
  assert.deepEqual([...m.host.serve], [[443, "http://127.0.0.1:8801"]]);

  await writeFile(m.paths.config, await readFile(aside), { mode: 0o600 });
  assert.equal((await m.setup()).exitCode, 0);
  assert.deepEqual(m.host.mutations, []);
});

test("a journaled install never suggests moving its config aside", async (t) => {
  const m = await machine(t);
  await m.setup();
  await writeFile(m.paths.config, "{");
  const invalid = await m.setup();
  assert.equal(invalid.exitCode, 18);
  assert.doesNotMatch(invalid.result.steps[0].detail, /aside/);
  await writeFile(m.paths.config, JSON.stringify(existingConfig(m, { publicOrigin: `https://${DNS}`, allowedAuthorities: [DNS], trustedOwner: "else@example.com" })));
  const owner = await m.setup();
  assert.equal(owner.exitCode, 18);
  assert.doesNotMatch(owner.result.steps[0].detail, /aside/);
});

test("a path the unit cannot represent is refused at preflight; spaces and % are kept", async (t) => {
  for (const leaf of ["d$HOME", 'd"q', "d\\b", "d'q"]) {
    const m = await machine(t, {}, { xdg: { XDG_DATA_HOME: leaf } });
    const before = await snapshot(m);
    const { result, exitCode } = await m.setup();
    assert.equal(exitCode, 22, `${leaf}: ${JSON.stringify(result)}`);
    assert.match(result.steps[0].detail, /^paths: /);
    assert.deepEqual(m.host.mutations, [], leaf);
    assert.deepEqual(await snapshot(m), before, leaf);
  }
  const config = await machine(t, {}, { xdg: { XDG_CONFIG_HOME: "c$x" } });
  assert.equal((await config.setup()).exitCode, 22);

  const spaced = await machine(t, {}, { xdg: { XDG_DATA_HOME: "my data%" } });
  assert.equal((await spaced.setup()).exitCode, 0);
  assert.match(await readFile(spaced.paths.unit, "utf8"), new RegExp(`^ExecStart="${spaced.dir}/my data%%/moshpit/current/moshpit" bridge$`, "m"));
});

test("a hand-written moshpit.service is a conflict and is left alone", async (t) => {
  const m = await machine(t);
  const handWritten = "[Service]\nExecStart=/opt/mine/bridge --secret-flag hunter2\n";
  await mkdir(path.dirname(m.paths.unit), { recursive: true });
  await writeFile(m.paths.unit, handWritten);
  const { result, exitCode } = await m.setup();
  assert.equal(exitCode, 33, JSON.stringify(result));
  assert.equal(statusOf(result, "service-started"), "failed");
  assert.equal(await readFile(m.paths.unit, "utf8"), handWritten);
  assert.equal(m.host.mutations.some((call) => call.startsWith("systemctl")), false);
  const journal = await readFile(m.paths.journal, "utf8");
  assert.doesNotMatch(journal, /hunter2|ExecStart/);
});

test("the journal records a hash of the unit it replaced, never its text, per attempt", async (t) => {
  const m = await machine(t);
  // The operator placed setup's own unit text before the first run.
  await mkdir(path.dirname(m.paths.unit), { recursive: true });
  await writeFile(m.paths.unit, unitText(m.paths));
  assert.equal((await m.setup()).exitCode, 0);
  const first = JSON.parse(await readFile(m.paths.journal, "utf8")).steps["service-started"];
  assert.deepEqual(first, { previous: { unitSha256: sha256(unitText(m.paths)) }, at: NOW });

  // A later attempt replaces a missing unit: its previous is what that attempt found.
  await unlink(m.paths.unit);
  Object.assign(m.host, { loadedUnit: null, enabled: false, active: false });
  assert.equal((await m.setup()).exitCode, 0);
  const second = JSON.parse(await readFile(m.paths.journal, "utf8")).steps["service-started"];
  assert.deepEqual(second, { previous: { unitSha256: null }, at: NOW });
  assert.doesNotMatch(await readFile(m.paths.journal, "utf8"), /ExecStart/);
});

test("a legacy unit query that fails says so instead of claiming the service is installed", async (t) => {
  const m = await machine(t, { legacyQueryFails: true });
  const { result, exitCode } = await m.setup();
  assert.equal(exitCode, 15);
  assert.match(result.steps[0].detail, /could not query/);
  assert.match(result.steps[0].detail, /Failed to connect to bus: No medium found/);
  assert.doesNotMatch(result.steps[0].detail, /from the checkout helper is installed/);
  assert.deepEqual(m.host.mutations, []);
});

// The setup link. Each run goes through main, the way the CLI calls it, so
// what reaches stdout, stderr and --json is what is asserted.

const LINK_PREFIX = `https://${DNS}/#moshpit-setup=`;

async function runCli(m, argv, overrides = {}) {
  const captured = captureIo();
  await main("setup", ["--yes", "--allow-linger", ...argv], { io: captured.io, context: ({ options }) => m.context(options, overrides) });
  return { ...captured, stdout: captured.out.join(""), stderr: captured.err.join(""), exitCode: captured.io.exitCode };
}

const pollsOf = (host) => host.adminCalls.filter((call) => call.action === "devices");
const grantsOf = (host) => host.adminCalls.filter((call) => call.action === "pair");

test("on a terminal a fresh host issues one grant, prints the link and a QR, and completes when a browser is approved", async (t) => {
  const m = await machine(t);
  const sleeps = [];
  m.host.onSleep = (ms) => {
    if (ms === 0) return;
    sleeps.push(ms);
    if (sleeps.length === 3) approve(m.host, "Chrome on Android");
  };
  const run = await runCli(m, [], { stdoutIsTTY: true });
  assert.equal(run.exitCode, 0, run.stderr);
  assert.equal(m.host.grants.length, 1);
  assert.deepEqual(grantsOf(m.host).map((call) => [call.name, call.stateDir]), [["First browser", `${m.env.XDG_STATE_HOME}/moshpit`]]);
  const [secret] = m.host.grants;
  assert.ok(run.stdout.includes(`  ${LINK_PREFIX}${secret}\n`), run.stdout);
  assert.match(run.stdout, /[▀▄█]{10}/, "a terminal QR follows the link");
  assert.match(run.stderr, /Waiting for the browser: 5:00 left/);
  assert.match(run.stderr, /4:56 left/);
  assert.deepEqual(sleeps, [2000, 2000, 2000], "polls every 2 s and stops at the approval");
  // One listing before the grant, then one per sleep.
  assert.equal(pollsOf(m.host).length - 1 - 1, sleeps.length, "the state check, the baseline, then one poll per sleep");
  assert.match(run.stdout, /^done +setup-link +"Chrome on Android" is approved$/m);
  assert.match(run.stdout, /^state: complete$/m);
  assert.doesNotMatch(run.stdout, /^next:/m);
});

/** A machine whose setup approves a browser on the third poll, with `env` added to its environment. */
async function desktop(t, env = {}) {
  const m = await machine(t);
  await mkdir(`${m.dir}/run`, { mode: 0o700 });
  const withEnv = { ...m.env, XDG_RUNTIME_DIR: `${m.dir}/run`, ...env };
  m.host.onSleep = (ms) => {
    if (ms && pollsOf(m.host).length === 3) approve(m.host, "Firefox on Linux");
  };
  return { m, cli: (argv = [], overrides = {}) => runCli(m, argv, { stdoutIsTTY: true, env: withEnv, ...overrides }) };
}

test("with a display and no SSH session, setup opens the link in a local browser through a private page, and still prints it", async (t) => {
  for (const display of [{ DISPLAY: ":0" }, { WAYLAND_DISPLAY: "wayland-0" }]) {
    const { m, cli } = await desktop(t, display);
    const run = await cli();
    assert.equal(run.exitCode, 0, run.stderr);
    const [secret] = m.host.grants;
    const link = `${LINK_PREFIX}${secret}`;
    assert.equal(m.host.launches.length, 1, "xdg-open runs once");
    const [launch] = m.host.launches;
    assert.match(launch.target, new RegExp(`^${m.dir}/run/moshpit-setup-[0-9a-f-]{36}\\.html$`));
    assert.equal(launch.target.includes(secret), false, "the capability is not on the command line");
    assert.equal(launch.mode, 0o600);
    assert.ok(launch.page.includes(`location.replace(${JSON.stringify(link)})`), launch.page);
    assert.equal(existsSync(launch.target), false, "the page is removed when the wait ends");
    assert.ok(run.stdout.includes(`  ${link}\n`), "the link is printed too");
    assert.match(run.stdout, /[▀▄█]{10}/, "and the QR");
    assert.doesNotMatch(run.stdout, /Could not open a browser/);
    assert.match(run.stdout, /^state: complete$/m);
    assert.deepEqual(m.host.mutations, FRESH_MUTATIONS, "opening a browser is not a host change");
  }
});

test("without XDG_RUNTIME_DIR the page goes in the private state directory", async (t) => {
  const { m, cli } = await desktop(t, { DISPLAY: ":0", XDG_RUNTIME_DIR: undefined });
  assert.equal((await cli()).exitCode, 0);
  assert.equal(path.dirname(m.host.launches[0].target), m.paths.state);
});

test("over SSH, without a display, with --emit-link or without a terminal, setup never opens a browser", async (t) => {
  const cases = [
    ["SSH_CONNECTION", { DISPLAY: ":0", SSH_CONNECTION: "10.0.0.2 51000 10.0.0.1 22" }],
    ["SSH_CLIENT", { WAYLAND_DISPLAY: "wayland-0", SSH_CLIENT: "10.0.0.2 51000 22" }],
    ["SSH_TTY", { DISPLAY: ":0", SSH_TTY: "/dev/pts/3" }],
    ["no display", {}],
  ];
  for (const [name, env] of cases) {
    const { m, cli } = await desktop(t, env);
    const run = await cli();
    assert.equal(run.exitCode, 0, `${name}: ${run.stderr}`);
    assert.equal(m.host.grants.length, 1, name);
    assert.deepEqual(m.host.launches, [], name);
    assert.doesNotMatch(run.stdout, /Could not open a browser/, name);
  }
  const emitted = await desktop(t, { DISPLAY: ":0" });
  await emitted.cli(["--emit-link"]);
  assert.equal(emitted.m.host.grants.length, 1);
  assert.deepEqual(emitted.m.host.launches, [], "--emit-link");
  const piped = await desktop(t, { DISPLAY: ":0" });
  await piped.cli([], { stdoutIsTTY: false });
  assert.deepEqual(piped.m.host.launches, [], "no terminal");
});

test("when xdg-open is missing or fails, setup says so in one line and keeps waiting for the printed link", async (t) => {
  for (const failure of [{ code: 127, stdout: "", stderr: "spawn xdg-open ENOENT" }, { code: 3, stdout: "", stderr: "" }]) {
    const { m, cli } = await desktop(t, { DISPLAY: ":0" });
    m.host.launchResult = failure;
    const run = await cli();
    assert.equal(run.exitCode, 0, run.stderr);
    assert.equal(run.stdout.split("\n").filter((line) => line === LAUNCH_FAILED).length, 1);
    assert.ok(run.stdout.indexOf(LAUNCH_FAILED) > run.stdout.indexOf(`  ${LINK_PREFIX}`), "after the link and QR");
    assert.equal(pollsOf(m.host).length, 4, "the wait went on to the approval");
    assert.match(run.stdout, /^state: complete$/m);
    assert.equal(existsSync(m.host.launches[0].target), false);
  }
});

// A snap-confined browser cannot read the 0600 page in the private runtime
// directory. Setup does not move the page somewhere it can: it prints the link
// with one line saying why nothing opened, and waits as usual.
test("a snap-confined browser is never launched: one line says so and the link stays on the terminal", async (t) => {
  const cases = [
    ["SNAP", { DISPLAY: ":0", SNAP: "/snap/moshpit/1" }, null],
    ["SNAP_NAME", { DISPLAY: ":0", SNAP_NAME: "moshpit" }, null],
    ["BROWSER", { DISPLAY: ":0", BROWSER: "/snap/bin/firefox" }, null],
    ["default browser entry", { DISPLAY: ":0" }, "firefox_firefox.desktop"],
    ["Wayland default", { WAYLAND_DISPLAY: "wayland-0" }, "chromium_chromium.desktop"],
  ];
  for (const [name, env, defaultBrowser] of cases) {
    const { m, cli } = await desktop(t, env);
    m.host.defaultBrowser = defaultBrowser;
    const run = await cli();
    assert.equal(run.exitCode, 0, `${name}: ${run.stderr}`);
    assert.deepEqual(m.host.launches, [], name);
    assert.equal(run.stdout.split("\n").filter((line) => line === SNAP_BROWSER).length, 1, name);
    assert.ok(run.stdout.includes(`  ${LINK_PREFIX}${m.host.grants[0]}\n`), `${name}: the link is printed`);
    assert.equal(pollsOf(m.host).length, 4, `${name}: the wait went on to the approval`);
    assert.equal(readdirSync(`${m.dir}/run`).length, 0, `${name}: no page was written`);
    assert.doesNotMatch(run.stdout, /Could not open a browser/, name);
  }
});

test("a non-snap default browser and an unreadable default still launch, and a snap xdg-open does not", async (t) => {
  for (const defaultBrowser of ["firefox.desktop", "org.mozilla.firefox.desktop", null]) {
    const { m, cli } = await desktop(t, { DISPLAY: ":0" });
    m.host.defaultBrowser = defaultBrowser;
    const run = await cli();
    assert.equal(m.host.launches.length, 1, String(defaultBrowser));
    assert.equal(run.stdout.includes(SNAP_BROWSER), false);
  }
  for (const opener of ["/snap/bin/xdg-open", "/usr/bin/xdg-open"]) {
    const { m, cli } = await desktop(t, { DISPLAY: ":0" });
    const run = await cli([], { which: async (name) => (name === "xdg-open" ? opener : null) });
    assert.equal(m.host.launches.length, opener.startsWith("/snap/") ? 0 : 1, opener);
    assert.equal(run.stdout.includes(SNAP_BROWSER), opener.startsWith("/snap/"), opener);
  }
});

test("a link that expires unused leaves the host awaiting its first device and says how to get another", async (t) => {
  const m = await machine(t);
  const run = await runCli(m, [], { stdoutIsTTY: true });
  assert.equal(run.exitCode, 0);
  assert.equal(m.host.grants.length, 1);
  assert.equal(m.host.clock - Date.parse(NOW), 5 * 60 * 1000, "waited the grant's five minutes on the injected clock");
  assert.match(run.stdout, /^pending +setup-link +The setup link expired before a browser used it\.$/m);
  assert.match(run.stdout, /^state: installed, awaiting first device$/m);
  assert.match(run.stdout, /^next: Run moshpit setup again for a fresh link\.$/m);
});

// A browser that used the link and was refused: the operator's terminal says
// which reason, from a code the bridge recorded, never the secret or the account.
test("a link every browser was refused says why when the wait ends, without the secret or the account", async (t) => {
  const reasons = ["pairing_grant_wrong_owner", "pairing_grant_used", "pairing_grant_expired", "pairing_rate_limited"];
  for (const code of reasons) {
    const m = await machine(t);
    m.host.onSleep = (ms) => {
      if (ms === 2000 && pollsOf(m.host).length === 3) m.host.refusals.push({ at: m.host.clock, code });
    };
    const run = await runCli(m, [], { stdoutIsTTY: true });
    assert.equal(run.exitCode, 0, code);
    assert.match(run.stdout, new RegExp(`^pending +setup-link +The setup link expired before a browser used it\\. ${REFUSAL_NOTES[code].replace(/[.]/g, "\\.")}$`, "m"), code);
    const [secret] = m.host.grants;
    const [, reason] = /^pending +setup-link +(.*)$/m.exec(run.stdout);
    assert.equal(reason.includes(secret), false, "the reason never carries the secret");
    assert.equal(reason.includes(OWNER), false, "or the account");
    assert.equal(run.stdout.replaceAll(`${LINK_PREFIX}${secret}`, "").includes(secret), false, "the secret appears only in the link");
  }
});

test("refusals from before this link was issued are not reported, and each reason is reported once", async (t) => {
  const m = await machine(t);
  m.host.refusals.push({ at: m.host.clock - 1, code: "pairing_grant_used" });
  m.host.onSleep = (ms) => {
    if (ms === 2000 && pollsOf(m.host).length === 3) {
      m.host.refusals.push({ at: m.host.clock, code: "pairing_grant_wrong_owner" }, { at: m.host.clock, code: "pairing_grant_wrong_owner" });
    }
  };
  const run = await runCli(m, [], { stdoutIsTTY: true });
  assert.ok(run.stdout.includes(REFUSAL_NOTES.pairing_grant_wrong_owner));
  assert.equal(run.stdout.split(REFUSAL_NOTES.pairing_grant_wrong_owner).length, 2);
  assert.equal(run.stdout.includes(REFUSAL_NOTES.pairing_grant_used), false);
});

test("a bridge that stops answering during the wait is reported as unreachable", async (t) => {
  const m = await machine(t);
  m.host.onSleep = (ms) => {
    if (ms === 2000 && pollsOf(m.host).length === 3) m.host.adminDown = true;
  };
  const run = await runCli(m, [], { stdoutIsTTY: true });
  assert.match(run.stdout, /^pending +setup-link +The setup link expired before a browser used it\. .*The bridge stopped answering/m);
  assert.ok(run.stdout.includes(UNREACHABLE_NOTE));
  assert.equal(m.host.adminCalls.filter((call) => call.action === "refusals").length > 0, true, "it asked before the bridge went away");
});

test("a bridge that comes back before the wait ends is not reported as unreachable", async (t) => {
  const m = await machine(t);
  m.host.onSleep = (ms) => {
    if (ms !== 2000) return;
    const polls = pollsOf(m.host).length;
    m.host.adminDown = polls === 4;
  };
  const run = await runCli(m, [], { stdoutIsTTY: true });
  assert.equal(run.stdout.includes(UNREACHABLE_NOTE), false);
});

test("Ctrl-C stops waiting, leaves setup resumable and exits 130", async (t) => {
  const m = await machine(t);
  let interrupt;
  m.host.onSleep = (ms) => {
    if (ms === 2000 && pollsOf(m.host).length === 3) interrupt();
  };
  const onInterrupt = (handler) => {
    interrupt = handler;
    return () => {
      interrupt = () => assert.fail("the handler outlived the wait");
    };
  };
  const run = await runCli(m, [], { stdoutIsTTY: true, onInterrupt });
  assert.equal(run.exitCode, 130);
  assert.equal(m.host.clock - Date.parse(NOW), 4000);
  assert.match(run.stdout, /^pending +setup-link +Stopped waiting/m);
  assert.match(run.stdout, /^state: installed, awaiting first device$/m);
  assert.match(run.stdout, /^next: Run moshpit setup again for a fresh link\.$/m);
  // The journal holds the finished steps, so a rerun resumes rather than reinstalls.
  m.host.mutations.length = 0;
  const again = await runCli(m, ["--emit-link"]);
  assert.equal(again.exitCode, 0);
  assert.deepEqual(m.host.mutations, []);
});

test("without a terminal and without --emit-link no grant is issued and nothing prints a link", async (t) => {
  const m = await machine(t);
  const human = await runCli(m, []);
  const json = await runCli(m, ["--json"]);
  assert.deepEqual(m.host.grants, []);
  assert.deepEqual(grantsOf(m.host), []);
  for (const run of [human, json]) {
    assert.equal(run.exitCode, 0);
    assert.doesNotMatch(run.stdout + run.stderr, /moshpit-setup=/);
  }
  const result = resultOf(json.stdout, "setup", 0);
  assert.equal("setupLink" in result, false);
  assert.equal(result.state, "installed, awaiting first device");
  assert.equal(statusOf(result, "setup-link"), "skipped");
  assert.match(result.next, /--emit-link/);
  assert.match(human.stdout, /^skipped +setup-link +Not printed: standard output is not a terminal/m);
});

test("--emit-link prints the link, in --json as setupLink, with no QR and no waiting", async (t) => {
  const m = await machine(t);
  const json = await runCli(m, ["--emit-link", "--json"]);
  assert.equal(json.exitCode, 0);
  assert.equal(m.host.grants.length, 1);
  const result = resultOf(json.stdout, "setup", 0);
  assert.equal(result.setupLink, `${LINK_PREFIX}${m.host.grants[0]}`);
  assert.equal(result.state, "installed, awaiting first device");
  assert.equal(statusOf(result, "setup-link"), "done");
  assert.equal(json.stdout.split("\n").length, 2, "one JSON line");
  assert.equal(json.stderr, "");

  const human = await runCli(m, ["--emit-link"], { stdoutIsTTY: true });
  assert.equal(m.host.grants.length, 2);
  assert.ok(human.stdout.includes(`link: ${LINK_PREFIX}${m.host.grants[1]}\n`));
  assert.doesNotMatch(human.stdout + human.stderr, /[▀▄█]|Waiting/);
  assert.equal(pollsOf(m.host).filter((call) => call.action === "devices").length, 4, "a state check and a baseline per run, no polling");
});

test("on a terminal --json carries the link and prints it with the QR on stderr", async (t) => {
  const m = await machine(t);
  m.host.onSleep = (ms) => {
    if (ms) approve(m.host, "Firefox on Linux");
  };
  const run = await runCli(m, ["--json"], { stdoutIsTTY: true });
  assert.equal(run.exitCode, 0);
  const result = resultOf(run.stdout, "setup", 0);
  assert.equal(result.state, "complete");
  assert.equal(result.setupLink, `${LINK_PREFIX}${m.host.grants[0]}`);
  assert.ok(run.stderr.includes(result.setupLink));
  assert.match(run.stderr, /[▀▄█]{10}/);
});

test("a rerun while awaiting the first device issues a fresh grant", async (t) => {
  const m = await machine(t);
  const first = resultOf((await runCli(m, ["--emit-link", "--json"])).stdout, "setup", 0);
  const second = resultOf((await runCli(m, ["--emit-link", "--json"])).stdout, "setup", 0);
  assert.equal(m.host.grants.length, 2);
  assert.notEqual(first.setupLink, second.setupLink);
  assert.equal(second.setupLink, `${LINK_PREFIX}${m.host.grants[1]}`);
});

test("a host with a device gets a link only with --recover, which still runs preflight and reconcile", async (t) => {
  const m = await machine(t);
  await m.setup();
  approve(m.host, "Dana's phone");
  for (const [argv, tty] of [[["--emit-link"], false], [[], true]]) {
    const run = await runCli(m, argv, { stdoutIsTTY: tty });
    assert.equal(run.exitCode, 0);
    assert.match(run.stdout, /^state: complete$/m);
    assert.doesNotMatch(run.stdout, /setup-link|moshpit-setup=/);
  }
  assert.deepEqual(m.host.grants, []);

  m.host.calls.length = 0;
  const recovered = resultOf((await runCli(m, ["--recover", "--emit-link", "--json"])).stdout, "setup", 0);
  assert.equal(m.host.grants.length, 1);
  assert.equal(recovered.setupLink, `${LINK_PREFIX}${m.host.grants[0]}`);
  assert.equal(recovered.state, "complete");
  assert.ok(m.host.calls.includes("tailscale status --json"), "preflight ran");
  assert.ok(m.host.calls.includes("tailscale serve status --json"), "the steps were reconciled");

  // Waiting on --recover ends at a device that was not there before, not at the one that was.
  m.host.onSleep = (ms) => {
    if (ms && pollsOf(m.host).length === 8) approve(m.host, "Recovered phone");
  };
  const waited = await runCli(m, ["--recover"], { stdoutIsTTY: true });
  assert.equal(waited.exitCode, 0);
  assert.match(waited.stdout, /^done +setup-link +"Recovered phone" is approved$/m);
});

test("a grant the bridge refuses fails the link step without printing anything", async (t) => {
  const m = await machine(t);
  await m.setup();
  m.host.adminDown = true;
  const run = await runCli(m, ["--emit-link", "--json"]);
  assert.equal(run.exitCode, 1);
  const envelope = parseEnvelope(run.stdout, "setup", { exitCode: 1 });
  const result = envelope.result;
  assert.equal(envelope.error.code, "setup-link");
  assert.equal(statusOf(result, "setup-link"), "failed");
  assert.equal("setupLink" in result, false);
  assert.match(result.next, /fresh link/);
});

test("no file under the machine, the journal included, ever holds a setup secret", async (t) => {
  const m = await machine(t);
  m.host.onSleep = (ms) => {
    if (ms) approve(m.host, "Chrome on Android");
  };
  await runCli(m, ["--emit-link"]);
  await runCli(m, [], { stdoutIsTTY: true });
  await runCli(m, ["--recover", "--emit-link", "--json"]);
  assert.equal(m.host.grants.length, 3);
  const files = JSON.stringify(await snapshot(m));
  assert.match(files, /setup\.json/, "the journal was read");
  for (const secret of m.host.grants) assert.equal(files.includes(secret), false);
});
