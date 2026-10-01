import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Session } from "node:inspector/promises";
import test from "node:test";
import {
  createTickets,
  MAX_TARGET,
  MAX_TICKETS,
  MAX_TICKETS_PER_DEVICE,
  TICKET_LIFETIME_MS,
} from "./terminal-tickets.mjs";

const OWNER = "you@example.com";
const DEVICE = "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b";
const OTHER_DEVICE = "c0ffee11-2222-4333-8444-d0d0cafe5555";
const TARGET = "pane-123";
const START = 1_800_000_000_000;
const sessionId = () => randomBytes(16).toString("base64url");

function clock(start = START) {
  const time = { value: start };
  return { now: () => time.value, advance: (ms) => (time.value += ms), set: (ms) => (time.value = ms) };
}

function setup(options = {}) {
  const time = clock();
  return { time, tickets: createTickets({ now: time.now, ...options }) };
}

/** One request, and equally the claim `take` owes back for it. */
const request = (patch = {}) => ({ deviceId: DEVICE, owner: OWNER, authSessionId: null, target: TARGET, ...patch });

const DUMP = `function () {
  return JSON.stringify(this, (key, value) => (value instanceof Map ? [...value] : value));
}`;

// The store's state lives in a closure, so "the ticket is nowhere in it" can
// only be said by reading that closure. The inspector reaches it; each test
// using this asserts the dump saw the record, or the claim would be vacuous.
async function storedState(tickets) {
  const session = new Session();
  session.connect();
  globalThis.__tickets = tickets;
  try {
    const { result } = await session.post("Runtime.evaluate", { expression: "globalThis.__tickets.take" });
    const { internalProperties } = await session.post("Runtime.getProperties", { objectId: result.objectId });
    const scopes = internalProperties.find((entry) => entry.name === "[[Scopes]]");
    const { result: found } = await session.post("Runtime.getProperties", {
      objectId: scopes.value.objectId,
      ownProperties: true,
    });
    const dumped = [];
    for (const scope of found) {
      if (!/^(Block|Closure)/.test(scope.value.description ?? "")) continue;
      const { result: value } = await session.post("Runtime.callFunctionOn", {
        objectId: scope.value.objectId,
        functionDeclaration: DUMP,
        returnByValue: true,
      });
      dumped.push(value.value);
    }
    return dumped.join("\n");
  } finally {
    delete globalThis.__tickets;
    session.disconnect();
  }
}

