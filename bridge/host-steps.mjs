import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readlink, rename, stat, symlink } from "node:fs/promises";
import path from "node:path";
import { CONFIG_SCHEMA_VERSION, MAX_CONFIG_BYTES, parseHostConfig } from "./host-config.mjs";
import {
  findExecutable,
  LEGACY_UNIT_NAME,
  managerReachable,
  parseOperatorUser,
  parseProperties,
  parseServeStatus,
  parseTailscaleStatus,
  runCommand,
  UNIT_NAME,
} from "./host-probe.mjs";
import { readPrivateFile, writePrivateFile } from "./private-files.mjs";

// The two tables host setup walks. Preflight rows only read the host; each
// fills in part of ctx.plan, the values every later step works from. Steps
// read the actual resources in isDone and change them in apply.

export const OK = Object.freeze({ ok: true });
const fail = (message) => ({ fail: message });

// In the container image (MOSHPIT_SUPERVISOR=container) Docker's restart
// policy supervises the bridge, the image is the release, and the Tailscale
// sidecar's serve.json owns the Serve route. Rows and steps for what the
// container already provides report this reason instead of running.
export const CONTAINER_SUPERVISED = "container-supervised";
const inContainer = (ctx) => ctx.env.MOSHPIT_SUPERVISOR === "container";
const SKIPPED = Object.freeze({ ok: true, skipped: CONTAINER_SUPERVISED });
const skippedInContainer = (ctx) => (inContainer(ctx) ? CONTAINER_SUPERVISED : null);
const signInHint = (ctx) =>
  inContainer(ctx) ?
    "Sign in the tailscale sidecar with an untagged TS_AUTHKEY or an interactive login (docker compose logs tailscale shows why it is not)"
  : "Sign in with: sudo tailscale up";
const logsHint = (ctx) => (inContainer(ctx) ? "docker compose logs moshpit" : `journalctl --user -u ${UNIT_NAME}`);

/** Thrown by a step that needs an operator decision it was not given. */
export class StepBlocked extends Error {}

/** Thrown when a resource setup would change belongs to something else. */
export class StepConflict extends Error {}

const BRIDGE_PORTS = [8801, 8802, 8803, 8804, 8805, 8806, 8807, 8808, 8809, 8810];
// What bridge/index.mjs listens on when a config names no port.
const BRIDGE_DEFAULT_PORT = 8787;
export const HTTPS_PORTS = [443, 8803];

const firstLine = (text) => text.trim().split("\n")[0] ?? "";
export const bridgeTarget = (plan) => `http://127.0.0.1:${plan.bridgePort}`;
const originFor = (dnsName, port) => (port === 443 ? `https://${dnsName}` : `https://${dnsName}:${port}`);

/** The values steps need, from a validated config. */
export function planFromConfig(config) {
  const origin = new URL(config.publicOrigin);
  return {
    config,
    publicOrigin: config.publicOrigin,
    host: origin.hostname,
    httpsPort: Number(origin.port || 443),
    bridgePort: config.port ?? BRIDGE_DEFAULT_PORT,
    owner: config.trustedOwner ?? null,
    stateDir: config.stateDir,
  };
}

async function readConfig(file) {
  const text = await readPrivateFile(file, { maxBytes: MAX_CONFIG_BYTES });
  return text === null ? null : parseHostConfig(text);
}

async function tailscale(ctx) {
  const result = await runCommand(ctx.runner, "tailscaleStatus");
  if (result.code === 127) return fail("Tailscale is not installed. Install it from https://tailscale.com/download, sign in, then rerun setup.");
  let status;
  try {
    status = parseTailscaleStatus(result.stdout);
  } catch {
    const start = inContainer(ctx) ? "Check that the tailscale sidecar is running and shares its socket volume" : "Start tailscaled";
    return fail(`tailscale status did not answer (${firstLine(result.stderr) || `exit ${result.code}`}). ${start}, then ${signInHint(ctx).replace(/^Sign/, "sign")}.`);
  }
  if (!status.running) return fail(`Tailscale is not signed in on this machine. ${signInHint(ctx)}.`);
  if (!status.dnsName) return fail("This machine has no Tailscale DNS name. Enable MagicDNS and HTTPS certificates for the tailnet, then rerun setup.");
  ctx.plan.tailscale = status;
  return OK;
}

