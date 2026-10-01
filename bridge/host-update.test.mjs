import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { downloadRelease } from "./release-source.mjs";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { hostPaths, processAlive } from "./host-probe.mjs";
import { main as maintainMain } from "./host-maintain.mjs";
import { versionText } from "./host-releases.mjs";
import { readStatus, runSetup } from "./host-setup.mjs";
import { runUninstall } from "./host-uninstall.mjs";
import { envelope } from "./json-output.mjs";
import { parseEnvelope } from "./test-support.mjs";
import { EXIT, runRollback, runUpdate, WALKS } from "./host-update.mjs";

// A scripted host like host-setup.test.mjs's, extended with restart, the
// service's main process, Serve removal and linger removal. Releases come
// from a local HTTP server that stands in for GitHub Releases. A fake
// executable is a byte string; `<file> version --json` answers from a table
// keyed by the file's SHA-256, as the real executable reports its own release.json.

const DNS = "box.tail1.ts.net";
const OWNER = "dana@example.com";
const USER = "dana";
const NOW = Date.parse("2026-09-27T00:00:00.000Z");
const STATE_VERSIONS = { devices: { write: 3, read: [2, 3] } };

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });

/** A fake release: its bytes, its release.json and its manifest. */
function build(version, serial, { info: extra = {} } = {}) {
  const binary = Buffer.concat([Buffer.from(`fake moshpit ${version}\n`), randomBytes(32)]);
  const info = {
    name: "moshpit",
    version,
    releaseSerial: serial,
    arch: "x64",
    node: "v26.10.0",
    configSchemaVersion: 1,
    stateVersions: STATE_VERSIONS,
    ...extra,
  };
  const manifest = { ...info, name: "moshpit-linux-x64", sha256: sha256(binary), bytes: binary.length };
  return { version, binary, info, manifest };
}

