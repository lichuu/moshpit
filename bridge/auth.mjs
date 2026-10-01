import crypto from "node:crypto";

export const SESSION_MS = 12 * 60 * 60 * 1000;
export const LOGIN_WINDOW_MS = 60 * 1000;
export const LOGIN_LIMIT = 10;
export const MAX_LIVE_SESSIONS = 100;
export const MAX_PASSWORD_BYTES = 256;

const SESSION_ID_BYTES = 16;
const SESSION_ID = /^[A-Za-z0-9_-]{22}$/;
const SESSION_ID_LENGTH = 22;
const TOKEN_BYTES = 32;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const TOKEN_LENGTH = 43;
const KEY_BYTES = 32;
// scrypt's interactive parameters, about 20ms per attempt on this host. The
// derivation is synchronous because the router still calls login() as a plain
// value; the 10-per-minute throttle bounds how long that can hold the loop.
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 };

const tokenDigest = (token) => crypto.createHash("sha256").update(token, "utf8").digest();

function createVerifier(password) {
  if (typeof password !== "string" || password.length === 0) return null;
  const salt = crypto.randomBytes(16);
  const expected = crypto.scryptSync(password, salt, KEY_BYTES, SCRYPT);
  return (candidate) => crypto.timingSafeEqual(expected, crypto.scryptSync(candidate, salt, KEY_BYTES, SCRYPT));
}

export function createPasswordAuth(password, now = Date.now) {
  const verify = createVerifier(password);
  const sessions = new Map();
  let attempts = 0;
  let windowEnds = 0;

  const view = (session) => ({ id: session.id, expiresAt: session.expiresAt });

  function prune(time) {
    for (const [id, session] of sessions) {
      if (session.expiresAt <= time) sessions.delete(id);
    }
  }

  function forToken(token) {
    if (typeof token !== "string" || token.length !== TOKEN_LENGTH || !TOKEN.test(token)) return null;
    prune(now());
    const digest = tokenDigest(token);
    for (const session of sessions.values()) {
      if (crypto.timingSafeEqual(session.tokenHash, digest)) return session;
    }
    return null;
  }

  function forId(id) {
    if (typeof id !== "string" || id.length !== SESSION_ID_LENGTH || !SESSION_ID.test(id)) return null;
    prune(now());
    return sessions.get(id) ?? null;
  }

  return {
    /** The token is returned once. A denial names why without echoing the candidate. */
    login(candidate) {
      const time = now();
      if (time >= windowEnds) {
        attempts = 0;
        windowEnds = time + LOGIN_WINDOW_MS;
      }
      if (attempts >= LOGIN_LIMIT)
        return { status: 429, code: "rate_limited", retryAfter: Math.ceil((windowEnds - time) / 1000) };
      attempts++;
      if (!verify || typeof candidate !== "string" || Buffer.byteLength(candidate) > MAX_PASSWORD_BYTES)
        return { status: 401, code: "password_required" };
      if (!verify(candidate)) return { status: 401, code: "password_required" };
      prune(time);
      // A live session is never evicted to make room: the quota denies the new
      // login instead, and every session already issued stays valid.
      if (sessions.size >= MAX_LIVE_SESSIONS) return { status: 429, code: "quota_exceeded" };
      const token = crypto.randomBytes(TOKEN_BYTES).toString("base64url");
      const session = {
        id: crypto.randomBytes(SESSION_ID_BYTES).toString("base64url"),
        tokenHash: tokenDigest(token),
        expiresAt: time + SESSION_MS,
      };
      sessions.set(session.id, session);
      return { status: 200, token, session: view(session) };
    },

    sessionForToken(token) {
      const session = forToken(token);
      return session ? view(session) : null;
    },

    activeSession(id) {
      const session = forId(id);
      return session ? view(session) : null;
    },

    revokeSession(id) {
      const session = forId(id);
      if (!session) return null;
      sessions.delete(session.id);
      return view(session);
    },

    // Token-keyed compatibility for the router that has not migrated to session
    // views yet. Remove both with the cookie and URL-token paths.
    valid(token) {
      return forToken(token) !== null;
    },
    revoke(token) {
      const session = forToken(token);
      if (session) sessions.delete(session.id);
    },
  };
}
