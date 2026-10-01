import assert from "node:assert/strict";
import test from "node:test";
import { envelope, JSON_SCHEMA_VERSION, stepError, stepParts, unwrapVersion, writeEnvelope } from "./json-output.mjs";

test("an envelope names its schema, command, outcome and exit code", () => {
  assert.deepEqual(envelope("address", { exitCode: 0, result: { origin: "https://a" } }), {
    schemaVersion: JSON_SCHEMA_VERSION,
    command: "address",
    ok: true,
    exitCode: 0,
    result: { origin: "https://a" },
  });
  assert.deepEqual(envelope("address", { exitCode: 3, error: { code: "not_installed", message: "no" } }), {
    schemaVersion: JSON_SCHEMA_VERSION,
    command: "address",
    ok: false,
    exitCode: 3,
    error: { code: "not_installed", message: "no" },
  });
});

test("an envelope carries an error exactly when the command failed", () => {
  assert.throws(() => envelope("x", { exitCode: 1, result: {} }), TypeError);
  assert.throws(() => envelope("x", { exitCode: 0, error: { code: "a", message: "b" } }), TypeError);
});

test("writeEnvelope prints one newline-terminated line", () => {
  const out = [];
  writeEnvelope({ stdout: { write: (text) => out.push(text) } }, "version", { exitCode: 0, result: { version: "1" } });
  assert.equal(out.length, 1);
  assert.ok(out[0].endsWith("}\n") && !out[0].trimEnd().includes("\n"));
});

test("a step walk's error is the first failed or blocked step, else where it stopped", () => {
  const steps = [
    { id: "a", status: "done", detail: "ok" },
    { id: "b", status: "blocked", detail: "why b" },
    { id: "c", status: "failed", detail: "why c" },
  ];
  assert.deepEqual(stepError({ state: "s", steps }), { code: "b", message: "why b" });
  assert.deepEqual(stepError({ state: "half", steps: [steps[0]], next: "do this" }), { code: "incomplete", message: "do this" });
  assert.deepEqual(stepError({ state: "half", steps: [steps[0]] }), { code: "incomplete", message: "Stopped at: half." });
  assert.deepEqual(stepParts({ exitCode: 0, result: { ok: true, state: "s", steps } }), { exitCode: 0, result: { state: "s", steps } });
});

test("a release older than the envelope still reads as its bare info", () => {
  assert.deepEqual(unwrapVersion({ name: "moshpit", version: "1" }), { name: "moshpit", version: "1" });
  assert.deepEqual(unwrapVersion(envelope("version", { exitCode: 0, result: { name: "moshpit", version: "2" } })), { name: "moshpit", version: "2" });
});
