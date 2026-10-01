import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { createPasswordAuth, MAX_LIVE_SESSIONS, MAX_PASSWORD_BYTES } from "./auth.mjs";
import { RequestError } from "./upload.mjs";

// One admission decision per browser request. The bridge trusts nothing the
// caller says about where it is: the inbound authority and the browser origin
// are compared against configuration, never derived from Host, Origin or a
// forwarding header.

const CORS_METHODS = "GET, POST, OPTIONS";
const CORS_HEADERS = "content-type, authorization, x-moshpit-device";
const REQUEST_HEADERS = new Set(["content-type", "authorization", "x-moshpit-device"]);
const PREFLIGHT_METHODS = new Set(["GET", "POST"]);
const DEV_ORIGIN_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const JSON_BODY = /^application\/json[ \t]*(?:;[ \t]*charset[ \t]*=[ \t]*"?[\w-]+"?[ \t]*)?$/i;
const AUTHORITY =
  /^(\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)(?::(\d{1,5}))?$/;

// Denial bodies reach the caller through the router's error handler, so they
// stay constant: never echo the header that was refused.
const DENY_HOST = "host not allowed";
const DENY_ORIGIN = "origin not allowed";
const DENY_PREFLIGHT = "preflight not allowed";
const DENY_METHOD = "method not allowed";
const DENY_TYPE = "unsupported media type";
const DENY_PATH = "not found";

/** `/api` and everything under it. Static content never answers these paths. */
export const isApiPath = (pathname) => pathname === "/api" || pathname.startsWith("/api/");

function normalizeOrigin(raw, dev, variable) {
  const value = String(raw).trim();
  const fail = (reason) => new Error(`${variable} ${JSON.stringify(value)} ${reason}`);
  if (!value) throw new Error(`${variable} has an empty member`);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw fail("is not a URL");
  }
  if (url.username || url.password) throw fail("must not carry credentials");
  if (url.search || url.hash) throw fail("must not carry a query or fragment");
  if (url.pathname !== "/") throw fail("must not carry a path");
  if (url.hostname.includes("*")) throw fail("must name one host, not a wildcard");
  if (url.protocol === "http:") {
    if (!dev) throw fail("must use https, or set MOSHPIT_DEV_INSECURE=1 for a loopback development origin");
    if (!DEV_ORIGIN_HOSTS.has(url.hostname))
      throw fail("may use http only on localhost, 127.0.0.1 or [::1]");
  } else if (url.protocol !== "https:") {
    throw fail("must use https");
  }
  return url.origin;
}

function normalizeAuthority(raw) {
  const value = String(raw).trim().toLowerCase();
  const fail = (reason) => new Error(`MOSHPIT_ALLOWED_AUTHORITIES ${JSON.stringify(value)} ${reason}`);
  if (!value) throw new Error("MOSHPIT_ALLOWED_AUTHORITIES has an empty member");
  const match = AUTHORITY.exec(value);
  if (!match)
    throw fail("must be a host with an optional port, for example workstation.example.ts.net or 127.0.0.1:8787");
  if (match[2] === undefined) return match[1];
  const port = Number(match[2]);
  if (port < 1 || port > 65535) throw fail("has a port outside 1-65535");
  return `${match[1]}:${port}`;
}

