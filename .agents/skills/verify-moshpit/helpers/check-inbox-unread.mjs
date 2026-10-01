import assert from "node:assert/strict";
import { inboxUnread } from "../../../../src/lib/moshpit/events.ts";

const now = 1_700_000_000_000;

assert.equal(inboxUnread([]), 0);

assert.equal(
  inboxUnread([
    { id: "1", agentId: "docs", kind: "blocked", text: "proceed?", at: now },
  ]),
  1,
);

assert.equal(
  inboxUnread([
    { id: "1", agentId: "docs", kind: "blocked", text: "proceed?", at: now },
    { id: "2", agentId: "ci", kind: "blocked", text: "again?", at: now + 1 },
  ]),
  2,
);

assert.equal(
  inboxUnread([
    {
      id: "1",
      agentId: "docs",
      kind: "blocked",
      text: "proceed?",
      at: now,
      resolved: "approved",
    },
  ]),
  0,
);

assert.equal(
  inboxUnread([
    { id: "t", agentId: "auth", kind: "tool", text: "editing", at: now },
    { id: "n", agentId: "auth", kind: "turn", text: "finished", at: now + 1 },
  ]),
  0,
);

assert.equal(
  inboxUnread([
    { id: "1", agentId: "docs", kind: "blocked", text: "proceed?", at: now },
    { id: "t", agentId: "auth", kind: "tool", text: "editing", at: now },
    {
      id: "2",
      agentId: "ci",
      kind: "blocked",
      text: "again?",
      at: now + 1,
      resolved: "denied",
    },
    { id: "n", agentId: "auth", kind: "turn", text: "finished", at: now + 2 },
  ]),
  1,
);

console.log("ok   inboxUnread counts blocked unresolved only");