/** A GitHub Releases stand-in: `/releases/latest`, `/releases/tags/<tag>` and the assets. */
async function releaseServer(t) {
  const releases = new Map();
  const hits = [];
  const authorizations = [];
  let latest = null;
  // `chunked` sends bodies without a Content-Length; `assetBase` points asset URLs elsewhere.
  const settings = { chunked: false, assetBase: null };
  const server = createServer((request, response) => {
    hits.push(request.url);
    if (request.headers.authorization) authorizations.push(request.url);
    const { pathname } = new URL(request.url, "http://x");
    const send = (status, body, type = "application/octet-stream") => {
      response.writeHead(status, { "Content-Type": type });
      if (settings.chunked) response.write(body);
      response.end(settings.chunked ? undefined : body);
    };
    const describe = (tag) => {
      const files = releases.get(tag);
      if (!files) return send(404, "{}");
      const assets = Object.keys(files).map((name) => ({ name, url: `${settings.assetBase ?? base}/assets/${tag}/${name}` }));
      send(200, JSON.stringify({ tag_name: tag, assets }), "application/json");
    };
    if (pathname === "/repo/releases/latest") return latest ? describe(latest) : send(404, "{}");
    if (pathname.startsWith("/repo/releases/tags/")) return describe(decodeURIComponent(pathname.slice("/repo/releases/tags/".length)));
    const [, , tag, name] = pathname.split("/");
    const body = releases.get(tag)?.[name];
    return body ? send(200, body) : send(404, "");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    api: `${base}/repo`,
    hits,
    authorizations,
    settings,
    /** Publishes the executable and its manifest, and may damage either after the build. */
    publish(release, { tamper, isLatest = true } = {}) {
      const files = {
        "moshpit-linux-x64": Buffer.from(release.binary),
        "moshpit-linux-x64.json": Buffer.from(`${JSON.stringify(release.manifest, null, 2)}\n`),
      };
      tamper?.(files);
      releases.set(release.version, files);
      if (isLatest) latest = release.version;
    },
  };
}

function makeHost() {
  return {
    serve: new Map(),
    loadedUnit: null,
    loadedStamp: null,
    enabled: false,
    active: false,
    mainPid: 0,
    mainExe: null,
    nextPid: 1000,
    linger: false,
    builds: new Map(),
    broken: new Set(),
    calls: [],
    mutations: [],
    devices: [],
    foreignFragment: null,
  };
}

function fakeRunner(host, paths, herdr) {
  const unitOnDisk = () => (existsSync(paths.unit) ? readFileSync(paths.unit, "utf8") : null);
  const unitStamp = () => (existsSync(paths.unit) ? statSync(paths.unit, { bigint: true }).mtimeNs : null);
  const start = () => {
    const exe = realpathSync(paths.currentExecutable);
    const version = host.builds.get(sha256(readFileSync(exe)))?.version;
    host.mainExe = exe;
    host.active = !host.broken.has(version);
    host.mainPid = host.active ? host.nextPid++ : 0;
  };
  const stop = () => {
    host.active = false;
    host.mainPid = 0;
  };
  const table = {
    "tailscale status --json": {
      read: () => ok(JSON.stringify({ BackendState: "Running", Self: { DNSName: `${DNS}.`, UserID: 2 }, User: { 2: { LoginName: OWNER } } })),
    },
    "tailscale serve status --json": {
      read: () => {
        const TCP = {};
        const Web = {};
        for (const [port, target] of host.serve) {
          TCP[port] = { HTTPS: true };
          Web[`${DNS}:${port}`] = { Handlers: { "/": { Proxy: target } } };
        }
        return ok(JSON.stringify({ TCP, Web }));
      },
    },
    "tailscale debug prefs": { read: () => ok(JSON.stringify({ OperatorUser: USER })) },
    "systemctl --user is-system-running": { read: () => ok("running\n") },
    "systemctl --user show moshpit-bridge.service --property=LoadState,NeedDaemonReload,UnitFileState,ActiveState": {
      read: () => ok("LoadState=not-found\nNeedDaemonReload=no\nUnitFileState=\nActiveState=inactive\n"),
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
    "systemctl --user show moshpit.service --property=FragmentPath --value": {
      read: () => ok(`${host.foreignFragment ?? (host.loadedUnit === null ? "" : paths.unit)}\n`),
    },
    "systemctl --user show moshpit.service --property=ActiveState,MainPID": {
      read: () => ok(`ActiveState=${host.active ? "active" : "failed"}\nMainPID=${host.mainPid}\n`),
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
        host.enabled = true;
        start();
        return ok();
      },
    },
    "systemctl --user restart moshpit.service": {
      mutate: () => {
        if (host.loadedUnit === null) return { code: 5, stdout: "", stderr: "Unit moshpit.service not found." };
        start();
        return ok();
      },
    },
    "systemctl --user disable --now moshpit.service": {
      mutate: () => {
        host.enabled = false;
        stop();
        return ok();
      },
    },
    [`loginctl show-user ${USER} --property=Linger --value`]: { read: () => ok(host.linger ? "yes\n" : "no\n") },
    [`loginctl enable-linger ${USER}`]: {
      mutate: () => {
        host.linger = true;
        return ok();
      },
    },
    [`loginctl disable-linger ${USER}`]: {
      mutate: () => {
        host.linger = false;
        return ok();
      },
    },
    [`${herdr} --version`]: { read: () => ok("herdr 0.8.2\n") },
  };
  return {
    async run(file, args) {
      const key = [file, ...args].join(" ");
      host.calls.push(key);
      if (key.startsWith("tailscale serve --bg --https ")) {
        host.mutations.push(key);
        host.serve.set(Number(args[3]), args[4]);
        return ok();
      }
      const off = /^tailscale serve --https (\d+) off$/.exec(key);
      if (off) {
        host.mutations.push(key);
        host.serve.delete(Number(off[1]));
        return ok();
      }
      if (args.join(" ") === "version --json") {
        const release = existsSync(file) ? host.builds.get(sha256(readFileSync(file))) : undefined;
        if (!release) return { code: 1, stdout: "", stderr: "not a moshpit executable" };
        return ok(JSON.stringify(envelope("version", { exitCode: 0, result: release.info })));
      }
      const row = table[key];
      if (!row) throw new Error(`unscripted command: ${key}`);
      if (row.read) return row.read();
      host.mutations.push(key);
      return row.mutate();
    },
  };
}

/**
 * A host installed by the real setup at `first`, with an approved device and
 * a devices.json of version 3.
 */
async function installed(t, { first, server, env: extraEnv = {} }) {
  const dir = await mkdtemp("/tmp/mpu.");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { HOME: dir, XDG_CONFIG_HOME: `${dir}/c`, XDG_STATE_HOME: `${dir}/s`, XDG_DATA_HOME: `${dir}/d`, PATH: `${dir}/bin`, ...extraEnv };
  if (server) env.MOSHPIT_RELEASE_API = server.api;
  await mkdir(`${dir}/bin`);
  const herdr = `${dir}/bin/herdr`;
  await writeFile(herdr, "#!/bin/sh\n", { mode: 0o755 });
  const paths = hostPaths(env);
  const host = makeHost();
  const runner = fakeRunner(host, paths, herdr);
  const register = (release) => host.builds.set(sha256(release.binary), release);
  register(first);
  const download = `${dir}/moshpit-download`;
  await writeFile(download, first.binary, { mode: 0o700 });
  let running = { info: first.info };
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
      stdoutIsTTY: false,
      prompt: async (question) => assert.fail(`unexpected prompt: ${question}`),
      release: { version: first.version, executable: download },
      running,
      options,
      fetch: async (url, init) => {
        if (!String(url).startsWith(`https://${DNS}`)) return globalThis.fetch(url, init);
        if (!host.active || host.serve.get(443) !== "http://127.0.0.1:8801") throw new TypeError("fetch failed");
        return { status: 200, json: async () => ({ protocol: 2 }) };
      },
      portFree: async () => true,
      isAlive: processAlive,
      now: () => NOW,
      admin: async () => ({ result: host.devices }),
      readProcExe: async (pid) => {
        if (pid !== host.mainPid) throw new Error("no such process");
        return host.mainExe;
      },
      sleep: async () => {},
      verifyAttempts: 1,
      verifyDelayMs: 0,
      ...overrides,
    };
    return ctx;
  };
  const setup = await runSetup(context({ yes: true, allowLinger: true }));
  assert.equal(setup.exitCode, 0, JSON.stringify(setup.result));
  await writeFile(path.join(paths.state, "devices.json"), JSON.stringify({ version: 3, devices: [], grants: [] }), { mode: 0o600 });
  host.mutations.length = 0;
  return {
    dir,
    env,
    paths,
    host,
    register,
    context,
    /** What the running executable is: after an update, the release current points at. */
    runAs(release) {
      running = { info: release.info };
    },
    update: (options = {}, overrides = {}) => runUpdate(context(options, overrides)),
    rollback: (overrides = {}) => runRollback(context({}, overrides)),
    uninstall: (options = {}, overrides = {}) => runUninstall(context(options, overrides)),
  };
}

/** Every file and link under the machine, a release executable by its version, plus the modelled host. */
async function snapshot(m) {
  const entries = {};
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const file = path.join(dir, entry.name);
      const key = path.relative(m.dir, file);
      const mode = ((await lstat(file)).mode & 0o777).toString(8);
      if (entry.isDirectory()) {
        entries[key] = `dir ${mode}`;
        await walk(file);
      } else if (entry.isSymbolicLink()) entries[key] = `-> ${await readlink(file)}`;
      else {
        const bytes = await readFile(file);
        const release = m.host.builds.get(sha256(bytes));
        entries[key] = `${mode} ${release ? `release ${release.version}` : bytes.toString("utf8").replaceAll(m.dir, "<dir>")}`;
      }
    }
  }
  await walk(m.dir);
  const { serve, enabled, active, linger, mainExe } = m.host;
  return { entries, serve: [...serve], enabled, active, linger, mainExe: mainExe && path.relative(m.dir, mainExe) };
}