async function freeBridgePort(ctx) {
  for (const port of BRIDGE_PORTS) if (await ctx.portFree(port)) return port;
  return null;
}

/**
 * Each row: `{ id, exitCode, run(ctx) -> OK | { fail } }`. Rows run in order
 * and stop at the first failure, before anything on the host changes. A row
 * that passes without an answer returns `{ ok, skipped }` or `{ ok, unknown }`.
 */
export const CHECKS = [
  {
    id: "release",
    exitCode: 10,
    run: (ctx) => {
      if (!ctx.release)
        return fail("Setup installs the release executable, and this is a source checkout. Build it with npm run build:release, then run dist/release/moshpit-linux-<arch> setup.");
      // The version names a directory under releases/.
      if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(ctx.release.version))
        return fail(`This executable's version ${JSON.stringify(ctx.release.version)} cannot name a release directory; use a published release.`);
      return OK;
    },
  },
  {
    id: "paths",
    exitCode: 22,
    run: (ctx) => {
      // systemd takes an executable path literally: no $ expansion and no
      // quote or backslash escapes, so these characters cannot be written.
      const unsafe = [ctx.paths.currentExecutable, ctx.paths.config].find((file) => /[\p{Cc}"'\\$]/u.test(file));
      if (unsafe === undefined) return OK;
      return fail(
        `${JSON.stringify(unsafe)} holds a quote, backslash, $ or control character, which the systemd unit cannot hold. Point XDG_DATA_HOME and XDG_CONFIG_HOME (or HOME) at paths without them, then rerun setup.`,
      );
    },
  },
  {
    id: "arch",
    exitCode: 11,
    run: (ctx) =>
      ["x64", "arm64"].includes(ctx.arch) ? OK : fail(`moshpit runs on x64 and arm64 Linux; this machine is ${ctx.arch}.`),
  },
  {
    id: "libc",
    exitCode: 12,
    run: (ctx) =>
      ctx.glibc ? OK : (
        fail("This host has no glibc (musl hosts such as Alpine are not supported). Run the moshpit container image, which uses a glibc base, instead.")
      ),
  },
  {
    id: "user",
    exitCode: 13,
    run: (ctx) =>
      ctx.uid !== 0 ? OK : (
        fail(
          [
            "Setup refuses to run as root; moshpit runs as an ordinary user. Create one, copy the executable to it, and rerun setup from its own login:",
            "  sudo useradd --create-home --shell /bin/bash moshpit",
            "  sudo install -o moshpit -m 0755 ./moshpit-linux-* /home/moshpit/moshpit",
            "  ssh moshpit@<this host>   (or: sudo machinectl shell moshpit@)",
            "  ./moshpit setup",
          ].join("\n"),
        )
      ),
  },
  {
    id: "systemd",
    exitCode: 14,
    run: async (ctx) => {
      const supervisor = ctx.env.MOSHPIT_SUPERVISOR;
      if (supervisor === "container") return SKIPPED;
      if (supervisor !== undefined)
        return fail(`MOSHPIT_SUPERVISOR is ${JSON.stringify(supervisor)}. Set it to container inside the moshpit image, or unset it for a systemd user service.`);
      const result = await runCommand(ctx.runner, "userManager");
      return managerReachable(result.stdout) ? OK : (
          fail("The systemd user manager is not reachable. Log in as this user through ssh or a console (not su or sudo), so systemctl --user works, then rerun setup.")
        );
    },
  },
  {
    id: "legacy-service",
    exitCode: 15,
    run: async (ctx) => {
      if (inContainer(ctx)) return SKIPPED;
      const result = await runCommand(ctx.runner, "unitShow", LEGACY_UNIT_NAME);
      const loadState = parseProperties(result.stdout).LoadState;
      if (result.code !== 0 || !loadState)
        return fail(
          `Setup could not query ${LEGACY_UNIT_NAME} (${firstLine(result.stderr) || `exit ${result.code}`}), so it cannot tell whether the checkout helper's service is installed. Check that systemctl --user works for this login, then rerun setup.`,
        );
      if (loadState === "not-found") return OK;
      return fail(
        [
          `${LEGACY_UNIT_NAME} from the checkout helper is installed. Setup will not run beside it. First move its settings, then stop it:`,
          "  moshpit config migrate deploy/bridge.env ~/.config/moshpit/config.json",
          `  systemctl --user disable --now ${LEGACY_UNIT_NAME}`,
          `  rm ~/.config/systemd/user/${LEGACY_UNIT_NAME} && systemctl --user daemon-reload`,
          "Then rerun setup; it keeps the migrated config and its origin.",
        ].join("\n"),
      );
    },
  },
  { id: "tailscale", exitCode: 16, run: tailscale },
  {
    id: "owner",
    exitCode: 17,
    run: (ctx) => {
      const { tagged, owner } = ctx.plan.tailscale;
      const untagged =
        inContainer(ctx) ?
          "an auth key created without tags, or an interactive login, then recreate the sidecar's state volume"
        : "sudo tailscale up --force-reauth, without --advertise-tags";
      if (tagged)
        return fail(
          `This Tailscale node is tagged, so no user owns it, and moshpit trusts exactly the user who owns the node. Sign it in as your own user without tags (${untagged}), then rerun setup.`,
        );
      if (!owner) return fail("Tailscale lists no user record for this node's owner. Sign in again with: sudo tailscale up --force-reauth");
      return OK;
    },
  },
  {
    id: "config",
    exitCode: 18,
    run: async (ctx) => {
      if (ctx.journal.unreadable) return fail(ctx.journal.unreadable);
      const { owner, dnsName } = ctx.plan.tailscale;
      // A config step that finished means this host is installed, even if the
      // config is gone; treating it as fresh would move the origin. An entry
      // without `at` only journaled its previous value and may be resumed.
      const installed = Boolean(ctx.journal.steps.configured?.at);
      const startOver = installed ? "" : ", or move it aside to start over";
      let config;
      try {
        config = await readConfig(ctx.paths.config);
      } catch (error) {
        return fail(`${ctx.paths.config} is not a usable config: ${error.message}. Fix it (moshpit config check ${ctx.paths.config} shows why)${startOver}, then rerun setup.`);
      }
      if (config === null) {
        if (!installed) {
          ctx.plan.existing = false;
          return OK;
        }
        const port = ctx.journal.steps["serve-configured"]?.previous?.port;
        const origin = Number.isInteger(port) ? ` serving ${originFor(dnsName, port)}` : "";
        return fail(
          `${ctx.paths.journal} records an install${origin}, but ${ctx.paths.config} is missing. Restore that config, then rerun setup. Setup never moves an existing origin.`,
        );
      }
      if (config.authMode !== "tailscale" || config.trustedOwner !== owner)
        return fail(
          `${ctx.paths.config} trusts ${config.trustedOwner ?? "no Tailscale user"} (${config.authMode} mode), but this node belongs to ${owner}. Setup never changes the owner; sign in to Tailscale as the owner the config names${startOver}.`,
        );
      if (new URL(config.publicOrigin).hostname !== dnsName)
        return fail(`${ctx.paths.config} serves ${config.publicOrigin}, which is not this machine (${dnsName}). Setup never moves an origin.`);
      ctx.plan.existing = true;
      Object.assign(ctx.plan, planFromConfig(config));
      return OK;
    },
  },
  {
    // Tailscale lets only root and its operator change Serve, so without this
    // setup would stop at serve-configured with the service already running.
    // It runs after config: when the configured origin's route already points
    // at this bridge, serve-configured has nothing to change, so a rerun or
    // --recover needs no operator. The route decides, not the journal.
    id: "tailscale-operator",
    exitCode: 23,
    run: async (ctx) => {
      if (inContainer(ctx)) return SKIPPED;
      if (ctx.plan.existing) {
        const routes = await serveRoutes(ctx).catch(() => null);
        if (routes?.get(ctx.plan.httpsPort) === bridgeTarget(ctx.plan))
          return { ok: true, skipped: `Serve already proxies port ${ctx.plan.httpsPort} to this bridge` };
      }
      const result = await runCommand(ctx.runner, "tailscalePrefs");
      let operator;
      try {
        if (result.code !== 0) throw new Error();
        operator = parseOperatorUser(result.stdout);
      } catch {
        return { ok: true, unknown: `tailscale debug prefs did not give an operator (${firstLine(result.stderr) || `exit ${result.code}`}); continuing` };
      }
      if (operator === ctx.user) return OK;
      const now = operator ? `is ${operator}` : "is not set";
      return fail(
        `Tailscale lets only root and its operator change Serve, and its operator ${now}, not ${ctx.user}. Make ${ctx.user} the operator, then rerun setup:\n  sudo tailscale set --operator=${ctx.user}`,
      );
    },
  },
  {
    id: "herdr",
    exitCode: 19,
    run: async (ctx) => {
      const bin = ctx.plan.config?.herdrBin ?? (await findExecutable("herdr", ctx.env.PATH));
      if (!bin) return fail("herdr is not on PATH. Install herdr for this user, then rerun setup.");
      const result = await runCommand(ctx.runner, "herdrVersion", bin);
      if (result.code !== 0)
        return fail(`${bin} --version failed (${firstLine(result.stderr) || `exit ${result.code}`}). Repair the herdr install, then rerun setup.`);
      ctx.plan.herdrBin = bin;
      return OK;
    },
  },
  {
    id: "https-port",
    exitCode: 20,
    run: async (ctx) => {
      const result = await runCommand(ctx.runner, "serveStatus");
      let routes;
      try {
        if (result.code !== 0) throw new Error();
        routes = parseServeStatus(result.stdout);
      } catch {
        return fail(`tailscale serve status did not answer (${firstLine(result.stderr) || `exit ${result.code}`}).`);
      }
      const requested = ctx.options.port;
      if (inContainer(ctx)) return sidecarServe(ctx, routes, requested);
      if (ctx.plan.existing) {
        const { httpsPort, publicOrigin } = ctx.plan;
        if (requested !== undefined && requested !== httpsPort)
          return fail(`This host already serves ${publicOrigin}. --port ${requested} cannot move an existing origin.`);
        const target = routes.get(httpsPort);
        if (target !== undefined && target !== bridgeTarget(ctx.plan))
          return fail(`Serve port ${httpsPort} proxies to ${target}, not this bridge. Setup will not overwrite it; free the port, then rerun setup.`);
        return OK;
      }
      const candidates = requested === undefined ? HTTPS_PORTS : [requested];
      const port = candidates.find((candidate) => !routes.has(candidate));
      if (port === undefined)
        return fail(
          `${candidates.map((candidate) => `Serve port ${candidate} already proxies to ${routes.get(candidate)}`).join("; ")}. Setup will not overwrite a route; free ${candidates.length > 1 ? "one of them" : "it"}, then rerun setup.`,
        );
      ctx.plan.httpsPort = port;
      ctx.plan.publicOrigin = originFor(ctx.plan.tailscale.dnsName, port);
      return OK;
    },
  },
  {
    id: "bridge-port",
    exitCode: 21,
    run: async (ctx) => {
      if (ctx.plan.existing) return OK;
      if (inContainer(ctx)) {
        const port = ctx.plan.servedBridgePort;
        if (!(await ctx.portFree(port)))
          return fail(`127.0.0.1:${port}, where the sidecar's Serve config sends HTTPS, is already in use. Stop whatever listens there, then rerun setup.`);
        return planConfig(ctx, port);
      }
      const port = await freeBridgePort(ctx);
      if (port === null) return fail(`No loopback port from ${BRIDGE_PORTS[0]} to ${BRIDGE_PORTS.at(-1)} is free for the bridge.`);
      return planConfig(ctx, port);
    },
  },
];

function planConfig(ctx, port) {
  const config = {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    authMode: "tailscale",
    trustedOwner: ctx.plan.tailscale.owner,
    publicOrigin: ctx.plan.publicOrigin,
    allowedAuthorities: [new URL(ctx.plan.publicOrigin).host],
    bind: "127.0.0.1",
    port,
    herdrBin: ctx.plan.herdrBin,
    stateDir: ctx.paths.state,
  };
  Object.assign(ctx.plan, planFromConfig(parseHostConfig(JSON.stringify(config))));
  return OK;
}

const loopbackPortOf = (target) => /^http:\/\/127\.0\.0\.1:([0-9]+)$/.exec(target ?? "")?.[1];

/**
 * The https-port row in a container. Setup never changes Serve there: it
 * adopts the port the sidecar's serve.json proxies to a loopback bridge, or,
 * on a configured host, requires that route to still reach this bridge.
 */
function sidecarServe(ctx, routes, requested) {
  const fix = "Mount deploy/container/serve.json into the sidecar as TS_SERVE_CONFIG, restart the sidecar, then rerun setup.";
  if (ctx.plan.existing) {
    const { httpsPort, publicOrigin } = ctx.plan;
    if (requested !== undefined && requested !== httpsPort)
      return fail(`This host already serves ${publicOrigin}. --port ${requested} cannot move an existing origin.`);
    const target = routes.get(httpsPort);
    if (target === bridgeTarget(ctx.plan)) return OK;
    const found = target === undefined ? "has no route on that port" : `proxies it to ${target}`;
    return fail(`${publicOrigin} needs the sidecar's Serve config to proxy port ${httpsPort} to ${bridgeTarget(ctx.plan)}, but it ${found}. ${fix}`);
  }
  const candidates = requested === undefined ? HTTPS_PORTS : [requested];
  const port = candidates.find((candidate) => loopbackPortOf(routes.get(candidate)) !== undefined);
  if (port === undefined)
    return fail(`The sidecar's Serve config proxies ${candidates.map(String).join(" or ")} to no loopback bridge port. ${fix}`);
  ctx.plan.httpsPort = port;
  ctx.plan.publicOrigin = originFor(ctx.plan.tailscale.dnsName, port);
  ctx.plan.servedBridgePort = Number(loopbackPortOf(routes.get(port)));
  return OK;
}

async function readLinkOrNull(file) {
  try {
    return await readlink(file);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EINVAL") return null;
    throw error;
  }
}

async function sha256Of(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function sameFile(a, b) {
  const [left, right] = await Promise.all([stat(a), stat(b)]);
  return left.size === right.size && (await sha256Of(a)) === (await sha256Of(b));
}

const releaseLink = (version) => path.join("releases", version);

/**
 * The unit text. Quotes keep a path with spaces as one argument and `%` is
 * doubled for systemd's specifiers; the paths check refuses anything else a
 * unit cannot hold.
 */
export function unitText(paths) {
  const quote = (value) => `"${value.replace(/%/g, "%%")}"`;
  return [
    "[Unit]",
    "Description=moshpit bridge",
    "After=network-online.target tailscaled.service",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${quote(paths.currentExecutable)} bridge`,
    `Environment=${quote(`MOSHPIT_CONFIG=${paths.config}`)}`,
    "Restart=on-failure",
    "RestartSec=3",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

const readUnit = (ctx) => readPrivateFile(ctx.paths.unit, { maxBytes: 64 * 1024 }).catch(() => null);

async function unitState(ctx) {
  const result = await runCommand(ctx.runner, "unitShow", UNIT_NAME);
  return parseProperties(result.stdout);
}

async function serveRoutes(ctx) {
  const result = await runCommand(ctx.runner, "serveStatus");
  if (result.code !== 0) throw new Error(`tailscale serve status failed (${firstLine(result.stderr) || `exit ${result.code}`})`);
  return parseServeStatus(result.stdout);
}

async function lingerOn(ctx) {
  const result = await runCommand(ctx.runner, "lingerShow", ctx.user);
  return result.code === 0 && result.stdout.trim() === "yes";
}

export async function answersAuthInfo(ctx) {
  const { publicOrigin } = ctx.plan;
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await ctx.fetch(`${publicOrigin}/api/auth-info`, {
        headers: { Origin: publicOrigin },
        signal: AbortSignal.timeout(5000),
      });
      if (response.status === 200 && Number.isInteger((await response.json()).protocol)) return true;
    } catch {
      // Not answering yet; the service may still be starting.
    }
    if (attempt >= ctx.verifyAttempts) return false;
    await ctx.sleep(ctx.verifyDelayMs);
  }
}

/** The service step on a host: a systemd user unit, written and enabled by setup. */
const SYSTEMD_SERVICE = {
  describe: (ctx) => `${UNIT_NAME} enabled and running ${ctx.paths.currentExecutable}`,
  async isDone(ctx) {
    if ((await readUnit(ctx)) !== unitText(ctx.paths)) return false;
    const unit = await unitState(ctx);
    return unit.LoadState === "loaded" && unit.NeedDaemonReload === "no" && unit.UnitFileState === "enabled" && unit.ActiveState === "active";
  },
  // A hash, never the text: a hand-written unit may carry anything.
  snapshot: async (ctx) => {
    const text = await readUnit(ctx);
    return { unitSha256: text === null ? null : createHash("sha256").update(text).digest("hex") };
  },
  async conflict(ctx) {
    const text = await readUnit(ctx);
    if (text === null || text === unitText(ctx.paths)) return null;
    return `${ctx.paths.unit} exists and is not the unit setup writes. Setup will not overwrite it; move it aside if moshpit may replace it, then rerun setup.`;
  },
  async apply(ctx) {
    const text = unitText(ctx.paths);
    if ((await readUnit(ctx)) !== text) {
      await mkdir(path.dirname(ctx.paths.unit), { recursive: true });
      await writePrivateFile(ctx.paths.unit, text);
    }
    // Each command runs only when the manager still needs it, so a resumed
    // run never repeats one that already took effect.
    let unit = await unitState(ctx);
    if (unit.LoadState !== "loaded" || unit.NeedDaemonReload !== "no") {
      await mustRun(ctx, "daemonReload");
      unit = await unitState(ctx);
    }
    if (unit.UnitFileState !== "enabled" || unit.ActiveState !== "active") await mustRun(ctx, "enableNow", UNIT_NAME);
  },
};

/**
 * The service step in the container: the image's command is moshpit bridge,
 * which waits for the config and starts once setup writes it. Setup changes
 * nothing here; it records the supervisor and waits for the bridge to answer.
 */
const CONTAINER_SERVICE = {
  describe: (ctx) => `${CONTAINER_SUPERVISED}: the container's moshpit bridge answers on 127.0.0.1:${ctx.plan.bridgePort}`,
  isDone: (ctx) => (ctx.plan.bridgePort && ctx.plan.publicOrigin ? ctx.bridgeAnswers(ctx.plan.bridgePort, ctx.plan.publicOrigin) : false),
  snapshot: async () => ({ supervisor: CONTAINER_SUPERVISED }),
  conflict: async () => null,
  async apply(ctx) {
    for (let attempt = 1; attempt < ctx.verifyAttempts; attempt++) {
      await ctx.sleep(ctx.verifyDelayMs);
      if (await CONTAINER_SERVICE.isDone(ctx)) return;
    }
    throw new Error(
      `The bridge did not answer on 127.0.0.1:${ctx.plan.bridgePort}. The container's command must be moshpit bridge, the image default. Check: ${logsHint(ctx)}`,
    );
  },
};

const supervisor = (ctx) => (inContainer(ctx) ? CONTAINER_SERVICE : SYSTEMD_SERVICE);

async function mustRun(ctx, name, ...args) {
  const result = await runCommand(ctx.runner, name, ...args);
  if (result.code !== 0) throw new Error(`${name} failed (${firstLine(result.stderr) || `exit ${result.code}`})`);
  return result;
}

/**
 * The installer state machine, in order. Each step:
 * - `isDone(ctx)` reads the actual resource and never changes anything;
 * - `snapshot(ctx)` records the value it replaces, before apply, for the journal;
 * - `conflict(ctx)` names a resource that belongs to something else;
 * - `apply(ctx)` makes it so, or throws StepBlocked for a missing decision.
 * `confirm` marks steps covered by the machine/account confirmation, and
 * `check` a step that only reads, so passing it is reported as done.
 * `skipped(ctx)`, when present, gives the reason a step does not apply to
 * this host; the walk reports it and neither reads nor journals the step.
 */
export const STEPS = [
  {
    id: "staged",
    confirm: true,
    // The image is the release; a new image tag is the update.
    skipped: skippedInContainer,
    describe: (ctx) => `release ${ctx.release.version} at ${ctx.paths.release(ctx.release.version)}`,
    async isDone(ctx) {
      if (!ctx.release) return false;
      if ((await readLinkOrNull(ctx.paths.current)) !== releaseLink(ctx.release.version)) return false;
      const target = ctx.paths.release(ctx.release.version);
      try {
        if (((await stat(target)).mode & 0o111) === 0) return false;
      } catch {
        return false;
      }
      return !ctx.release.executable || (await sameFile(ctx.release.executable, target));
    },
    snapshot: async (ctx) => ({ current: await readLinkOrNull(ctx.paths.current) }),
    async conflict(ctx) {
      const current = await readLinkOrNull(ctx.paths.current);
      if (current === null || current === releaseLink(ctx.release.version)) return null;
      return `${ctx.paths.current} points to ${current}. Setup does not switch releases; use moshpit update.`;
    },
    async apply(ctx) {
      const target = ctx.paths.release(ctx.release.version);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
      const temporary = `${target}.${randomUUID()}.tmp`;
      await copyFile(ctx.release.executable, temporary);
      await chmod(temporary, 0o755);
      await rename(temporary, target);
      const link = `${ctx.paths.current}.${randomUUID()}.tmp`;
      await symlink(releaseLink(ctx.release.version), link);
      await rename(link, ctx.paths.current);
    },
  },
  {
    id: "configured",
    confirm: true,
    describe: (ctx) => `${ctx.paths.config} serving ${ctx.plan.publicOrigin} for ${ctx.plan.owner}, bridge on 127.0.0.1:${ctx.plan.bridgePort}`,
    async isDone(ctx) {
      try {
        return (await readConfig(ctx.paths.config)) !== null;
      } catch {
        return false;
      }
    },
    snapshot: async (ctx) => ({ existed: (await lstat(ctx.paths.config).catch(() => null)) !== null }),
    async apply(ctx) {
      const text = `${JSON.stringify(ctx.plan.config, null, 2)}\n`;
      parseHostConfig(text);
      await mkdir(path.dirname(ctx.paths.config), { recursive: true, mode: 0o700 });
      await writePrivateFile(ctx.paths.config, text);
    },
  },
  {
    id: "service-started",
    confirm: true,
    describe: (ctx) => supervisor(ctx).describe(ctx),
    isDone: (ctx) => supervisor(ctx).isDone(ctx),
    snapshot: (ctx) => supervisor(ctx).snapshot(ctx),
    conflict: (ctx) => supervisor(ctx).conflict(ctx),
    apply: (ctx) => supervisor(ctx).apply(ctx),
  },
  {
    id: "persistence",
    blockedCode: 32,
    // The container's restart policy keeps the bridge running instead.
    skipped: skippedInContainer,
    describe: (ctx) => `lingering enabled for ${ctx.user}, so the service survives logout and reboot`,
    isDone: lingerOn,
    // Uninstall disables lingering only when this records that setup enabled it.
    snapshot: async (ctx) => ({ linger: await lingerOn(ctx) }),
    async apply(ctx) {
      const hint = `sudo loginctl enable-linger ${ctx.user}`;
      let allowed = ctx.options.allowLinger;
      if (!allowed && ctx.isTTY)
        allowed = await ctx.prompt(`Keep moshpit running after ${ctx.user} logs out? This runs loginctl enable-linger ${ctx.user}. [y/N] `);
      if (!allowed)
        throw new StepBlocked(
          `Lingering is off, so the service stops when ${ctx.user} logs out. Rerun setup with --allow-linger, or run: ${hint}`,
        );
      const result = await runCommand(ctx.runner, "lingerEnable", ctx.user);
      if (result.code !== 0)
        throw new StepBlocked(`loginctl enable-linger was refused (${firstLine(result.stderr) || `exit ${result.code}`}). Ask an administrator to run: ${hint}`);
    },
  },
  {
    id: "serve-configured",
    confirm: true,
    // The sidecar's serve.json holds the route; the https-port row checks it.
    skipped: skippedInContainer,
    describe: (ctx) => `Tailscale Serve port ${ctx.plan.httpsPort} proxies to ${bridgeTarget(ctx.plan)}`,
    async isDone(ctx) {
      if (ctx.plan.httpsPort === undefined) return false;
      return (await serveRoutes(ctx)).get(ctx.plan.httpsPort) === bridgeTarget(ctx.plan);
    },
    snapshot: async (ctx) => ({ port: ctx.plan.httpsPort, target: (await serveRoutes(ctx)).get(ctx.plan.httpsPort) ?? null }),
    async conflict(ctx) {
      const target = (await serveRoutes(ctx)).get(ctx.plan.httpsPort);
      if (target === undefined || target === bridgeTarget(ctx.plan)) return null;
      return `Serve port ${ctx.plan.httpsPort} now proxies to ${target}. Setup will not overwrite it; free the port, then rerun setup.`;
    },
    apply: (ctx) => mustRun(ctx, "serveAdd", ctx.plan.httpsPort, bridgeTarget(ctx.plan)),
  },
  {
    id: "verified",
    failedCode: 34,
    check: true,
    describe: (ctx) => `${ctx.plan.publicOrigin}/api/auth-info answers through Tailscale`,
    isDone: (ctx) => (ctx.plan.publicOrigin ? answersAuthInfo(ctx) : false),
    snapshot: async () => null,
    async apply(ctx) {
      throw new Error(`${ctx.plan.publicOrigin}/api/auth-info did not answer with 200 and a protocol. Check: ${logsHint(ctx)}`);
    },
  },
];
