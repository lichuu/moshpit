import { randomUUID } from "node:crypto";
import { realpathSync, rmSync } from "node:fs";
import { constants as osConstants } from "node:os";
import path from "node:path";
import QRCode from "qrcode";
import { PAIRING_GRANT_MS } from "./devices.mjs";
import { findExecutable, runCommand } from "./host-probe.mjs";
import { writePrivateFile } from "./private-files.mjs";

// The setup link: an admin pairing grant carried to a browser in a URL
// fragment, which never reaches a server, a Referer or an access log. It is
// printed only to the invoking terminal and never journaled.

export const LINK_KEY = "moshpit-setup";
export const GRANT_NAME = "First browser";
export const POLL_MS = 2000;
export const EXIT_INTERRUPTED = 130;
const AWAITING = "installed, awaiting first device";

export const setupLinkFor = (origin, secret) => `${origin}/#${LINK_KEY}=${secret}`;

const TERMINATION_SIGNALS = ["SIGTERM", "SIGHUP", "SIGINT"];
const SSH_VARIABLES = ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"];

/** A local browser can open the link: there is a display, and this is not an SSH session. */
export const canLaunchBrowser = (env) => Boolean(env.DISPLAY || env.WAYLAND_DISPLAY) && !SSH_VARIABLES.some((name) => env[name]);

export const LAUNCH_FAILED = "Could not open a browser on this machine. Open the link above, or scan the QR code.";

export const SNAP_BROWSER =
  "Your browser looks snap-confined, and cannot read the private page setup would open for it. Open the link above, or scan the QR code.";

// A snap desktop entry is named <snap>_<app>.desktop; flatpak and distro
// packages never use an underscore there.
const SNAP_DESKTOP_ENTRY = /^[a-z0-9][a-z0-9-]*_[a-z0-9-]+\.desktop$/;
const isSnapPath = (file) => typeof file === "string" && (file.startsWith("/snap/") || file.startsWith("/var/lib/snapd/"));

/**
 * Whether the browser xdg-open would start is confined by snap. A confined
 * browser cannot read the 0600 page in the private runtime directory, so it
 * would open nothing. Any one hint is enough: setup itself runs inside a snap
 * (SNAP, SNAP_NAME), $BROWSER or xdg-open resolves under /snap/, or the default
 * browser's desktop entry is a snap's. A probe that fails is no hint.
 */
export async function snapConfinedBrowser(ctx) {
  const { env } = ctx;
  if (env.SNAP || env.SNAP_NAME) return true;
  if (isSnapPath(env.BROWSER?.split(":")[0]?.trim().split(/\s/)[0])) return true;
  try {
    const opener = await (ctx.which ?? findExecutable)("xdg-open", env.PATH ?? "");
    if (opener && (isSnapPath(opener) || isSnapPath(realpathSync(opener)))) return true;
  } catch {
    // An opener that cannot be resolved is no hint.
  }
  try {
    const result = await runCommand(ctx.runner, "defaultBrowser");
    return result.code === 0 && SNAP_DESKTOP_ENTRY.test(result.stdout.trim());
  } catch {
    return false;
  }
}

/**
 * Opens the link in this user's browser. The link never goes on a command
 * line: /proc/<pid>/cmdline is readable by every local user unless /proc is
 * mounted with hidepid, and the capability would let such a user enroll
 * through the loopback bridge. xdg-open gets the path of a 0600 page, in the
 * private runtime directory when there is one, that redirects to the link.
 * The page is removed when the wait ends, and on SIGTERM or SIGHUP (a closed
 * terminal), which end the process with the conventional 128+signal status.
 * Ctrl-C does the same while the browser launches; once the wait starts it
 * ends the wait through `ctx.onInterrupt` instead. A page that cannot be
 * removed never turns a signal into a crash. Returns whether the launch
 * worked and how to remove the page, which also drops every handler.
 */