const ids = (result) => result.steps.map((entry) => [entry.id, entry.status]);
const releasesOf = async (m) => (await readdir(m.paths.releases)).sort();
const currentOf = async (m) => readlink(m.paths.current);
const journalOf = async (m) => JSON.parse(await readFile(m.paths.updateJournal, "utf8"));
/** Config, device state and setup's journal: what update and rollback never touch. */
const untouched = async (m) =>
  Promise.all([m.paths.config, path.join(m.paths.state, "devices.json"), m.paths.journal].map((file) => readFile(file, "utf8")));

async function world(t, { env } = {}) {
  const server = await releaseServer(t);
  const v1 = build("v1.0.0", 10);
  const m = await installed(t, { first: v1, server, env });
  return { server, v1, m };
}

test("an update verifies, installs, switches, restarts into and checks the new release", async (t) => {
  const { server, v1, m } = await world(t);
  const v2 = build("v1.1.0", 12);
  m.register(v2);
  server.publish(v2);
  const kept = await untouched(m);
  const { result, exitCode } = await m.update();
  assert.equal(exitCode, 0, JSON.stringify(result));
  assert.equal(result.state, "updated");
  assert.deepEqual(ids(result), [
    ["release", "done"],
    ["fetched", "done"],
    ["staged", "done"],
    ["switched", "done"],
    ["restarted", "done"],
    ["verified", "done"],
  ]);
  assert.equal(result.steps[0].detail, `v1.1.0: v1.1.0 (serial 12), SHA-256 ${sha256(v2.binary)} matches its manifest`);
  assert.equal(await currentOf(m), "releases/v1.1.0");
  assert.deepEqual(await releasesOf(m), ["v1.0.0", "v1.1.0"]);
  assert.equal((await lstat(m.paths.release("v1.1.0"))).mode & 0o777, 0o755);
  assert.deepEqual(await readFile(m.paths.release("v1.1.0")), v2.binary);
  assert.equal(m.host.mainExe, realpathSync(m.paths.release("v1.1.0")));
  assert.deepEqual(m.host.mutations, ["systemctl --user restart moshpit.service"]);
  assert.equal(existsSync(m.paths.staging), false, "the staging copy is removed");
  assert.equal(existsSync(m.paths.lock), false, "the lock is released");
  const journal = await journalOf(m);
  assert.deepEqual(journal.previous, { version: v1.version });
  assert.equal(journal.attempt, null);
  assert.deepEqual(await untouched(m), kept, "config, device state and setup's journal are untouched");
  assert.ok(m.host.calls.includes(`${m.paths.release("v1.1.0")} version --json`), "the staged release was asked its version");
});

// systemctl restart returns once systemd has forked the new main process,
// before that process execs the release. Checking /proc/<pid>/exe at that
// instant failed every update on a real host and reverted a working release.
test("a restart is checked after the new process has execed the release, not at the fork", async (t) => {
  const { server, m } = await world(t);
  const v2 = build("v1.1.0", 12);
  m.register(v2);
  server.publish(v2);
  const forked = new Set();
  const { result, exitCode } = await m.update({}, {
    verifyAttempts: 3,
    readProcExe: async (pid) => {
      if (pid !== m.host.mainPid) throw new Error("no such process");
      if (!forked.has(pid)) {
        forked.add(pid);
        return "/usr/lib/systemd/systemd-executor";
      }
      return m.host.mainExe;
    },
  });
  assert.equal(exitCode, 0, JSON.stringify(result));
  assert.equal(result.state, "updated");
  assert.equal(await currentOf(m), "releases/v1.1.0");
  assert.deepEqual(m.host.mutations, ["systemctl --user restart moshpit.service"]);
});

test("a release that is already running is up to date and changes nothing", async (t) => {
  const { server, v1, m } = await world(t);
  server.publish(v1);
  const before = await snapshot(m);
  const { result, exitCode } = await m.update();
  assert.equal(exitCode, 0);
  assert.equal(result.state, "up to date");
  assert.deepEqual(await snapshot(m), before);
});

const TAMPERING = {
  "a changed executable byte": { tamper: (files) => (files["moshpit-linux-x64"][40] ^= 1) },
  "a truncated executable": { tamper: (files) => (files["moshpit-linux-x64"] = files["moshpit-linux-x64"].subarray(0, -1)) },
  "an extended executable": { tamper: (files) => (files["moshpit-linux-x64"] = Buffer.concat([files["moshpit-linux-x64"], Buffer.from("x")])) },
  "a manifest naming another SHA-256": {
    tamper: (files) => (files["moshpit-linux-x64.json"] = Buffer.from(files["moshpit-linux-x64.json"].toString().replace(/"sha256": "[0-9a-f]{64}"/, `"sha256": "${"0".repeat(64)}"`))),
  },
  "a missing manifest": { tamper: (files) => delete files["moshpit-linux-x64.json"], exitCode: EXIT.source },
};

/** Whether anything under releases/<version> or the staging directory was run or written. */
const touchedNew = async (m, version) =>
  m.host.calls.some((call) => call.startsWith(m.paths.release(version)) || call.startsWith(m.paths.staging)) ||
  existsSync(m.paths.staging) ||
  existsSync(path.dirname(m.paths.release(version)));

