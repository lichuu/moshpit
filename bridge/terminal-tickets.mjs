import { createHash, randomBytes } from "node:crypto";

// Single-use terminal tickets. The browser proves identity and device over
// HTTP, then carries the ticket in the WebSocket URL, so the value is returned
// once and kept only as a digest. `take` looks up, deletes and answers in one
// synchronous step: whatever the caller does afterwards, a second upgrade
// carrying the same ticket finds nothing.

export const TICKET_LIFETIME_MS = 15 * 1000;
export const MAX_TICKETS_PER_DEVICE = 8;
export const MAX_TICKETS = 128;
export const MAX_TARGET = 128;

const TICKET_BYTES = 32;
const TICKET = /^[A-Za-z0-9_-]{43}$/;
const TICKET_LENGTH = 43;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_LENGTH = 36;
const SESSION_ID = /^[A-Za-z0-9_-]{22}$/;
const SESSION_ID_LENGTH = 22;
const MAX_OWNER = 256;

/** Structured denial, shaped for an `{ error: { code, message } }` envelope. */
export class TicketError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "TicketError";
    this.status = status;
    this.code = code;
  }
}

const invalid = (message) => new TicketError(400, "ticket_request_invalid", message);

const printable = (value, max) =>
  typeof value === "string" && value.length > 0 && value.length <= max && !/\p{Cc}/u.test(value);
const isOwner = (value) => printable(value, MAX_OWNER);
const isTarget = (value) => printable(value, MAX_TARGET);
const isDeviceId = (value) => typeof value === "string" && value.length === UUID_LENGTH && UUID.test(value);
const isSession = (value) =>
  value === null || (typeof value === "string" && value.length === SESSION_ID_LENGTH && SESSION_ID.test(value));

const hashOf = (ticket) => createHash("sha256").update(ticket, "utf8").digest("hex");

export function createTickets({
  now = Date.now,
  lifetimeMs = TICKET_LIFETIME_MS,
  maxPerDevice = MAX_TICKETS_PER_DEVICE,
  maxTotal = MAX_TICKETS,
} = {}) {
  const tickets = new Map();

  function expire(time) {
    for (const [key, ticket] of tickets) {
      if (ticket.expiresAt <= time) tickets.delete(key);
    }
  }

  return {
    /** The raw value is returned once here and never again, by any path. */
    issue({ deviceId, owner, authSessionId, target, paneId }) {
      if (!isDeviceId(deviceId)) throw invalid("A terminal ticket needs the approved device that asked for it.");
      if (!isOwner(owner)) throw invalid("A terminal ticket needs the authenticated owner.");
      if (!isSession(authSessionId))
        throw invalid("A terminal ticket needs the password session that authorized it, or none at all.");
      if (!isTarget(target)) throw invalid(`Name the terminal to open in 1 to ${MAX_TARGET} characters.`);
      if (paneId !== undefined && !isTarget(paneId)) throw invalid(`A terminal ticket's pane must be 1 to ${MAX_TARGET} characters.`);
      const time = now();
      expire(time);
      let held = 0;
      for (const ticket of tickets.values()) {
        if (ticket.deviceId === deviceId) held++;
      }
      // Both caps are checked before anything is generated or stored, so a
      // refusal costs the caller nothing and every waiting ticket still opens.
      if (held >= maxPerDevice)
        throw new TicketError(
          429,
          "ticket_device_limit",
          `This device is already waiting on ${maxPerDevice} terminals. Open this one again in a moment.`,
        );
      if (tickets.size >= maxTotal)
        throw new TicketError(
          429,
          "ticket_limit",
          `This bridge is already opening ${maxTotal} terminals. Open this one again in a moment.`,
        );
      const ticket = randomBytes(TICKET_BYTES).toString("base64url");
      const expiresAt = time + lifetimeMs;
      tickets.set(hashOf(ticket), { deviceId, owner, authSessionId, target, paneId, expiresAt });
      return { ticket, expiresAt };
    },

    /**
     * Synchronous on purpose: the upgrade path consumes the ticket before its
     * first await, so two concurrent upgrades cannot both be authorized.
     */
    take(ticket) {
      if (typeof ticket !== "string" || ticket.length !== TICKET_LENGTH || !TICKET.test(ticket)) return null;
      const key = hashOf(ticket);
      const found = tickets.get(key);
      if (!found) return null;
      tickets.delete(key);
      if (found.expiresAt <= now()) return null;
      return {
        deviceId: found.deviceId,
        owner: found.owner,
        authSessionId: found.authSessionId,
        target: found.target,
        ...(found.paneId === undefined ? {} : { paneId: found.paneId }),
      };
    },

    /** Revocation: the unopened terminals of one device, approved or not. */
    dropForDevice(deviceId) {
      expire(now());
      let dropped = 0;
      for (const [key, ticket] of tickets) {
        if (ticket.deviceId === deviceId) {
          tickets.delete(key);
          dropped++;
        }
      }
      return dropped;
    },

    /**
     * Logout: the unopened terminals of one password session. Null is the
     * identity of a bridge with no password, and matches only the tickets
     * issued under it, never every ticket.
     */
    dropForSession(authSessionId) {
      expire(now());
      let dropped = 0;
      for (const [key, ticket] of tickets) {
        if (ticket.authSessionId === authSessionId) {
          tickets.delete(key);
          dropped++;
        }
      }
      return dropped;
    },
  };
}
