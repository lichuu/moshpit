import assert from "node:assert/strict";
import test from "node:test";
import {
  createPasswordAuth,
  LOGIN_LIMIT,
  LOGIN_WINDOW_MS,
  MAX_LIVE_SESSIONS,
  MAX_PASSWORD_BYTES,
  SESSION_MS,
} from "./auth.mjs";

const PASSWORD = "correct horse battery staple";
const START = 1_800_000_000_000;

function clock(start = START) {
  const time = { value: start };
  return { now: () => time.value, advance: (ms) => (time.value += ms), set: (ms) => (time.value = ms) };
}

function setup(password = PASSWORD) {
  const time = clock();
  return { time, auth: createPasswordAuth(password, time.now) };
}

/** One accepted login, and the clock moved past the attempt window it used. */
function open(auth, time) {
  const result = auth.login(PASSWORD);
  assert.equal(result.status, 200);
  time.advance(LOGIN_WINDOW_MS);
  return result;
}

test("a correct password opens one absolute session and returns its token once", () => {
  const { auth, time } = setup();
  const result = auth.login(PASSWORD);

  assert.deepEqual(Object.keys(result).sort(), ["session", "status", "token"]);
  assert.equal(result.status, 200);
  assert.match(result.token, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(Object.keys(result.session).sort(), ["expiresAt", "id"]);
  assert.match(result.session.id, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(result.session.expiresAt, START + SESSION_MS);
  assert.equal(SESSION_MS, 12 * 60 * 60 * 1000);

  assert.deepEqual(auth.sessionForToken(result.token), result.session);
  assert.deepEqual(auth.activeSession(result.session.id), result.session);
  assert.equal(auth.valid(result.token), true);

  const second = open(auth, time);
  assert.notEqual(second.token, result.token);
  assert.notEqual(second.session.id, result.session.id);
});

test("a wrong, unbounded or non-string candidate opens nothing", () => {
  const { auth } = setup();
  for (const candidate of [
    undefined,
    null,
    12345,
    "",
    "correct horse battery stapl",
    "correct horse battery staple ",
    PASSWORD.toUpperCase(),
    { toString: () => PASSWORD },
  ]) {
    const result = auth.login(candidate);
    assert.deepEqual(result, { status: 401, code: "password_required" });
  }
  assert.equal(auth.sessionForToken("A".repeat(43)), null);
});

test("a candidate longer than the bound is refused before verification", () => {
  const long = "p".repeat(MAX_PASSWORD_BYTES + 1);
  const { auth } = setup(long);
  assert.deepEqual(auth.login(long), { status: 401, code: "password_required" });
  assert.deepEqual(auth.login("p".repeat(MAX_PASSWORD_BYTES)), { status: 401, code: "password_required" });

  const bounded = setup("p".repeat(MAX_PASSWORD_BYTES));
  assert.equal(bounded.auth.login("p".repeat(MAX_PASSWORD_BYTES)).status, 200);
});

test("an engine configured with no password never authorizes", () => {
  for (const password of ["", undefined, null]) {
    const auth = createPasswordAuth(password, clock().now);
    for (const candidate of ["", undefined, "anything"])
      assert.deepEqual(auth.login(candidate), { status: 401, code: "password_required" });
    assert.equal(auth.valid(""), false);
  }
});

test("the attempt budget is global, counted before verification, and reset by its window", () => {
  const { auth, time } = setup();
  for (let attempt = 0; attempt < LOGIN_LIMIT; attempt++)
    assert.deepEqual(auth.login("wrong"), { status: 401, code: "password_required" });

  const limited = auth.login(PASSWORD);
  assert.equal(limited.status, 429);
  assert.equal(limited.code, "rate_limited");
  assert.equal(limited.retryAfter, LOGIN_WINDOW_MS / 1000);
  assert.equal(limited.token, undefined);
  assert.equal(limited.session, undefined);

  time.advance(LOGIN_WINDOW_MS - 1);
  assert.equal(auth.login(PASSWORD).status, 429);
  time.advance(1);
  assert.equal(auth.login(PASSWORD).status, 200);

  // The count comes before verification, so an accepted login spends the
  // budget as well, and so does a candidate refused for its size or type.
  for (let attempt = 1; attempt < LOGIN_LIMIT; attempt++) assert.equal(auth.login(PASSWORD).status, 200);
  assert.equal(auth.login(PASSWORD).code, "rate_limited");

  time.advance(LOGIN_WINDOW_MS);
  for (let attempt = 0; attempt < LOGIN_LIMIT; attempt++) {
    const candidate = attempt % 2 ? undefined : "x".repeat(MAX_PASSWORD_BYTES + 1);
    assert.equal(auth.login(candidate).code, "password_required");
  }
  assert.equal(auth.login(PASSWORD).code, "rate_limited");
});

test("the live-session quota denies a new login and keeps every issued session valid", () => {
  const { auth, time } = setup();
  const issued = [];
  while (issued.length < MAX_LIVE_SESSIONS) {
    const result = auth.login(PASSWORD);
    assert.equal(result.status, 200);
    issued.push(result);
    if (issued.length % LOGIN_LIMIT === 0) time.advance(LOGIN_WINDOW_MS);
  }

  const denied = auth.login(PASSWORD);
  assert.deepEqual(denied, { status: 429, code: "quota_exceeded" });
  for (const result of issued) assert.equal(auth.valid(result.token), true);

  // Expiry, not eviction, reclaims capacity: the oldest session has to reach
  // its absolute end before another login fits.
  time.set(issued[0].session.expiresAt);
  assert.equal(auth.valid(issued[0].token), false);
  assert.equal(auth.valid(issued.at(-1).token), true);
  const reclaimed = auth.login(PASSWORD);
  assert.equal(reclaimed.status, 200);
});

test("a session ends at its absolute expiry and using it never renews it", () => {
  const { auth, time } = setup();
  const { token, session } = open(auth, time);

  time.set(session.expiresAt - 1);
  assert.equal(auth.valid(token), true);
  assert.deepEqual(auth.sessionForToken(token), session);
  assert.deepEqual(auth.activeSession(session.id), session);

  time.set(session.expiresAt);
  assert.equal(auth.valid(token), false);
  assert.equal(auth.sessionForToken(token), null);
  assert.equal(auth.activeSession(session.id), null);
  assert.equal(auth.revokeSession(session.id), null);
});

test("a session id is a reference for recheck, never a bearer credential", () => {
  const { auth, time } = setup();
  const { token, session } = open(auth, time);

  assert.deepEqual(auth.activeSession(session.id), session);
  assert.equal(auth.sessionForToken(session.id), null);
  assert.equal(auth.valid(session.id), false);
  for (const id of [undefined, null, "", session.id.slice(0, -1), `${session.id}a`, "A".repeat(22), token])
    assert.equal(auth.activeSession(id), null);
  assert.equal(auth.valid(token), true);
});

test("a token is parsed strictly before any lookup", () => {
  const { auth, time } = setup();
  const { token } = open(auth, time);
  for (const candidate of [
    undefined,
    null,
    "",
    token.slice(0, -1),
    `${token}a`,
    `${token.slice(0, -1)}=`,
    `${token.slice(0, -1)} `,
    `Bearer ${token}`,
    "A".repeat(43),
    "x".repeat(4096),
  ])
    assert.equal(auth.valid(candidate), false);
  assert.equal(auth.valid(token), true);
});

test("revocation is idempotent and reports the session it invalidated", () => {
  const { auth, time } = setup();
  const first = open(auth, time);
  const second = open(auth, time);

  assert.deepEqual(auth.revokeSession(first.session.id), first.session);
  assert.equal(auth.revokeSession(first.session.id), null);
  assert.equal(auth.valid(first.token), false);
  assert.equal(auth.activeSession(first.session.id), null);
  assert.equal(auth.valid(second.token), true);

  auth.revoke(second.token);
  assert.equal(auth.valid(second.token), false);
  auth.revoke(second.token);
  auth.revoke(undefined);
  assert.equal(auth.activeSession(second.session.id), null);
});

test("returned session views are detached from the store", () => {
  const { auth, time } = setup();
  const { token, session } = open(auth, time);
  const view = auth.sessionForToken(token);
  view.expiresAt = time.now() + 10 * SESSION_MS;
  view.id = "tampered";

  assert.deepEqual(auth.sessionForToken(token), session);
  assert.deepEqual(auth.activeSession(session.id), session);
  assert.equal(auth.activeSession("tampered"), null);

  time.set(session.expiresAt);
  assert.equal(auth.valid(token), false);
});

test("a restart invalidates every session the previous engine issued", () => {
  const { auth, time } = setup();
  const { token, session } = open(auth, time);
  const restarted = createPasswordAuth(PASSWORD, time.now);

  assert.equal(restarted.valid(token), false);
  assert.equal(restarted.sessionForToken(token), null);
  assert.equal(restarted.activeSession(session.id), null);
  assert.equal(restarted.login(PASSWORD).status, 200);
});