test("an executable that does not match its manifest is refused before it is written or run", async (t) => {
  for (const [name, { exitCode = EXIT.verification, ...damage }] of Object.entries(TAMPERING)) {
    const { server, m } = await world(t);
    const v2 = build("v1.1.0", 12);
    m.register(v2);
    server.publish(v2, damage);
    const before = await snapshot(m);
    const { result, exitCode: code } = await m.update();
    assert.equal(code, exitCode, `${name}: ${JSON.stringify(result)}`);
    assert.equal(result.state, "refused", name);
    assert.match(result.steps.at(-1).detail, /Nothing was changed\.$/, name);
    assert.deepEqual(await snapshot(m), before, `${name}: nothing changed`);
    assert.deepEqual(m.host.mutations, [], name);
    assert.equal(await touchedNew(m, "v1.1.0"), false, `${name}: nothing downloaded was written or run`);
  }
});

// The documented limit of dropping signatures: whoever can publish to the
// repository can publish a matching manifest, and update installs it.
test("KNOWN LIMIT: a replaced executable with a manifest rewritten to match it is installed", async (t) => {
  const { server, m } = await world(t);
  const genuine = build("v1.1.0", 12);
  const replaced = { ...build("v1.1.0", 12), version: genuine.version };
  m.register(replaced);
  server.publish(genuine, {
    tamper: (files) => {
      files["moshpit-linux-x64"] = Buffer.from(replaced.binary);
      files["moshpit-linux-x64.json"] = Buffer.from(JSON.stringify(replaced.manifest));
    },
  });
  const { result, exitCode } = await m.update();
  assert.equal(exitCode, 0, JSON.stringify(result));
  assert.deepEqual(await readFile(m.paths.release("v1.1.0")), replaced.binary, "the replaced executable is what runs");
});

test("a stale older copy never moves current below the installed release", async (t) => {
  const { server, v1, m } = await world(t);
  const v3 = build("v1.2.0", 12);
  m.register(v3);
  server.publish(v3);
  const updated = await m.update();
  assert.equal(updated.exitCode, 0, JSON.stringify(updated.result));
  const middle = build("v1.1.0", 11);
  m.register(middle);
  server.publish(middle);
  m.runAs(v1);
  const before = await snapshot(m);
  const { result, exitCode } = await m.update({ version: "v1.1.0" });
  assert.equal(exitCode, EXIT.downgrade, JSON.stringify(result));
  assert.match(result.steps.at(-1).detail, /not newer than the installed release, v1\.2\.0 \(serial 12\)/);
  assert.deepEqual(await snapshot(m), before);
});

test("a release that is not newer is refused, also when named with --version", async (t) => {
  const { server, m } = await world(t);
  const older = build("v0.9.0", 9);
  server.publish(older);
  const before = await snapshot(m);
  const latest = await m.update();
  assert.equal(latest.exitCode, EXIT.downgrade, JSON.stringify(latest.result));
  assert.match(latest.result.steps.at(-1).detail, /not newer than this release, v1\.0\.0 \(serial 10\)/);
  const named = await m.update({ version: "v0.9.0" });
  assert.equal(named.exitCode, EXIT.downgrade);
  const sameSerial = build("v1.0.0-rebuilt", 10);
  server.publish(sameSerial);
  assert.equal((await m.update()).exitCode, EXIT.downgrade);
  assert.deepEqual(await snapshot(m), before);
});

test("--version installs a named newer release rather than the latest", async (t) => {
  const { server, m } = await world(t);
  const v2 = build("v1.1.0", 12);
  const v3 = build("v1.2.0", 14);
  m.register(v2);
  m.register(v3);
  server.publish(v2, { isLatest: false });
  server.publish(v3);
  const { exitCode } = await m.update({ version: "v1.1.0" });
  assert.equal(exitCode, 0);
  assert.equal(await currentOf(m), "releases/v1.1.0");
  assert.ok(server.hits.includes("/repo/releases/tags/v1.1.0"));
  assert.ok(!server.hits.includes("/repo/releases/latest"));
});

test("a release for another config schema or device state version is refused", async (t) => {
  const cases = {
    "config schema": { configSchemaVersion: 2 },
    "device state": { stateVersions: { devices: { write: 4, read: [4] } } },
    "no state versions": { stateVersions: undefined },
  };
  for (const [name, info] of Object.entries(cases)) {
    const { server, m } = await world(t);
    const v2 = build("v1.1.0", 12, { info });
    server.publish(v2);
    const before = await snapshot(m);
    const { result, exitCode } = await m.update();
    assert.equal(exitCode, EXIT.incompatible, `${name}: ${JSON.stringify(result)}`);
    assert.deepEqual(await snapshot(m), before, name);
  }
});

test("a release that fails its health check is rolled back to the same current target", async (t) => {
  const { server, v1, m } = await world(t);
  const v2 = build("v1.1.0", 12);
  m.register(v2);
  m.host.broken.add("v1.1.0");
  server.publish(v2);
  const target = await currentOf(m);
  const kept = await untouched(m);
  const { result, exitCode } = await m.update();
  assert.equal(exitCode, EXIT.reverted, JSON.stringify(result));
  assert.equal(result.state, "reverted");
  assert.deepEqual(ids(result).slice(3), [
    ["switched", "done"],
    ["restarted", "failed"],
    ["switched-back", "done"],
    ["restarted-back", "done"],
    ["verified-back", "done"],
  ]);
  assert.equal(await currentOf(m), target);
  assert.equal(m.host.mainExe, realpathSync(m.paths.release(v1.version)));
  assert.equal(m.host.active, true);
  assert.deepEqual(m.host.mutations, ["systemctl --user restart moshpit.service", "systemctl --user restart moshpit.service"]);
  assert.deepEqual(await releasesOf(m), ["v1.0.0"], "the release that failed is not kept");
  const journal = await journalOf(m);
  assert.equal(journal.attempt, null);
  assert.equal(journal.last.outcome, "reverted");
  assert.deepEqual(await untouched(m), kept);
});