test("one ticket opens exactly one terminal, even when raced", async () => {
  const { tickets } = setup();
  const { ticket, expiresAt } = tickets.issue(request());
  assert.match(ticket, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(expiresAt, START + TICKET_LIFETIME_MS);

  // Each upgrade yields before and after consuming, so all four are in flight
  // together and only the ordering inside take() decides the winner.
  const upgrade = async () => {
    await null;
    const claim = tickets.take(ticket);
    await null;
    assert.ok(claim, "this upgrade found no ticket");
    return claim;
  };
  const results = await Promise.allSettled([upgrade(), upgrade(), upgrade(), upgrade()]);
  const opened = results.filter((result) => result.status === "fulfilled");

  assert.equal(opened.length, 1);
  assert.deepEqual(opened[0].value, request());
  assert.equal(tickets.take(ticket), null);
});

test("a ticket is spent by the upgrade that took it, even when that upgrade then fails", () => {
  const { tickets } = setup();
  const { ticket } = tickets.issue(request());
  assert.throws(() => {
    assert.deepEqual(tickets.take(ticket), request());
    throw new Error("the upgrade was refused after it took the ticket");
  }, /refused after it took the ticket/);
  assert.equal(tickets.take(ticket), null);
});

test("a ticket lives to its last millisecond and no further", () => {
  const { tickets, time } = setup();
  const early = tickets.issue(request());
  const late = tickets.issue(request({ target: "pane-late" }));

  time.set(early.expiresAt - 1);
  assert.deepEqual(tickets.take(early.ticket), request());
  time.set(late.expiresAt);
  assert.equal(tickets.take(late.ticket), null);
});

test("a device waits on a bounded number of terminals, and a refusal spends nothing", () => {
  const { tickets, time } = setup();
  const fill = () =>
    Array.from({ length: MAX_TICKETS_PER_DEVICE }, (_, index) => tickets.issue(request({ target: `pane-${index}` })));
  const issued = fill();

  assert.throws(() => tickets.issue(request()), {
    name: "TicketError",
    status: 429,
    code: "ticket_device_limit",
  });
  // One device filling its share is not the bridge running out.
  assert.match(tickets.issue(request({ deviceId: OTHER_DEVICE })).ticket, /^[A-Za-z0-9_-]{43}$/);
  for (const [index, entry] of issued.entries())
    assert.deepEqual(tickets.take(entry.ticket), request({ target: `pane-${index}` }));

  const stale = fill();
  assert.throws(() => tickets.issue(request()), { code: "ticket_device_limit" });
  time.advance(TICKET_LIFETIME_MS);
  assert.match(tickets.issue(request()).ticket, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(tickets.take(stale[0].ticket), null);
});

test("the bridge waits on a bounded number of terminals across every device", () => {
  const { tickets } = setup();
  const issued = [];
  while (issued.length < MAX_TICKETS) {
    const deviceId = randomUUID();
    for (let index = 0; index < MAX_TICKETS_PER_DEVICE; index++) {
      const target = `pane-${index}`;
      issued.push({ deviceId, target, ...tickets.issue(request({ deviceId, target })) });
    }
  }
  const latecomer = randomUUID();

  assert.throws(() => tickets.issue(request({ deviceId: latecomer })), {
    name: "TicketError",
    status: 429,
    code: "ticket_limit",
  });
  const first = issued[0];
  assert.deepEqual(tickets.take(first.ticket), request({ deviceId: first.deviceId, target: first.target }));
  const last = issued.at(-1);
  assert.deepEqual(tickets.take(last.ticket), request({ deviceId: last.deviceId, target: last.target }));
  assert.match(tickets.issue(request({ deviceId: latecomer })).ticket, /^[A-Za-z0-9_-]{43}$/);
});

test("revoking a device and ending a session drop only their own tickets", () => {
  const { tickets } = setup();
  const live = sessionId();
  const elsewhere = sessionId();
  const mineAnonymous = tickets.issue(request());
  const mineLive = tickets.issue(request({ authSessionId: live }));
  const theirsAnonymous = tickets.issue(request({ deviceId: OTHER_DEVICE }));
  const theirsLive = tickets.issue(request({ deviceId: OTHER_DEVICE, authSessionId: live }));
  const theirsSecond = tickets.issue(request({ deviceId: OTHER_DEVICE, authSessionId: live, target: "pane-two" }));

  assert.equal(tickets.dropForDevice(DEVICE), 2);
  assert.equal(tickets.dropForDevice(DEVICE), 0);
  assert.equal(tickets.take(mineAnonymous.ticket), null);
  assert.equal(tickets.take(mineLive.ticket), null);

  assert.equal(tickets.dropForSession(elsewhere), 0);
  assert.equal(tickets.dropForSession(undefined), 0);
  // Null is the identity of a bridge with no password, not a wildcard.
  assert.equal(tickets.dropForSession(null), 1);
  assert.equal(tickets.take(theirsAnonymous.ticket), null);

  assert.equal(tickets.dropForSession(live), 2);
  assert.equal(tickets.take(theirsLive.ticket), null);
  assert.equal(tickets.take(theirsSecond.ticket), null);
});

test("a ticket the bridge never issued cannot reach the ones it did", () => {
  const { tickets } = setup();
  const { ticket } = tickets.issue(request());
  const recased = [...ticket].map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join("");
  for (const value of [
    undefined,
    null,
    "",
    "  ",
    ticket.slice(0, -1),
    `${ticket}A`,
    `${ticket.slice(0, -1)}=`,
    `${ticket.slice(0, -1)}+`,
    recased,
    "A".repeat(43),
    "A".repeat(64 * 1024),
    createHash("sha256").update(ticket).digest("hex"),
    Buffer.from(ticket),
    { toString: () => ticket },
  ])
    assert.equal(tickets.take(value), null);
  assert.deepEqual(tickets.take(ticket), request());
});

test("issue refuses a request it cannot bind to a device, an owner and a terminal", () => {
  const { tickets } = setup();
  for (const patch of [
    { deviceId: undefined },
    { deviceId: "" },
    { deviceId: DEVICE.toUpperCase() },
    { deviceId: `${DEVICE} ` },
    { deviceId: DEVICE.replaceAll("-", "") },
    { owner: undefined },
    { owner: "" },
    { owner: "line\nbreak" },
    { owner: "o".repeat(257) },
    { authSessionId: undefined },
    { authSessionId: "" },
    { authSessionId: sessionId().slice(0, 21) },
    { authSessionId: 7 },
    { target: undefined },
    { target: "" },
    { target: "pane\u0007" },
    { target: "p".repeat(MAX_TARGET + 1) },
  ])
    assert.throws(() => tickets.issue(request(patch)), {
      name: "TicketError",
      status: 400,
      code: "ticket_request_invalid",
    });

  const bounds = request({ owner: "o".repeat(256), authSessionId: sessionId(), target: "p".repeat(MAX_TARGET) });
  assert.deepEqual(tickets.take(tickets.issue(bounds).ticket), bounds);
});

test("the target crosses the store unmodified", () => {
  const { tickets } = setup();
  for (const target of ["0", "herdr:instance-7#generation-42", "  spaced  ", "терминал ☃", "p".repeat(MAX_TARGET)])
    assert.deepEqual(tickets.take(tickets.issue(request({ target })).ticket), request({ target }));
});

test("the store holds a digest of the ticket, never the ticket", async () => {
  const { tickets } = setup();
  const { ticket } = tickets.issue(request());
  const stored = await storedState(tickets);

  assert.ok(stored.includes(TARGET) && stored.includes(DEVICE), "the dump never saw the stored ticket");
  assert.ok(!stored.includes(ticket), "the store holds the raw ticket");
  assert.deepEqual(tickets.take(ticket), request());
});

test("a ticket carries the pane it was issued for, when one is named", () => {
  const tickets = createTickets();
  const bound = tickets.issue(request({ paneId: "w1:p1" }));
  assert.deepEqual(tickets.take(bound.ticket), request({ paneId: "w1:p1" }));
  assert.throws(() => tickets.issue(request({ paneId: "" })), { code: "ticket_request_invalid" });
  assert.throws(() => tickets.issue(request({ paneId: "x".repeat(129) })), { code: "ticket_request_invalid" });
});
