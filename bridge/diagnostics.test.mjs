import assert from "node:assert/strict";
import test from "node:test";
import { createDiagnosticLimiter, parseDiagnostic } from "./diagnostics.mjs";

test("a black-box entry keeps only its known fields, bounded", () => {
  const record = parseDiagnostic({
    kind: "error",
    message: "m".repeat(1000),
    stack: "s".repeat(2000),
    source: "app.js:1:2",
    heapMB: null,
    nodes: 10, w: 390, h: 844,
    trail: [{ t: 1, what: "w".repeat(500) }],
  });
  assert.equal(record.message.length, 400);
  assert.equal(record.stack.length, 900);
  assert.equal(record.trail[0].what.length, 200);
  assert.equal(record.heapMB, null);
});

test("anything outside the schema is diagnostic_invalid", () => {
  for (const entry of [
    {},
    { kind: "prompt" },
    { kind: "beat", text: "a prompt the client should not send" },
    { kind: "beat", w: "wide" },
    { kind: "beat", trail: "not a list" },
    { kind: "beat", trail: [{ t: 1, what: "x", output: "terminal bytes" }] },
    { kind: "beat", trail: Array.from({ length: 26 }, (_, t) => ({ t, what: "x" })) },
    { kind: "error", message: { nested: true } },
  ]) {
    assert.throws(() => parseDiagnostic(entry), { code: "diagnostic_invalid", status: 400 }, JSON.stringify(entry).slice(0, 80));
  }
});

test("each device gets sixty entries in any rolling minute", () => {
  let time = 0;
  const limiter = createDiagnosticLimiter({ now: () => time });
  for (let i = 0; i < 60; i++) limiter.take("a");
  assert.throws(() => limiter.take("a"), (error) => error.code === "diagnostic_rate_limited" && error.status === 429 && error.retryAfter === 60);
  limiter.take("b");
  time = 59_999;
  assert.throws(() => limiter.take("a"), { code: "diagnostic_rate_limited" });
  time = 60_000;
  limiter.take("a");
  limiter.forget("a");
  for (let i = 0; i < 59; i++) limiter.take("a");
});
