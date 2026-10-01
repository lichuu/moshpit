import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { request } from "node:http";
import { createServer } from "node:net";
import path from "node:path";

// What host setup reads from the machine. Every external command goes through
// one runner with a literal argv and no shell, so tests replace the runner and
// see every call. Parsers are pure functions over command output.

/** Runs a command and resolves with its exit code and output; never rejects on a non-zero exit. */
export const realRunner = {
  run(file, args) {
    return new Promise((resolve) => {
      execFile(file, args, { encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 127) : 0;
        resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr || error?.message || "") });
      });
    });
  },
  /**
   * Starts a program that may outlive the call, such as a browser, detached.
   * It resolves with the exit code if the program ends within LAUNCH_WAIT_MS,
   * and with 0 if it is still running then; a program that cannot start is 127.
   */
  launch(file, args) {
    return new Promise((resolve) => {
      const child = spawn(file, args, { detached: true, stdio: "ignore" });
      const timer = setTimeout(() => {
        child.unref();
        resolve({ code: 0, stdout: "", stderr: "" });
      }, LAUNCH_WAIT_MS);
      timer.unref();
      child.once("error", (error) => {
        clearTimeout(timer);
        resolve({ code: 127, stdout: "", stderr: error.message });
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        resolve({ code: code ?? 128, stdout: "", stderr: signal ? `killed by ${signal}` : "" });
      });
    });
  },
};

const LAUNCH_WAIT_MS = 5000;

export const UNIT_NAME = "moshpit.service";
export const LEGACY_UNIT_NAME = "moshpit-bridge.service";

/**
 * Every command setup issues, by name. `mutating` marks the ones that change
 * the host; status and preflight use only the others.
 */
export const COMMANDS = {
  tailscaleStatus: { mutating: false, argv: () => ["tailscale", ["status", "--json"]] },
  tailscalePrefs: { mutating: false, argv: () => ["tailscale", ["debug", "prefs"]] },
  serveStatus: { mutating: false, argv: () => ["tailscale", ["serve", "status", "--json"]] },
  serveAdd: { mutating: true, argv: (port, target) => ["tailscale", ["serve", "--bg", "--https", String(port), target]] },
  userManager: { mutating: false, argv: () => ["systemctl", ["--user", "is-system-running"]] },
  unitShow: {
    mutating: false,
    argv: (unit) => ["systemctl", ["--user", "show", unit, "--property=LoadState,NeedDaemonReload,UnitFileState,ActiveState"]],
  },
  daemonReload: { mutating: true, argv: () => ["systemctl", ["--user", "daemon-reload"]] },
  enableNow: { mutating: true, argv: (unit) => ["systemctl", ["--user", "enable", "--now", unit]] },
  lingerShow: { mutating: false, argv: (user) => ["loginctl", ["show-user", user, "--property=Linger", "--value"]] },
  lingerEnable: { mutating: true, argv: (user) => ["loginctl", ["enable-linger", user]] },
  herdrVersion: { mutating: false, argv: (bin) => [bin, ["--version"]] },
  // Opens the setup link locally; `launch` does not wait for the browser.
  browserOpen: { mutating: false, launch: true, argv: (target) => ["xdg-open", [target]] },
  // Which browser xdg-open would start, to tell a snap-confined one apart.
  defaultBrowser: { mutating: false, argv: () => ["xdg-settings", ["get", "default-web-browser"]] },
  // Update, rollback and uninstall.
  releaseInfo: { mutating: false, argv: (bin) => [bin, ["version", "--json"]] },
  unitFragment: { mutating: false, argv: (unit) => ["systemctl", ["--user", "show", unit, "--property=FragmentPath", "--value"]] },
  unitMain: { mutating: false, argv: (unit) => ["systemctl", ["--user", "show", unit, "--property=ActiveState,MainPID"]] },
  restart: { mutating: true, argv: (unit) => ["systemctl", ["--user", "restart", unit]] },
  disableNow: { mutating: true, argv: (unit) => ["systemctl", ["--user", "disable", "--now", unit]] },
  serveOff: { mutating: true, argv: (port) => ["tailscale", ["serve", "--https", String(port), "off"]] },
  lingerDisable: { mutating: true, argv: (user) => ["loginctl", ["disable-linger", user]] },
};

/** Runs a named command from the table. */
export function runCommand(runner, name, ...args) {
  const command = COMMANDS[name];
  const [file, argv] = command.argv(...args);
  return command.launch ? runner.launch(file, argv) : runner.run(file, argv);
}

const stripDot = (name) => name.replace(/\.$/, "");