function readConfig(env) {
  const dev = env.MOSHPIT_DEV_INSECURE === "1";
  const publicOrigin = String(env.MOSHPIT_PUBLIC_ORIGIN ?? "").trim();
  if (!publicOrigin)
    throw new Error(
      "MOSHPIT_PUBLIC_ORIGIN is required: the exact origin browsers open, for example https://workstation.example.ts.net",
    );
  const origins = new Set([normalizeOrigin(publicOrigin, dev, "MOSHPIT_PUBLIC_ORIGIN")]);
  const extra = String(env.MOSHPIT_ALLOWED_ORIGINS ?? "").trim();
  if (extra) {
    for (const member of extra.split(",")) origins.add(normalizeOrigin(member, dev, "MOSHPIT_ALLOWED_ORIGINS"));
  }
  const declared = String(env.MOSHPIT_ALLOWED_AUTHORITIES ?? "").trim();
  if (!declared)
    throw new Error(
      "MOSHPIT_ALLOWED_AUTHORITIES is required: the inbound Host values this bridge answers, for example workstation.example.ts.net or 127.0.0.1:8787",
    );
  const authorities = new Set();
  for (const member of declared.split(",")) authorities.add(normalizeAuthority(member));
  // Outbound bridge destinations the app served here may connect to. Incoming
  // CORS origins and inbound authorities are a different list: a bridge this
  // app talks to is not a page allowed to talk to this bridge.
  const connect = new Set();
  const listed = String(env.MOSHPIT_CONNECT_ORIGINS ?? "").trim();
  if (listed) {
    for (const member of listed.split(",")) connect.add(normalizeOrigin(member, dev, "MOSHPIT_CONNECT_ORIGINS"));
  }
  return { origins, authorities, publicOrigin: normalizeOrigin(publicOrigin, dev, "MOSHPIT_PUBLIC_ORIGIN"), connect };
}

const socketOrigin = (origin) => origin.replace(/^http/, "ws");

/**
 * The CSP for the app this bridge serves. connect-src is this origin and the
 * configured bridges, each with its WebSocket twin; 'self' is repeated as an
 * explicit wss origin because older Safari does not extend 'self' to it.
 */
export function appPolicy({ publicOrigin, connect }) {
  const sources = ["'self'", socketOrigin(publicOrigin)];
  for (const origin of connect) sources.push(origin, socketOrigin(origin));
  return `default-src 'self'; connect-src ${[...new Set(sources)].join(" ")}; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'`;
}

/** Header multiplicity is a policy input, and Node merges repeats into one string. */
function rawValues(req, name) {
  const raw = req.rawHeaders;
  const found = [];
  for (let i = 0; i < raw.length; i += 2) {
    if (raw[i].toLowerCase() === name) found.push(raw[i + 1]);
  }
  return found;
}