async function openLocally(ctx, link) {
  const dir = ctx.env.XDG_RUNTIME_DIR && path.isAbsolute(ctx.env.XDG_RUNTIME_DIR) ? ctx.env.XDG_RUNTIME_DIR : ctx.paths.state;
  const page = path.join(dir, `moshpit-setup-${randomUUID()}.html`);
  const discard = () => {
    try {
      rmSync(page, { force: true });
    } catch {
      // The page is 0600 in a private directory; the signal must still end the process.
    }
  };
  const handlers = TERMINATION_SIGNALS.map((signal) => [
    signal,
    () => {
      discard();
      process.exit(128 + osConstants.signals[signal]);
    },
  ]);
  for (const [signal, handler] of handlers) process.once(signal, handler);
  const drop = (only) => {
    for (const [signal, handler] of handlers) if (!only || signal === only) process.off(signal, handler);
  };
  const remove = () => {
    drop();
    discard();
  };
  const target = JSON.stringify(link).replace(/</g, "\\u003c");
  try {
    await writePrivateFile(
      page,
      `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>moshpit setup</title><script>location.replace(${target})</script>\n`,
    );
    const result = await runCommand(ctx.runner, "browserOpen", page);
    drop("SIGINT");
    return { opened: result.code === 0, remove };
  } catch {
    remove();
    return { opened: false, remove };
  }
}

/**
 * How setup offers a link after a run: `none`, `withheld` (no terminal to
 * print it to), `emit` (print it and return) or `wait` (print it with a QR and
 * wait for the browser). A host with devices gets one only with --recover.
 */
export function linkMode(ctx, { result, exitCode }) {
  if (exitCode !== 0) return "none";
  if (result.state !== AWAITING && !(result.state === "complete" && ctx.options.recover)) return "none";
  if (ctx.options.emitLink) return "emit";
  return ctx.stdoutIsTTY ? "wait" : "withheld";
}

const activeIds = (devices) => new Set(devices.filter((device) => device.active && device.revokedAt === null).map((device) => device.id));

const clock = (ms) => `${new Date(ms).toISOString().slice(11, 16)} UTC`;