test("a release that starts but does not answer HTTPS is rolled back, keeping the previous release", async (t) => {
  const { server, m } = await world(t);
  const v2 = build("v1.1.0", 12);
  const v3 = build("v1.2.0", 14);
  m.register(v2);
  m.register(v3);
  server.publish(v2);
  assert.equal((await m.update()).exitCode, 0);
  m.runAs(v2);
  server.publish(v3);
  const serveBack = new Map(m.host.serve);
  const { result, exitCode } = await m.update({}, {
    fetch: async (url, init) => {
      if (!String(url).startsWith(`https://${DNS}`)) return globalThis.fetch(url, init);
      const answering = m.host.active && m.host.mainExe !== realpathSync(m.paths.release("v1.2.0"));
      if (!answering) throw new TypeError("fetch failed");
      return { status: 200, json: async () => ({ protocol: 2 }) };
    },
  });
  assert.equal(exitCode, EXIT.reverted, JSON.stringify(result));
  assert.equal(result.steps.find((entry) => entry.id === "verified").status, "failed");
  assert.equal(await currentOf(m), "releases/v1.1.0");
  assert.deepEqual(await releasesOf(m), ["v1.0.0", "v1.1.0"], "the previous release is still kept for rollback");
  assert.deepEqual((await journalOf(m)).previous, { version: "v1.0.0" });
  assert.deepEqual(m.host.serve, serveBack);
});

async function reference(t) {
  const { server, m } = await world(t);
  const v2 = build("v1.1.0", 12);
  m.register(v2);
  server.publish(v2);
  assert.equal((await m.update()).exitCode, 0);
  const journal = await journalOf(m);
  return { snapshot: await snapshot(m), mutations: [...m.host.mutations], last: journal.last, previous: journal.previous };
}

/** The update walk with `id`'s apply followed by a crash: an exception that is not a step failure. */
function crashingAfter(id) {
  const index = WALKS.update.findIndex((step) => step.id === id);
  const original = WALKS.update[index];
  WALKS.update[index] = {
    ...original,
    async apply(ctx, version) {
      await original.apply(ctx, version);
      throw new Error(`crash after ${id}`);
    },
  };
  return () => (WALKS.update[index] = original);
}

test("a crash after each update step, then a rerun, converges without repeating a restart", async (t) => {
  const expected = await reference(t);
  for (const step of WALKS.update.filter((entry) => !entry.check)) {
    const { server, m } = await world(t);
    const v2 = build("v1.1.0", 12);
    m.register(v2);
    server.publish(v2);
    const restore = crashingAfter(step.id);
    await assert.rejects(m.update(), new RegExp(`crash after ${step.id}`));
    restore();
    // After the switch, the rerun is the new release's executable.
    if (step.id === "switched" || step.id === "restarted") m.runAs(v2);
    const resumed = await m.update();
    assert.equal(resumed.exitCode, 0, `${step.id}: ${JSON.stringify(resumed.result)}`);
    assert.equal(resumed.result.steps[0].id, "resume", step.id);
    assert.deepEqual(m.host.mutations, expected.mutations, `${step.id}: one restart`);
    const journal = await journalOf(m);
    assert.deepEqual(journal.previous, expected.previous, step.id);
    assert.equal(journal.attempt, null, step.id);
    assert.deepEqual(await snapshot(m), expected.snapshot, `${step.id}: same end state`);
  }
});

test("a crash while switching back, then a rerun, finishes the rollback to the old release", async (t) => {
  const { server, v1, m } = await world(t);
  const v2 = build("v1.1.0", 12);
  m.register(v2);
  m.host.broken.add("v1.1.0");
  server.publish(v2);
  const index = WALKS.revert.findIndex((step) => step.id === "switched");
  const original = WALKS.revert[index];
  WALKS.revert[index] = { ...original, apply: async (ctx, version) => {
    await original.apply(ctx, version);
    throw new Error("crash while switching back");
  } };
  try {
    await assert.rejects(m.update(), /crash while switching back/);
  } finally {
    WALKS.revert[index] = original;
  }
  m.runAs(v1);
  const resumed = await m.update();
  assert.equal(resumed.exitCode, EXIT.reverted, JSON.stringify(resumed.result));
  assert.equal(await currentOf(m), `releases/${v1.version}`);
  assert.equal(m.host.mainExe, realpathSync(m.paths.release(v1.version)));
});

test("rollback returns to the previous release and keeps the one it left", async (t) => {
  const { server, v1, m } = await world(t);
  const v2 = build("v1.1.0", 12);
  m.register(v2);
  server.publish(v2);
  assert.equal((await m.update()).exitCode, 0);
  m.runAs(v2);
  const kept = await untouched(m);
  m.host.mutations.length = 0;
  const { result, exitCode } = await m.rollback();
  assert.equal(exitCode, 0, JSON.stringify(result));
  assert.equal(result.state, "rolled back");
  assert.deepEqual(ids(result), [
    ["previous", "done"],
    ["switched", "done"],
    ["restarted", "done"],
    ["verified", "done"],
  ]);
  assert.equal(await currentOf(m), `releases/${v1.version}`);
  assert.equal(m.host.mainExe, realpathSync(m.paths.release(v1.version)));
  assert.deepEqual(m.host.mutations, ["systemctl --user restart moshpit.service"]);
  assert.deepEqual(await releasesOf(m), ["v1.0.0", "v1.1.0"]);
  assert.deepEqual((await journalOf(m)).previous, { version: "v1.1.0" });
  assert.deepEqual(await untouched(m), kept, "rollback never restores device state");
});