export function createBrowserBoundary(env) {
  const { origins, authorities, publicOrigin, connect } = readConfig(env);
  // A wrong allowlist makes the app unreachable with no other symptom, so say
  // what was refused on the console once. The value never reaches a response.
  const reported = { MOSHPIT_ALLOWED_AUTHORITIES: new Set(), MOSHPIT_ALLOWED_ORIGINS: new Set() };
  function report(variable, value) {
    const shown = JSON.stringify(String(value ?? "").replace(/[^\x20-\x7e]/g, "?").slice(0, 120));
    const seen = reported[variable];
    if (seen.has(shown) || seen.size >= 32) return;
    seen.add(shown);
    console.error(`moshpit refused ${shown}; add it to ${variable} if this deployment is yours`);
  }

  function requireAuthority(req) {
    const values = rawValues(req, "host");
    if (values.length !== 1) throw new RequestError(403, DENY_HOST);
    const value = values[0].trim().toLowerCase();
    if (!authorities.has(value)) {
      report("MOSHPIT_ALLOWED_AUTHORITIES", value);
      throw new RequestError(403, DENY_HOST);
    }
  }

  /** Null means the browser sent no Origin at all, which some reads may still use. */
  function readOrigin(req) {
    const values = rawValues(req, "origin");
    if (values.length === 0) return null;
    if (values.length > 1) throw new RequestError(403, DENY_ORIGIN);
    const value = values[0].trim();
    if (!origins.has(value)) {
      report("MOSHPIT_ALLOWED_ORIGINS", value);
      throw new RequestError(403, DENY_ORIGIN);
    }
    return value;
  }

  function requireOrigin(req) {
    const origin = readOrigin(req);
    if (origin === null) throw new RequestError(403, DENY_ORIGIN);
    return origin;
  }

  function cors(origin) {
    return {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": CORS_METHODS,
      "access-control-allow-headers": CORS_HEADERS,
      vary: "origin",
    };
  }

  function preflight(req, pathname) {
    const origin = requireOrigin(req);
    const requested = rawValues(req, "access-control-request-method");
    if (requested.length !== 1 || !PREFLIGHT_METHODS.has(requested[0].trim().toUpperCase()))
      throw new RequestError(403, DENY_PREFLIGHT);
    for (const list of rawValues(req, "access-control-request-headers")) {
      for (const name of list.split(",")) {
        const header = name.trim().toLowerCase();
        if (header && !REQUEST_HEADERS.has(header)) throw new RequestError(403, DENY_PREFLIGHT);
      }
    }
    return { pathname, headers: cors(origin), preflight: true };
  }

  function api(req, pathname) {
    if (req.method === "OPTIONS") return preflight(req, pathname);
    if (req.method === "GET") {
      const origin = readOrigin(req);
      if (origin !== null) return { pathname, headers: cors(origin), preflight: false };
      // A same-origin read is the one case a browser omits Origin. Fetch
      // metadata has to say so; a cross-site read without Origin does not.
      const site = rawValues(req, "sec-fetch-site");
      if (site.length !== 1 || site[0].trim() !== "same-origin") throw new RequestError(403, DENY_ORIGIN);
      return { pathname, headers: { vary: "origin" }, preflight: false };
    }
    if (req.method === "HEAD") return { pathname, headers: cors(requireOrigin(req)), preflight: false };
    if (req.method === "POST") {
      const origin = requireOrigin(req);
      const type = rawValues(req, "content-type");
      if (type.length !== 1 || !JSON_BODY.test(type[0].trim())) throw new RequestError(415, DENY_TYPE);
      return { pathname, headers: cors(origin), preflight: false };
    }
    throw new RequestError(405, DENY_METHOD);
  }

  return {
    /** The public list of bridges this app may connect to, for discovery. */
    connectOrigins: [...connect],
    contentSecurityPolicy: appPolicy({ publicOrigin, connect }),
    check(req, transport) {
      requireAuthority(req);
      const { pathname } = new URL(req.url ?? "/", "http://127.0.0.1");
      if (transport === "websocket") {
        if (pathname !== "/pty") throw new RequestError(404, DENY_PATH);
        if (req.method !== "GET") throw new RequestError(405, DENY_METHOD);
        requireOrigin(req);
        return { pathname, headers: {}, preflight: false };
      }
      if (isApiPath(pathname)) return api(req, pathname);
      if (req.method !== "GET" && req.method !== "HEAD") throw new RequestError(405, DENY_METHOD);
      return { pathname, headers: {}, preflight: false };
    },
  };
}

const PROTOCOL = 2;
const AUTH_MODES = new Set(["tailscale", "password", "tailscale+password"]);
const MAX_LOGIN = 256;
const MAX_AUTHORIZATION = 128;
const BEARER = /^bearer ([A-Za-z0-9_-]{43})$/i;
/** Password mode authenticates the host operator, who has no per-user login. */
export const PASSWORD_OWNER = "password";
export const MAX_PASSWORD_FILE_BYTES = 1024;

/** Structured denial, shaped for an `{ error: { code, message } }` envelope. */
export class IdentityError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "IdentityError";
    this.status = status;
    this.code = code;
  }
}

const identityRequired = () =>
  new IdentityError(401, "identity_required", "This bridge did not receive the identity it requires.");
const passwordRequired = () =>
  new IdentityError(401, "password_required", "Log in with the host password to continue.");

const declared = (env, name) => Object.hasOwn(env, name);

export const PASSWORD_RETIRED =
  "MOSHPIT_PASSWORD is no longer read: remove it and set MOSHPIT_PASSWORD_FILE for a password mode";

