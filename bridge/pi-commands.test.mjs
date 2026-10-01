import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPiCommands } from "./pi-commands.mjs";

// A pi stand-in speaking just enough RPC: it checks its arguments and working
// directory, logs each start, and answers get_commands the way PI_MODE says.
const FAKE_PI = `#!${process.execPath}
import { appendFileSync } from "node:fs";
appendFileSync(process.env.PI_LOG, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + "\\n");
const mode = process.env.PI_MODE;
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  if (!input.includes("\\n")) return;
  const request = JSON.parse(input.slice(0, input.indexOf("\\n")));
  if (mode === "hang") return;
  // Noise first: a session event and a malformed line must be skipped.
  process.stdout.write('{"type":"agent_start"}\\nnot json\\n');
  if (mode === "refuse") {
    process.stdout.write(JSON.stringify({ id: request.id, type: "response", command: "get_commands", success: false, error: "nope" }) + "\\n");
    return;
  }
  process.stdout.write(JSON.stringify({ id: request.id, type: "response", command: "get_commands", success: true, data: { commands: [
    { name: "deploy", description: "Ship \\u2028 it", source: "extension" },
    { name: "fix-tests", description: "Fix failing tests", source: "prompt" },
    { name: "skill:notes", description: "Take notes", source: "skill" },
    { name: "has space", source: "extension" },
    { name: "deploy", description: "duplicate", source: "extension" },
  ] } }) + "\\n");
});
process.stdin.on("end", () => process.exit(0));
`;

async function fixture(mode) {
  const dir = await mkdtemp(path.join(tmpdir(), "moshpit-pi-"));
  const bin = path.join(dir, "pi");
  await writeFile(bin, FAKE_PI);
  await chmod(bin, 0o755);
  const log = path.join(dir, "starts.log");
  await writeFile(log, "");
  process.env.PI_LOG = log;
  process.env.PI_MODE = mode;
  const starts = async () => (await readFile(log, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { dir, bin, starts };
}

test("lists pi's live commands in the pane's directory, once per cache window", async () => {
  const { dir, bin, starts } = await fixture("ok");
  let clock = 0;
  const pi = createPiCommands({ bin, now: () => clock, ttlMs: 1000 });
  const [first, concurrent] = await Promise.all([pi.list(dir), pi.list(dir)]);
  assert.deepEqual(first, [
    { name: "deploy", invocation: "/deploy", description: "Ship   it" },
    { name: "fix-tests", invocation: "/fix-tests", description: "Fix failing tests" },
    { name: "notes", invocation: "/skill:notes", description: "Take notes" },
  ]);
  assert.equal(concurrent, first, "a second request joins the one in flight");
  const [start] = await starts();
  assert.deepEqual(start.args, ["--mode", "rpc", "--no-session", "--offline"]);
  assert.equal(start.cwd, dir);

  clock = 500;
  await pi.list(dir);
  assert.equal((await starts()).length, 1, "cached inside the window");
  clock = 1500;
  await pi.list(dir);
  assert.equal((await starts()).length, 2, "asked again after it");
  await rm(dir, { recursive: true, force: true });
});

test("a refusal, a hang, a missing binary and a relative path all reject", async () => {
  const refused = await fixture("refuse");
  await assert.rejects(createPiCommands({ bin: refused.bin }).list(refused.dir), /nope/);
  // A failure is not cached: the next request tries again.
  const pi = createPiCommands({ bin: refused.bin });
  await assert.rejects(pi.list(refused.dir));
  await assert.rejects(pi.list(refused.dir));
  assert.equal((await refused.starts()).length, 3);

  // Each fixture points the fake at its own log, so this one comes after.
  const hung = await fixture("hang");
  await assert.rejects(createPiCommands({ bin: hung.bin, timeoutMs: 200 }).list(hung.dir), /in time/);

  await assert.rejects(createPiCommands({ bin: path.join(hung.dir, "absent") }).list(hung.dir));
  await assert.rejects(createPiCommands({ bin: hung.bin }).list("relative/dir"), /absolute/);

  await rm(refused.dir, { recursive: true, force: true });
  await rm(hung.dir, { recursive: true, force: true });
});