test("rollback refuses a release that cannot read the device state, and a host with no previous release", async (t) => {
  const { server, m } = await world(t);
  const none = await m.rollback();
  assert.equal(none.exitCode, EXIT.noPrevious);

  const v2 = build("v1.1.0", 12);
  m.register(v2);
  server.publish(v2);
  assert.equal((await m.update()).exitCode, 0);
  // The kept v1.0.0 reads only version 2, and the bridge has since written version 3.
  const v1 = m.host.builds.get(sha256(await readFile(m.paths.release("v1.0.0"))));
  v1.info = { ...v1.info, stateVersions: { devices: { write: 2, read: [2] } } };
  const before = await snapshot(m);
  const { result, exitCode } = await m.rollback();
  assert.equal(exitCode, EXIT.incompatible, JSON.stringify(result));
  assert.match(result.steps.at(-1).detail, /reads device state versions 2, and this host's devices\.json is version 3.*never restores an older device database/);
  assert.deepEqual(await snapshot(m), before);
  assert.deepEqual(m.host.mutations, ["systemctl --user restart moshpit.service"], "only the update's restart");
});

test("only the current release and one previous release are kept", async (t) => {
  const { server, m } = await world(t);
  for (const [version, serial] of [["v1.1.0", 12], ["v1.2.0", 14], ["v1.3.0", 16]]) {
    const next = build(version, serial);
    m.register(next);
    server.publish(next);
    assert.equal((await m.update()).exitCode, 0, version);
    m.runAs(next);
  }
  assert.deepEqual(await releasesOf(m), ["v1.2.0", "v1.3.0"]);
});

test("status shows the current release, its serial and the previous release", async (t) => {
  const { server, m } = await world(t);
  const before = await readStatus(m.context());
  assert.equal(before.result.steps.find((entry) => entry.id === "release").detail, "v1.0.0 (serial 10); no previous release kept");
  const v2 = build("v1.1.0", 12);
  m.register(v2);
  server.publish(v2);
  await m.update();
  const after = await readStatus(m.context());
  assert.match(after.result.steps.find((entry) => entry.id === "release").detail, /^v1\.1\.0 \(serial 12\); previous v1\.0\.0 kept for moshpit rollback$/);
});

test("version prints one release line", () => {
  assert.equal(versionText(build("v1.0.0", 10).info), "moshpit v1.0.0 (node v26.10.0, x64, config schema 1)\n");
});

test("uninstall removes what setup made and keeps config, device state and the journal", async (t) => {
  const { server, m } = await world(t);
  const v2 = build("v1.1.0", 12);
  m.register(v2);
  server.publish(v2);
  await m.update();
  m.host.mutations.length = 0;
  const kept = await untouched(m);
  const { result, exitCode } = await m.uninstall();
  assert.equal(exitCode, 0, JSON.stringify(result));
  assert.equal(result.state, "uninstalled");
  assert.deepEqual(m.host.mutations, [
    "systemctl --user disable --now moshpit.service",
    "systemctl --user daemon-reload",
    "tailscale serve --https 443 off",
    `loginctl disable-linger ${USER}`,
  ]);
  assert.equal(existsSync(m.paths.unit), false);
  assert.equal(existsSync(m.paths.current), false);
  assert.equal(existsSync(m.paths.data), false);
  assert.equal(existsSync(m.paths.updateJournal), false);
  assert.deepEqual(await untouched(m), kept);
  assert.equal((await readStatus(m.context())).result.state, "not installed");
});

test("uninstall leaves a Serve route and lingering that setup did not create", async (t) => {
  const { m } = await world(t);
  m.host.serve.set(443, "http://127.0.0.1:9999");
  m.host.serve.set(8443, "http://127.0.0.1:7000");
  const { result } = await m.uninstall();
  assert.match(result.steps.find((entry) => entry.id === "serve").detail, /Serve port 443 now proxies to http:\/\/127\.0\.0\.1:9999, not this bridge; left alone/);
  assert.deepEqual([...m.host.serve], [[443, "http://127.0.0.1:9999"], [8443, "http://127.0.0.1:7000"]]);

  // Linger and the route were already in place when setup ran.
  const again = await world(t);
  const journal = JSON.parse(await readFile(again.m.paths.journal, "utf8"));
  journal.steps.persistence.previous = { linger: true };
  journal.steps["serve-configured"].previous = { port: 443, target: "http://127.0.0.1:8801" };
  await writeFile(again.m.paths.journal, JSON.stringify(journal));
  const kept = await again.m.uninstall();
  assert.equal(kept.exitCode, 0);
  assert.match(kept.result.steps.find((entry) => entry.id === "serve").detail, /setup did not create it; left alone/);
  assert.match(kept.result.steps.find((entry) => entry.id === "linger").detail, /not enabled by setup; left on/);
  assert.equal(again.m.host.linger, true);
  assert.deepEqual([...again.m.host.serve], [[443, "http://127.0.0.1:8801"]]);
});

test("setup records whether lingering was already on", async (t) => {
  const { m } = await world(t);
  assert.deepEqual(JSON.parse(await readFile(m.paths.journal, "utf8")).steps.persistence.previous, { linger: false });
});

test("uninstall is idempotent: a rerun changes nothing and exits 0", async (t) => {
  const { m } = await world(t);
  assert.equal((await m.uninstall()).exitCode, 0);
  const before = await snapshot(m);
  m.host.mutations.length = 0;
  const { result, exitCode } = await m.uninstall();
  assert.equal(exitCode, 0);
  assert.deepEqual(m.host.mutations, []);
  assert.deepEqual(await snapshot(m), before);
  for (const entry of result.steps) assert.equal(entry.status, "skipped", entry.id);
});

test("uninstall leaves a moshpit.service that setup did not write", async (t) => {
  const { m } = await world(t);
  await writeFile(m.paths.unit, "[Service]\nExecStart=/usr/bin/something\n");
  const { result } = await m.uninstall();
  assert.match(result.steps[0].detail, /is not the unit setup writes; left alone/);
  assert.ok(!m.host.mutations.some((call) => call.includes("disable") && call.includes("moshpit.service")));
  assert.equal(await readFile(m.paths.unit, "utf8"), "[Service]\nExecStart=/usr/bin/something\n");
});

test("uninstall leaves a moshpit.service loaded from another unit directory", async (t) => {
  const { m } = await world(t);
  await rm(m.paths.unit);
  m.host.foreignFragment = "/home/someone/.local/share/systemd/user/moshpit.service";
  const { result } = await m.uninstall();
  assert.match(result.steps[0].detail, /loads from \/home\/someone\/.local\/share\/systemd\/user\/moshpit.service, not the unit setup writes; left alone/);
  assert.ok(!m.host.mutations.some((call) => call.includes("disable") && call.includes("moshpit.service")));
});

const TOKEN = "github_pat_test_0123456789";

/** A scripted network: `routes[url]` answers a request, and every request's Authorization is recorded. */
function network(routes) {
  const seen = [];
  const fetch = async (url, init) => {
    assert.equal(init.redirect, "manual", "redirects are followed by hand");
    seen.push({ url, authorization: init.headers.Authorization ?? null });
    const route = routes[url];
    if (!route) return new Response("", { status: 404 });
    if (route.redirect) return new Response(null, { status: 302, headers: { location: route.redirect } });
    return new Response(route.body, { status: 200 });
  };
  return { fetch, seen, sentTo: (host) => seen.filter((entry) => new URL(entry.url).host === host).map((entry) => entry.authorization) };
}

function githubRelease({ binaryRedirect }) {
  const api = "https://api.github.com/repos/lichuu/moshpit";
  const v2 = build("v1.1.0", 12);
  const asset = (id) => `${api}/releases/assets/${id}`;
  const release = { tag_name: "v1.1.0", assets: [{ name: "moshpit-linux-x64", url: asset(1) }, { name: "moshpit-linux-x64.json", url: asset(2) }] };
  return {
    api,
    v2,
    routes: {
      [`${api}/releases/latest`]: { body: JSON.stringify(release) },
      [asset(2)]: { body: JSON.stringify(v2.manifest) },
      [asset(1)]: { redirect: binaryRedirect },
      "https://github.com/lichuu/moshpit/releases/download/v1.1.0/moshpit-linux-x64": { redirect: "https://release-assets.githubusercontent.com/signed/1" },
      "https://release-assets.githubusercontent.com/signed/1": { body: v2.binary },
    },
  };
}

test("the token goes to api.github.com and github.com, never to the host a download redirects to", async () => {
  const { api, v2, routes } = githubRelease({ binaryRedirect: "https://github.com/lichuu/moshpit/releases/download/v1.1.0/moshpit-linux-x64" });
  const net = network(routes);
  const download = await downloadRelease({ fetch: net.fetch, api, arch: "x64", token: TOKEN });
  assert.deepEqual(download.binary, v2.binary);
  assert.deepEqual(net.sentTo("api.github.com"), [`Bearer ${TOKEN}`, `Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);
  assert.deepEqual(net.sentTo("github.com"), [`Bearer ${TOKEN}`]);
  assert.deepEqual(net.sentTo("release-assets.githubusercontent.com"), [null]);
});

test("a redirect to a lookalike host, another port or plain HTTP gets no token", async () => {
  for (const target of ["https://api.github.com.evil.example/x", "https://api.github.com:8443/x", "https://evil.example/api.github.com/x", "https://github.com@evil.example/x"]) {
    const { api, routes } = githubRelease({ binaryRedirect: target });
    const net = network(routes);
    await assert.rejects(downloadRelease({ fetch: net.fetch, api, arch: "x64", token: TOKEN }), /answered HTTP 404/, target);
    const last = net.seen.at(-1);
    assert.equal(last.url, new URL(target).href, target);
    assert.equal(last.authorization, null, target);
  }
  const { api, routes } = githubRelease({ binaryRedirect: "http://api.github.com/x" });
  const net = network(routes);
  await assert.rejects(downloadRelease({ fetch: net.fetch, api, arch: "x64", token: TOKEN }), /redirected to http:, not https:/);
  assert.ok(!net.seen.some((entry) => entry.url.startsWith("http:")), "the http hop is never requested");
});

test("without a token, a 404 says the repository may be private and names the variable", async () => {
  const net = network({});
  await assert.rejects(
    downloadRelease({ fetch: net.fetch, api: "https://api.github.com/repos/lichuu/moshpit", arch: "x64" }),
    /answered HTTP 404; if the repository is private, set MOSHPIT_GITHUB_TOKEN \(or GH_TOKEN\)/,
  );
  assert.deepEqual(net.seen.map((entry) => entry.authorization), [null]);
});

test("update reads the token from MOSHPIT_GITHUB_TOKEN or GH_TOKEN, sends it to no other host, and never prints it", async (t) => {
  for (const name of ["MOSHPIT_GITHUB_TOKEN", "GH_TOKEN"]) {
    const { server, m } = await world(t, { env: { [name]: TOKEN } });
    const v2 = build("v1.1.0", 12);
    m.register(v2);
    server.publish(v2);
    const updated = await m.update();
    assert.equal(updated.exitCode, 0, name);
    assert.deepEqual(server.authorizations, [], `${name}: a non-GitHub release API gets no token`);
    assert.ok(!JSON.stringify(updated.result).includes(TOKEN), name);

    const { api, routes } = githubRelease({ binaryRedirect: "https://release-assets.githubusercontent.com/signed/1" });
    const net = network(routes);
    const missing = await m.update({ version: "v9.9.9" }, { fetch: net.fetch, env: { ...m.env, MOSHPIT_RELEASE_API: api } });
    assert.equal(missing.exitCode, EXIT.source, name);
    assert.deepEqual(net.sentTo("api.github.com"), [`Bearer ${TOKEN}`], name);
    assert.ok(!JSON.stringify(missing.result).includes(TOKEN), `${name}: not in a refusal either`);
  }
});

test("--purge needs --yes without a terminal, asks on one, and deletes config and state", async (t) => {
  const { m } = await world(t);
  const before = await snapshot(m);
  const blocked = await m.uninstall({ purge: true });
  assert.equal(blocked.exitCode, EXIT.confirmBlocked);
  assert.deepEqual(await snapshot(m), before);
  assert.deepEqual(m.host.mutations, []);

  const questions = [];
  const declined = await m.uninstall({ purge: true }, { isTTY: true, prompt: async (question) => (questions.push(question), false) });
  assert.equal(declined.exitCode, EXIT.confirmBlocked);
  assert.match(questions[0], /Delete moshpit's config .* and all device state/);
  assert.deepEqual(await snapshot(m), before);

  const purged = await m.uninstall({ purge: true, yes: true });
  assert.equal(purged.exitCode, 0, JSON.stringify(purged.result));
  assert.equal(purged.result.state, "purged");
  for (const gone of [m.paths.config, m.paths.state, m.paths.data]) assert.equal(existsSync(gone), false, gone);
  assert.equal((await m.uninstall({ purge: true, yes: true })).exitCode, 0, "a purged host purges again as a no-op");
});

test("update, rollback and uninstall refuse in container mode", async (t) => {
  const v1 = build("v1.0.0", 10);
  const m = await installed(t, { first: v1 });
  m.env.MOSHPIT_SUPERVISOR = "container";
  const before = await snapshot(m);
  for (const run of [m.update, m.rollback, m.uninstall]) {
    const { result, exitCode } = await run();
    assert.equal(exitCode, EXIT.container);
    assert.match(result.steps[0].detail, /new image tags/);
  }
  assert.deepEqual(await snapshot(m), before);
});

test("the release download is size-bounded and never steps down from the API's scheme", async (t) => {
  const { server, m } = await world(t);
  const v2 = build("v1.1.0", 12);
  server.publish(v2, { tamper: (files) => (files["moshpit-linux-x64.json"] = Buffer.alloc(65 * 1024)) });
  const big = await m.update();
  assert.equal(big.exitCode, EXIT.source);
  assert.match(big.result.steps.at(-1).detail, /more than the 65536 bytes allowed/);
  server.settings.chunked = true;
  const streamed = await m.update();
  assert.equal(streamed.exitCode, EXIT.source, "a body without a Content-Length is bounded while it streams");
  assert.match(streamed.result.steps.at(-1).detail, /more than the 65536 bytes allowed/);
  server.settings.chunked = false;
  server.publish(v2);
  server.settings.assetBase = server.api.replace(/^http:/, "https:").replace(/\/repo$/, "");
  const switched = await m.update();
  assert.equal(switched.exitCode, EXIT.source);
  assert.match(switched.result.steps.at(-1).detail, /serves moshpit-linux-x64\S* over https:/);
});

test("a staged release that reports another version is not switched to", async (t) => {
  const { server, v1, m } = await world(t);
  const v2 = build("v1.1.0", 12);
  m.register(v2);
  server.publish(v2);
  v2.info = { ...v2.info, version: "v9.9.9" };
  const { result, exitCode } = await m.update();
  assert.equal(exitCode, EXIT.verification, JSON.stringify(result));
  assert.match(result.steps.find((entry) => entry.id === "staged").detail, /reports version "v9\.9\.9", not v1\.1\.0/);
  assert.equal(await currentOf(m), `releases/${v1.version}`);
  assert.deepEqual(await releasesOf(m), [v1.version], "the staged copy is removed");
  assert.deepEqual(m.host.mutations, []);

  // A copy left in place by an interrupted run is asked again, not trusted by its hash.
  await mkdir(path.dirname(m.paths.release("v1.1.0")));
  await writeFile(m.paths.release("v1.1.0"), v2.binary, { mode: 0o755 });
  const resumed = await m.update();
  assert.equal(resumed.exitCode, EXIT.verification, JSON.stringify(resumed.result));
  assert.equal(await currentOf(m), `releases/${v1.version}`);
  assert.deepEqual(m.host.mutations, []);
});

test("the CLI prints one --json result and rejects unknown flags", async (t) => {
  const { server, m } = await world(t);
  server.publish(build("v0.9.0", 9));
  const out = [];
  const io = { stdout: { write: (text) => out.push(text) }, stderr: { write: (text) => out.push(text) }, exitCode: undefined };
  await maintainMain("update", ["--json"], { io, context: ({ options }) => m.context(options) });
  assert.equal(out.length, 1);
  const updated = parseEnvelope(out[0], "update", { exitCode: EXIT.downgrade });
  assert.deepEqual(Object.keys(updated.result), ["state", "steps"]);
  assert.equal(updated.error.code, updated.result.steps.find((entry) => entry.status === "failed" || entry.status === "blocked").id);
  assert.equal(io.exitCode, EXIT.downgrade);
  for (const command of ["rollback", "uninstall"]) {
    out.length = 0;
    await maintainMain(command, ["--json"], { io, context: ({ options }) => m.context(options) });
    const other = parseEnvelope(out[0], command, { exitCode: io.exitCode });
    assert.ok(Object.keys(other.result).every((key) => ["state", "steps", "next"].includes(key)), command);
  }
  out.length = 0;
  await maintainMain("uninstall", ["--version", "v1"], { io, context: () => assert.fail("no context for a usage error") });
  assert.equal(io.exitCode, EXIT.usage);
  await maintainMain("update", ["--version", "../x"], { io, context: () => assert.fail("no context for a usage error") });
  assert.equal(io.exitCode, EXIT.usage);
});

test("a current link that setup did not make is a conflict", async (t) => {
  const { server, m } = await world(t);
  server.publish(build("v1.1.0", 12));
  await rm(m.paths.current);
  await symlink("/opt/elsewhere", m.paths.current);
  const { exitCode } = await m.update();
  assert.equal(exitCode, EXIT.conflict);
  assert.equal(await readlink(m.paths.current), "/opt/elsewhere");
});