/** Validates the identity settings. Never opens the password file. */
export function readIdentityConfig(env) {
  const mode = env.MOSHPIT_AUTH_MODE;
  if (mode === undefined)
    throw new Error("MOSHPIT_AUTH_MODE is required: set it to tailscale, password or tailscale+password");
  if (!AUTH_MODES.has(mode))
    throw new Error(
      `MOSHPIT_AUTH_MODE ${JSON.stringify(String(mode))} must be exactly tailscale, password or tailscale+password`,
    );
  if (declared(env, "MOSHPIT_PASSWORD")) throw new Error(PASSWORD_RETIRED);
  const wantsTailscale = mode === "tailscale" || mode === "tailscale+password";
  const wantsPassword = mode === "password" || mode === "tailscale+password";

  let login = null;
  if (wantsTailscale) {
    const value = String(env.MOSHPIT_TRUSTED_USER ?? "").trim();
    if (!value)
      throw new Error(`MOSHPIT_TRUSTED_USER is required in ${mode} mode: the exact Serve login this bridge answers`);
    if (value.length > MAX_LOGIN || /\p{Cc}/u.test(value))
      throw new Error(`MOSHPIT_TRUSTED_USER must be one printable login of at most ${MAX_LOGIN} characters`);
    login = value;
  } else if (declared(env, "MOSHPIT_TRUSTED_USER")) {
    throw new Error(
      "MOSHPIT_TRUSTED_USER has no meaning in password mode: remove it, or set MOSHPIT_AUTH_MODE=tailscale+password to check it",
    );
  }

  let passwordFile = null;
  if (wantsPassword) {
    const value = String(env.MOSHPIT_PASSWORD_FILE ?? "").trim();
    if (!value)
      throw new Error(
        `MOSHPIT_PASSWORD_FILE is required in ${mode} mode: a file only this user can read, holding the password`,
      );
    passwordFile = path.resolve(value);
  } else if (declared(env, "MOSHPIT_PASSWORD_FILE")) {
    throw new Error(
      "MOSHPIT_PASSWORD_FILE has no meaning in tailscale mode: remove it, or set MOSHPIT_AUTH_MODE=tailscale+password to use it",
    );
  }
  return { mode, login, passwordFile, wantsTailscale, wantsPassword };
}

function decodePassword(bytes, fail) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw fail("is not valid UTF-8");
  }
  // Editors and `printf` end the line; nothing else is removed, so a password
  // may begin or end with a space.
  const password = text.endsWith("\r\n") ? text.slice(0, -2) : text.endsWith("\n") ? text.slice(0, -1) : text;
  if (!password) throw fail("holds no password");
  if (/[\r\n\0]/.test(password)) throw fail("must hold one line: it contains a line break or a NUL byte");
  if (Buffer.byteLength(password) > MAX_PASSWORD_BYTES)
    throw fail(`holds more than ${MAX_PASSWORD_BYTES} bytes of password`);
  return password;
}

/** Read once at startup. A refusal never changes the file and never quotes its bytes. */
async function readPasswordFile(file) {
  const fail = (reason) => new Error(`MOSHPIT_PASSWORD_FILE ${JSON.stringify(file)} ${reason}`);
  let handle;
  try {
    // O_NOFOLLOW refuses a planted symlink and O_NONBLOCK keeps a FIFO from
    // stalling startup. What the descriptor actually is comes next.
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error.code === "ENOENT") throw fail("does not exist");
    if (error.code === "ELOOP") throw fail("is a symbolic link");
    if (error.code === "ENXIO") throw fail("is not a regular file");
    if (error.code === "EACCES") throw fail("cannot be read by this user");
    throw fail(`could not be read: ${error.code ?? "unknown error"}`);
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw fail("is not a regular file");
    const uid = process.getuid?.();
    if (uid !== undefined && info.uid !== uid) throw fail("belongs to another user");
    if ((info.mode & 0o077) !== 0) throw fail("is readable beyond its owner: chmod 600 it");
    if (info.size === 0) throw fail("is empty");
    if (info.size > MAX_PASSWORD_FILE_BYTES) throw fail(`is larger than ${MAX_PASSWORD_FILE_BYTES} bytes`);
    return decodePassword(await handle.readFile(), fail);
  } finally {
    await handle.close();
  }
}