function countdown(ms) {
  const seconds = Math.ceil(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

// What the operator is told when a browser used the link and was refused. The
// bridge records only the code and the time, so nothing here can name the
// secret or the account that tried.
export const REFUSAL_NOTES = {
  pairing_grant_wrong_owner: "A browser signed in to a different Tailscale account tried the link and was refused.",
  pairing_grant_used: "A browser tried the link after it had already been used.",
  pairing_grant_expired: "A browser tried the link after it expired.",
  pairing_rate_limited: "A browser tried the link too often in a minute and ran out of its request budget.",
};
export const UNREACHABLE_NOTE = "The bridge stopped answering while setup waited, so a browser's result may not have been seen.";

/** The distinct notes for the refusals since the grant was issued, in the order they first happened. */
export function refusalNotes(refusals, since) {
  const codes = refusals.filter((entry) => entry.at >= since && Object.hasOwn(REFUSAL_NOTES, entry.code)).map((entry) => entry.code);
  return [...new Set(codes)].map((code) => REFUSAL_NOTES[code]);
}

/**
 * Polls the admin socket until a device that was not there before appears, the
 * grant expires, or Ctrl-C. Along the way it keeps the bridge's refusals of
 * this grant and whether the last poll got an answer, so a wait that ends
 * without a device can say why.
 */
async function waitForDevice(ctx, known, expiresAt, status) {
  const controller = new AbortController();
  const release = ctx.onInterrupt(() => controller.abort());
  const since = expiresAt - PAIRING_GRANT_MS;
  const seen = { refusals: [], unreachable: false };
  const notes = () => [...refusalNotes(seen.refusals, since), ...(seen.unreachable ? [UNREACHABLE_NOTE] : [])];
  try {
    for (;;) {
      const left = expiresAt - ctx.now();
      if (left <= 0) return { outcome: "expired", notes: notes() };
      status.write(`\rWaiting for the browser: ${countdown(left)} left. Ctrl-C stops waiting. `);
      await ctx.sleep(Math.min(POLL_MS, left), controller.signal);
      if (controller.signal.aborted) return { outcome: "interrupted", notes: notes() };
      const listed = await ctx.admin({ action: "devices" }, ctx.plan.stateDir);
      // A bridge restarting mid-wait answers with an error; the next poll retries.
      seen.unreachable = Boolean(listed.error);
      const fresh = listed.result?.find((device) => device.active && device.revokedAt === null && !known.has(device.id));
      if (fresh) return { outcome: "approved", device: fresh };
      const refused = listed.error ? null : await ctx.admin({ action: "refusals" }, ctx.plan.stateDir);
      if (refused?.result) seen.refusals = refused.result;
    }
  } finally {
    release();
    status.write("\n");
  }
}

const row = (detail, status) => ({ id: "setup-link", status, detail });

/**
 * Issues and presents the link for a mode other than `none`, returning the
 * outcome with a setup-link row. `show` receives the link text; `status` the
 * countdown. `result.setupLink` is set only for `emit` and `wait`, so --json
 * carries the link only when the operator asked for it or is at a terminal.
 */
export async function offerSetupLink(ctx, outcome, mode, { show, status }) {
  const result = { ...outcome.result, steps: [...outcome.result.steps] };
  const finish = (entry, exitCode, next) => {
    result.steps.push(entry);
    if (next) result.next = next;
    else delete result.next;
    result.ok = exitCode === 0;
    return { result, exitCode };
  };
  const again = "Run moshpit setup again for a fresh link.";
  if (mode === "withheld")
    return finish(
      row("Not printed: standard output is not a terminal, and a setup link must stay out of logs.", "skipped"),
      outcome.exitCode,
      "Run moshpit setup on a terminal for a setup link, or add --emit-link to print one here.",
    );

  const before = await ctx.admin({ action: "devices" }, ctx.plan.stateDir);
  const issued = before.error ? before : await ctx.admin({ action: "pair", name: GRANT_NAME }, ctx.plan.stateDir);
  if (issued.error) return finish(row(`The bridge did not issue a setup link: ${issued.error.message}`, "failed"), 1, again);
  const known = activeIds(before.result);
  const { secret, expiresAt } = issued.result;
  const link = setupLinkFor(ctx.plan.publicOrigin, secret);
  result.setupLink = link;
  const owner = ctx.plan.tailscale?.owner ?? "the owner";
  const detail = `Printed a single-use setup link for ${owner}, valid until ${clock(expiresAt)}`;

  if (mode === "emit") {
    show.write(`link: ${link}\n`);
    return finish(row(detail, "done"), outcome.exitCode, "Open the link on the device within five minutes. moshpit status says complete once it is approved.");
  }

  const qr = await QRCode.toString(link, { type: "terminal", small: true });
  show.write(
    [
      "",
      `Open this link on a phone or computer signed in to Tailscale as ${owner}.`,
      `It approves that browser, works once, and expires at ${clock(expiresAt)}:`,
      "",
      `  ${link}`,
      "",
      qr,
      "",
    ].join("\n"),
  );
  // Never with --emit-link, without a terminal or over SSH: only this mode
  // reaches here, and canLaunchBrowser rules out SSH and a missing display.
  // A snap-confined browser cannot read the private page, and moving the page
  // somewhere it can read would drop the guarantee that only this user can, so
  // the link stays on the terminal.
  const launchable = canLaunchBrowser(ctx.env);
  const confined = launchable && (await snapConfinedBrowser(ctx));
  if (confined) show.write(`${SNAP_BROWSER}\n`);
  const local = launchable && !confined ? await openLocally(ctx, link) : null;
  if (local && !local.opened) show.write(`${LAUNCH_FAILED}\n`);
  let waited;
  try {
    waited = await waitForDevice(ctx, known, expiresAt, status);
  } finally {
    local?.remove();
  }
  if (waited.outcome === "approved") {
    result.state = "complete";
    return finish(row(`${JSON.stringify(waited.device.name)} is approved`, "done"), 0);
  }
  const because = waited.notes.length ? ` ${waited.notes.join(" ")}` : "";
  if (waited.outcome === "expired")
    return finish(row(`The setup link expired before a browser used it.${because}`, "pending"), outcome.exitCode, again);
  return finish(row(`Stopped waiting. Setup is resumable; the link stays valid until it expires.${because}`, "pending"), EXIT_INTERRUPTED, again);
}