/** `tailscale status --json`: whether it runs, this node's name, and who owns it. */
export function parseTailscaleStatus(json) {
  const status = JSON.parse(json);
  const self = status.Self ?? {};
  const user = status.User?.[String(self.UserID)];
  return {
    running: status.BackendState === "Running",
    dnsName: typeof self.DNSName === "string" && self.DNSName ? stripDot(self.DNSName) : null,
    owner: typeof user?.LoginName === "string" && user.LoginName ? user.LoginName : null,
    tagged: Array.isArray(self.Tags) && self.Tags.length > 0,
  };
}

/**
 * `tailscale debug prefs`: the Tailscale operator, "" when none is set. Only
 * `OperatorUser` is read, because this debug output has no stability promise;
 * anything else throws.
 */
export function parseOperatorUser(json) {
  const operator = JSON.parse(json)?.OperatorUser;
  if (typeof operator !== "string") throw new Error("no OperatorUser string");
  return operator;
}

/**
 * `tailscale serve status --json`: each occupied port and where it points.
 * A port that is not a plain proxy (a file, text or TCP forward) still counts
 * as taken, with a description instead of a proxy URL.
 */
export function parseServeStatus(json) {
  const status = JSON.parse(json || "{}") ?? {};
  const routes = new Map();
  for (const [port, spec] of Object.entries(status.TCP ?? {})) {
    const handler = Object.entries(status.Web ?? {}).find(([hostPort]) => hostPort.endsWith(`:${port}`))?.[1]?.Handlers?.["/"];
    const target =
      typeof handler?.Proxy === "string" ? handler.Proxy
      : spec?.TCPForward ? `tcp forward to ${spec.TCPForward}`
      : "another Serve handler";
    routes.set(Number(port), target);
  }
  return routes;
}

/** `systemctl show` KEY=VALUE lines. */
export function parseProperties(text) {
  return Object.fromEntries(
    text
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).trim()]),
  );
}

// `is-system-running` exits non-zero for degraded, which is still a usable manager.
const REACHABLE_MANAGER = new Set(["running", "degraded", "starting", "initializing"]);
export const managerReachable = (stdout) => REACHABLE_MANAGER.has(stdout.trim());

/**
 * Where setup keeps each host resource, from XDG with the usual HOME
 * fallbacks. An absolute MOSHPIT_CONFIG names the config, because that is the
 * file the bridge reads; the container image sets it.
 */
export function hostPaths(env) {
  const home = env.HOME;
  const absolute = (name) => Boolean(env[name] && path.isAbsolute(env[name]));
  const base = (name, fallback) => (absolute(name) ? env[name] : path.join(home, fallback));
  const config = base("XDG_CONFIG_HOME", ".config");
  const state = path.join(base("XDG_STATE_HOME", ".local/state"), "moshpit");
  const data = path.join(base("XDG_DATA_HOME", ".local/share"), "moshpit");
  return {
    config: absolute("MOSHPIT_CONFIG") ? env.MOSHPIT_CONFIG : path.join(config, "moshpit", "config.json"),
    state,
    journal: path.join(state, "setup.json"),
    updateJournal: path.join(state, "update.json"),
    lock: path.join(state, "setup.lock"),
    data,
    staging: path.join(data, ".staging"),
    releases: path.join(data, "releases"),
    release: (version) => path.join(data, "releases", version, "moshpit"),
    current: path.join(data, "current"),
    currentExecutable: path.join(data, "current", "moshpit"),
    unit: path.join(config, "systemd", "user", UNIT_NAME),
  };
}

/** The first executable called `name` on PATH, or null. */
export async function findExecutable(name, envPath = "") {
  for (const dir of envPath.split(":").filter((entry) => path.isAbsolute(entry))) {
    const candidate = path.join(dir, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here; keep looking.
    }
  }
  return null;
}

/**
 * Whether the bridge on 127.0.0.1:port answers /api/auth-info as it would
 * through Serve: the Host and Origin are the public origin's, which fetch
 * cannot send to a loopback address.
 */
export function loopbackAuthInfo(port, publicOrigin) {
  return new Promise((resolve) => {
    const req = request(
      { host: "127.0.0.1", port, path: "/api/auth-info", headers: { Host: new URL(publicOrigin).host, Origin: publicOrigin }, timeout: 3000 },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          try {
            resolve(res.statusCode === 200 && Number.isInteger(JSON.parse(body).protocol));
          } catch {
            resolve(false);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
    req.end();
  });
}

/** Whether 127.0.0.1:port can be bound right now. */
export function loopbackPortFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

export function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