export async function createIdentitySecurity({ env, now = Date.now } = {}) {
  if (!env || typeof env !== "object") throw new TypeError("createIdentitySecurity needs an env object");
  const config = readIdentityConfig(env);
  const engine = config.passwordFile ? createPasswordAuth(await readPasswordFile(config.passwordFile), now) : null;
  const owner = config.login ?? PASSWORD_OWNER;
  const policy = Object.freeze(
    config.login === null ? { kind: config.mode } : { kind: config.mode, login: config.login },
  );
  const factors = [...(config.wantsTailscale ? ["tailscale"] : []), ...(config.wantsPassword ? ["password"] : [])];

  const identityOf = (session) => ({
    owner,
    authSessionId: session?.id ?? null,
    authExpiresAt: session?.expiresAt ?? null,
  });

  /** Serve supplies this header and strips any the caller sent; one value, exactly equal. */
  function requireServeLogin(req) {
    const values = rawValues(req, "tailscale-user-login");
    if (values.length !== 1 || values[0].trim() !== policy.login) throw identityRequired();
  }

  /** The only password proof: one Authorization Bearer header. Never a cookie or a URL. */
  function requireBearerSession(req) {
    const values = rawValues(req, "authorization");
    if (values.length !== 1) throw passwordRequired();
    const value = values[0].trim();
    if (value.length > MAX_AUTHORIZATION) throw passwordRequired();
    const parsed = BEARER.exec(value);
    if (!parsed) throw passwordRequired();
    const session = engine.sessionForToken(parsed[1]);
    if (!session) throw passwordRequired();
    return session;
  }

  return {
    /** Server-only. Neither reaches a response body. */
    policy,
    owner,

    /** Discovery: what to prove, never who or where. */
    authInfo() {
      return { protocol: PROTOCOL, requiredFactors: [...factors] };
    },

    /**
     * The caller's own Serve login, which Serve sets and strips from what the
     * caller sent, so a setup page can name the account it is signed in as.
     * It echoes only this request's header, never the owner or another user;
     * null without Tailscale identity or without exactly one usable value.
     */
    requesterLogin(req) {
      if (!config.wantsTailscale) return null;
      const values = rawValues(req, "tailscale-user-login");
      const login = values.length === 1 ? values[0].trim() : "";
      return login && login.length <= MAX_LOGIN && !/\p{Cc}/u.test(login) ? login : null;
    },

    /** Returns the bearer token once, with the identity that owns it. */
    async login(req, password) {
      if (!engine) throw new IdentityError(404, "login_unsupported", "This bridge does not use password login.");
      // Identity gates the attempt: a caller the policy does not accept can
      // neither verify a password nor spend the shared attempt budget.
      if (config.wantsTailscale) requireServeLogin(req);
      const result = engine.login(password);
      if (result.status === 200) return { token: result.token, ...identityOf(result.session) };
      if (result.code === "rate_limited") {
        const error = new IdentityError(429, "rate_limited", "Too many login attempts. Try again shortly.");
        error.retryAfter = result.retryAfter;
        throw error;
      }
      if (result.code === "quota_exceeded")
        throw new IdentityError(
          429,
          "quota_exceeded",
          `This bridge is holding ${MAX_LIVE_SESSIONS} password sessions. Log out elsewhere or wait for one to expire.`,
        );
      throw passwordRequired();
    },

    async requireIdentity(req) {
      if (config.wantsTailscale) requireServeLogin(req);
      if (!engine) return identityOf(null);
      return identityOf(requireBearerSession(req));
    },

    /**
     * Recheck for a caller that already proved identity once, such as a
     * terminal ticket on an upgrade: the referenced session must still be
     * live, and a WebSocket cannot send the bearer header again. This
     * authorizes no device and no target.
     */
    async requireActiveTicketOwner(req, ticket) {
      if (config.wantsTailscale) requireServeLogin(req);
      if (!ticket || ticket.owner !== owner) throw identityRequired();
      if (!engine) return identityOf(null);
      const session = engine.activeSession(ticket.authSessionId);
      if (!session) throw passwordRequired();
      return identityOf(session);
    },

    /** The invalidated identity, for the tickets and sockets that referenced it. Revokes no device. */
    async logout(req) {
      if (!engine)
        throw new IdentityError(404, "logout_unsupported", "This bridge has no password session to log out of.");
      if (config.wantsTailscale) requireServeLogin(req);
      const session = requireBearerSession(req);
      engine.revokeSession(session.id);
      return { owner, authSessionId: session.id };
    },
  };
}
