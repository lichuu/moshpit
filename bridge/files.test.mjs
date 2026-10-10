import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { cleanFileName, MAX_FILE_BYTES, MAX_FILE_NAME_BYTES, quoteShellWord } from "../src/lib/moshpit/file-names.mjs";
import { createFileLimiter, createFiles, fileTarget, parseFileRequest } from "./files.mjs";
import { boundaryEnv, bridgeCommand, freePort, isolatedEnv, pairDevice, passwordEnv } from "./test-support.mjs";

async function scratch(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "moshpit-files-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function* chunksOf(bytes, size = 4) {
  const data = Buffer.from(bytes);
  for (let at = 0; at < data.length; at += size) yield data.subarray(at, at + size);
}

const upload = (files, name, text = "hello", extra = {}) => files.save({ name, length: Buffer.byteLength(text), chunks: chunksOf(text), ...extra });
const entries = (directory) => readdir(directory).catch(() => []);
const mode = async (target) => (await stat(target)).mode & 0o777;

test("a file is stored in its own private directory, byte for byte", async (t) => {
  const stateDir = await scratch(t);
  const files = await createFiles({ stateDir });
  const text = "line one\nline two\n";
  const saved = await upload(files, "notes.txt", text);
  const root = path.join(stateDir, "files");
  assert.equal(saved.name, "notes.txt");
  assert.equal(saved.size, text.length);
  assert.equal(path.dirname(path.dirname(saved.path)), root);
  assert.match(path.basename(path.dirname(saved.path)), /^[0-9a-f]{24}$/);
  assert.equal(await readFile(saved.path, "utf8"), text);
  assert.equal(await mode(root), 0o700);
  assert.equal(await mode(path.dirname(saved.path)), 0o700);
  assert.equal(await mode(saved.path), 0o600);
  assert.deepEqual(await entries(path.dirname(saved.path)), ["notes.txt"], "no temporary file is left beside it");
  assert.equal(files.usedBytes, text.length);
  assert.equal(files.fileCount, 1);
});

test("the same name twice lands in two directories, and nothing is replaced", async (t) => {
  const stateDir = await scratch(t);
  const files = await createFiles({ stateDir });
  const first = await upload(files, "a.txt", "first");
  const second = await upload(files, "a.txt", "second");
  assert.notEqual(path.dirname(first.path), path.dirname(second.path));
  assert.equal(await readFile(first.path, "utf8"), "first");
  assert.equal(await readFile(second.path, "utf8"), "second");
});

test("a file with a name using spaces, quotes and non-ASCII letters keeps that name", async (t) => {
  const stateDir = await scratch(t);
  const files = await createFiles({ stateDir });
  for (const name of ["my notes.txt", "it's \"here\" $HOME `x`.md", "résumé 日本語.pdf", "-dash.txt", "no-extension"]) {
    const saved = await upload(files, name);
    assert.equal(saved.name, name.normalize("NFC"));
    assert.equal(path.basename(saved.path), name.normalize("NFC"));
  }
});

const BAD_NAMES = {
  empty: "",
  "only spaces": "   ",
  "a path": "dir/file.txt",
  "a parent path": "../escape.txt",
  "a backslash path": "dir\\file.txt",
  "a fullwidth slash": "dir／file.txt",
  "a dot": ".",
  "two dots": "..",
  "a leading dot": ".env",
  "a NUL": "a\0b.txt",
  "a newline": "a\nb.txt",
  "a tab": "a\tb.txt",
  "an escape": "a\u001b[31m.txt",
  "DEL": "a\u007fb.txt",
  "a C1 control": "a\u0085b.txt",
  "a right-to-left override": "report\u202egpj.exe",
  "a line separator": "a\u2028b.txt",
  "a byte order mark": "\ufeffa.txt",
  "a trailing space": "a.txt ",
  "a trailing dot": "a.txt.",
  "a lone surrogate": "a\ud800b.txt",
  "a device name": "CON",
  "a device name with an extension": "nul.txt",
  "a numbered device name": "com1",
  "too many bytes": `${"é".repeat(MAX_FILE_NAME_BYTES / 2)}x`,
};

test("every bad name class is refused before anything is reserved or written", async (t) => {
  const stateDir = await scratch(t);
  const files = await createFiles({ stateDir });
  for (const [what, name] of Object.entries(BAD_NAMES)) {
    await assert.rejects(upload(files, name), { status: 400, code: "file_name_invalid" }, what);
  }
  await assert.rejects(upload(files, undefined), { code: "file_name_invalid" }, "a missing name");
  await assert.rejects(upload(files, 7), { code: "file_name_invalid" }, "a number");
  assert.deepEqual(await entries(path.join(stateDir, "files")), []);
  assert.equal(files.usedBytes, 0);
  assert.equal(files.fileCount, 0);
  // The longest name that fits, in bytes, is kept.
  assert.equal(cleanFileName("a".repeat(MAX_FILE_NAME_BYTES)).name?.length, MAX_FILE_NAME_BYTES);
  assert.ok(cleanFileName("a".repeat(MAX_FILE_NAME_BYTES + 1)).error);
  // Composed to NFC, so the same letters always give the same name.
  assert.equal(cleanFileName("e\u0301.txt").name, "\u00e9.txt");
});

test("an empty file is refused, declared or not", async (t) => {
  const stateDir = await scratch(t);
  const files = await createFiles({ stateDir });
  await assert.rejects(files.save({ name: "a.txt", length: 0, chunks: chunksOf("") }), { code: "file_empty" });
  await assert.rejects(files.save({ name: "a.txt", chunks: chunksOf("") }), { code: "file_empty" });
  assert.deepEqual(await entries(path.join(stateDir, "files")), []);
  assert.equal(files.usedBytes, 0);
});

test("a declared size over the cap is refused before a byte is read", async (t) => {
  const stateDir = await scratch(t);
  const files = await createFiles({ stateDir });
  let read = false;
  const chunks = (async function* () { read = true; yield Buffer.from("x"); })();
  await assert.rejects(files.save({ name: "big.bin", length: MAX_FILE_BYTES + 1, chunks }), { status: 413, code: "file_too_large" });
  assert.equal(read, false);
  assert.deepEqual(await entries(path.join(stateDir, "files")), []);
});

test("the cap is enforced while reading: a body that runs on leaves no file and frees its reservation", async (t) => {
  const stateDir = await scratch(t);
  const files = await createFiles({ stateDir, maxFileBytes: 10 });
  let sent = 0;
  const endless = (async function* () {
    for (;;) { sent += 4; yield Buffer.from("abcd"); }
  })();
  await assert.rejects(files.save({ name: "run.bin", chunks: endless }), { status: 413, code: "file_too_large" });
  assert.ok(sent <= 12, `stopped reading after ${sent} bytes`);
  const root = path.join(stateDir, "files");
  assert.deepEqual(await entries(root), [], "the directory it made is gone too");
  assert.equal(files.usedBytes, 0);
  assert.equal(files.fileCount, 0);
  // A body longer than it declared is refused the same way.
  await assert.rejects(files.save({ name: "lie.bin", length: 4, chunks: chunksOf("abcdefgh") }), { code: "file_too_large" });
  assert.deepEqual(await entries(root), []);
});

test("an interrupted upload leaves nothing behind, whether it stops with an error or short", async (t) => {
  const stateDir = await scratch(t);
  const files = await createFiles({ stateDir });
  const root = path.join(stateDir, "files");
  const aborted = (async function* () {
    yield Buffer.from("partial");
    throw Object.assign(new Error("aborted"), { code: "ECONNRESET" });
  })();
  await assert.rejects(files.save({ name: "a.txt", length: 100, chunks: aborted }), { status: 400, code: "file_interrupted" });
  assert.deepEqual(await entries(root), []);
  await assert.rejects(files.save({ name: "b.txt", length: 100, chunks: chunksOf("short") }), { code: "file_interrupted" });
  assert.deepEqual(await entries(root), []);
  const failing = (async function* () { yield Buffer.from("x"); throw new Error("boom"); })();
  await assert.rejects(files.save({ name: "c.txt", chunks: failing }), { message: "boom" });
  assert.deepEqual(await entries(root), []);
  assert.equal(files.usedBytes, 0);
  assert.equal(files.fileCount, 0);
});

test("the final name never holds a partial file while the body is still arriving", async (t) => {
  const stateDir = await scratch(t);
  const files = await createFiles({ stateDir, randomId: (() => { let n = 0; return () => `id${n++}`; })() });
  const directory = path.join(stateDir, "files", "id0");
  let seen;
  const chunks = (async function* () {
    yield Buffer.from("first half ");
    seen = await entries(directory);
    yield Buffer.from("second half");
  })();
  const saved = await files.save({ name: "whole.txt", chunks });
  assert.equal(seen.length, 1);
  assert.match(seen[0], /^\.part-/, "only a temporary name exists mid-upload");
  assert.equal(await readFile(saved.path, "utf8"), "first half second half");
});

test("a pre-existing upload directory is never entered, replaced or removed", async (t) => {
  const stateDir = await scratch(t);
  const root = path.join(stateDir, "files");
  await mkdir(path.join(root, "taken"), { recursive: true, mode: 0o700 });
  await writeFile(path.join(root, "taken", "a.txt"), "original");
  const files = await createFiles({ stateDir, randomId: () => "taken" });
  await assert.rejects(upload(files, "a.txt", "new"), { code: "file_exists" });
  assert.equal(await readFile(path.join(root, "taken", "a.txt"), "utf8"), "original");
  assert.deepEqual(await entries(path.join(root, "taken")), ["a.txt"]);
  assert.equal(files.usedBytes, "original".length, "only what was already there is counted");
});

test("a regular file that appears at the final name is not overwritten", async (t) => {
  const stateDir = await scratch(t);
  const files = await createFiles({ stateDir, randomId: (() => { let n = 0; return () => `id${n++}`; })() });
  const directory = path.join(stateDir, "files", "id0");
  const chunks = (async function* () {
    yield Buffer.from("new bytes");
    await writeFile(path.join(directory, "a.txt"), "planted");
  })();
  await assert.rejects(files.save({ name: "a.txt", chunks }), { code: "file_exists" });
  assert.equal(await readFile(path.join(directory, "a.txt"), "utf8"), "planted");
  assert.deepEqual(await entries(directory), ["a.txt"], "the temporary file is gone");
});

test("a symbolic link planted at the final name is refused and its target is untouched", async (t) => {
  const stateDir = await scratch(t);
  const outside = path.join(await scratch(t), "victim.txt");
  await writeFile(outside, "victim");
  const files = await createFiles({ stateDir, randomId: (() => { let n = 0; return () => `id${n++}`; })() });
  const directory = path.join(stateDir, "files", "id0");
  const chunks = (async function* () {
    yield Buffer.from("new bytes");
    await symlink(outside, path.join(directory, "a.txt"));
  })();
  await assert.rejects(files.save({ name: "a.txt", chunks }), { code: "file_exists" });
  assert.equal(await readFile(outside, "utf8"), "victim");
  assert.equal((await lstat(path.join(directory, "a.txt"))).isSymbolicLink(), true, "the planted link is left as found");
});

test("a symbolic link where the upload directory should be is refused", async (t) => {
  const stateDir = await scratch(t);
  const outside = await scratch(t);
  const root = path.join(stateDir, "files");
  await mkdir(root, { recursive: true, mode: 0o700 });
  await symlink(outside, path.join(root, "linked"));
  const files = await createFiles({ stateDir, randomId: () => "linked" });
  await assert.rejects(upload(files, "a.txt"), { code: "file_exists" });
  assert.deepEqual(await entries(outside), [], "nothing was written through the link");
});

test("a symbolic link where the files directory should be is refused, not followed", async (t) => {
  const stateDir = await scratch(t);
  const outside = await scratch(t);
  await symlink(outside, path.join(stateDir, "files"));
  const files = await createFiles({ stateDir });
  await assert.rejects(upload(files, "a.txt"), { status: 500, code: "file_storage_unsafe" });
  assert.deepEqual(await entries(outside), []);
  assert.equal(files.usedBytes, 0);
});

test("a files directory open to other users is refused and left as it is", async (t) => {
  const stateDir = await scratch(t);
  const root = path.join(stateDir, "files");
  await mkdir(root, { recursive: true });
  await chmod(root, 0o770);
  const files = await createFiles({ stateDir });
  await assert.rejects(upload(files, "a.txt"), { code: "file_storage_unsafe" });
  assert.equal(await mode(root), 0o770, "permissions are not repaired");
  assert.deepEqual(await entries(root), []);
});

test("a full store refuses a new file and keeps every older one", async (t) => {
  const stateDir = await scratch(t);
  const files = await createFiles({ stateDir, maxFiles: 2 });
  const one = await upload(files, "one.txt", "1");
  const two = await upload(files, "two.txt", "2");
  await assert.rejects(upload(files, "three.txt", "3"), { status: 507, code: "file_storage_full" });
  assert.equal(await readFile(one.path, "utf8"), "1");
  assert.equal(await readFile(two.path, "utf8"), "2");
  assert.equal((await entries(path.join(stateDir, "files"))).length, 2);
  assert.equal(files.fileCount, 2);
});

test("bytes are bounded too, and parallel uploads cannot pass the bound", async (t) => {
  const stateDir = await scratch(t);
  const files = await createFiles({ stateDir, quotaBytes: 30 });
  const results = await Promise.allSettled(Array.from({ length: 6 }, (_, n) => upload(files, `f${n}.txt`, "0123456789")));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 3);
  for (const r of results.filter((r) => r.status === "rejected")) assert.equal(r.reason.code, "file_storage_full");
  assert.equal(files.usedBytes, 30);
  assert.equal((await entries(path.join(stateDir, "files"))).length, 3);
});

test("a failed upload gives its reservation back, so the space can be used again", async (t) => {
  const stateDir = await scratch(t);
  const files = await createFiles({ stateDir, quotaBytes: 10, maxFiles: 1 });
  await assert.rejects(files.save({ name: "a.txt", length: 10, chunks: chunksOf("short") }), { code: "file_interrupted" });
  assert.equal(files.usedBytes, 0);
  await upload(files, "a.txt", "0123456789");
  assert.equal(files.usedBytes, 10);
});

test("a restart counts the files already on disk and clears what a crash left half done", async (t) => {
  const stateDir = await scratch(t);
  const first = await createFiles({ stateDir });
  await upload(first, "keep.txt", "12345");
  const root = path.join(stateDir, "files");
  await mkdir(path.join(root, "crashed"), { mode: 0o700 });
  await writeFile(path.join(root, "crashed", ".part-abc"), "half");
  await mkdir(path.join(root, "empty"), { mode: 0o700 });
  const again = await createFiles({ stateDir, maxFiles: 1 });
  assert.equal(again.usedBytes, 5);
  assert.equal(again.fileCount, 1);
  assert.equal((await entries(root)).length, 1, "the half-written and empty directories are gone");
  await assert.rejects(upload(again, "more.txt"), { code: "file_storage_full" });
});

test("the allowance is per device and rolls over after a minute", () => {
  let now = 0;
  const limiter = createFileLimiter({ limit: 2, now: () => now });
  limiter.take("a");
  limiter.take("a");
  assert.throws(() => limiter.take("a"), (error) => error.status === 429 && error.code === "file_rate_limited" && error.retryAfter === 60);
  limiter.take("b");
  now = 59_000;
  assert.throws(() => limiter.take("a"), { code: "file_rate_limited" });
  now = 60_001;
  limiter.take("a");
  limiter.forget("a");
  limiter.take("a");
  limiter.take("a");
});

test("a request names the pane and the file and nothing else", () => {
  const ok = parseFileRequest(new URLSearchParams("target=w1%3Ap1&name=a%20b.txt"), { "content-length": "12" });
  assert.deepEqual(ok, { target: "w1:p1", name: "a b.txt", length: 12 });
  assert.equal(parseFileRequest(new URLSearchParams("target=p"), {}).length, undefined);
  for (const query of ["", "name=a.txt", "target=p&target=q", "target=p&name=a&name=b", "target=p&x=1", "target=-p", `target=${"p".repeat(513)}`]) {
    assert.throws(() => parseFileRequest(new URLSearchParams(query), {}), { code: "file_request_invalid" }, query);
  }
  for (const length of ["-1", "1e3", "0x10", "12 ", "9".repeat(16), ""]) {
    assert.throws(() => parseFileRequest(new URLSearchParams("target=p"), { "content-length": length }), { code: "file_request_invalid" }, length);
  }
  const snapshot = { agents: [{ id: "a1", paneId: "p1" }], shells: [{ id: "sh1" }] };
  for (const known of ["a1", "p1", "sh1"]) fileTarget(snapshot, known);
  assert.throws(() => fileTarget(snapshot, "zz"), { status: 404, code: "file_target_unknown" });
  assert.throws(() => fileTarget({}, "a1"), { code: "file_target_unknown" });
});

test("a quoted path is one word to a shell, whatever the name holds", () => {
  const cases = [
    "/srv/files/ab12/notes.txt",
    "/srv/files/ab12/my notes.txt",
    "/srv/files/ab12/it's.txt",
    "/srv/files/ab12/''.txt",
    "/srv/files/ab12/\"double\".txt",
    "/srv/files/ab12/$HOME and ${PATH} and $(id).txt",
    "/srv/files/ab12/`id`.txt",
    "/srv/files/ab12/a;b&c|d>e<f.txt",
    "/srv/files/ab12/back\\slash.txt",
    "/srv/files/ab12/star*?[x]~!#.txt",
    "/srv/files/ab12/-n",
    "/srv/files/ab12/résumé 日本語 🙂.pdf",
    "/srv/my files/it's here/a b.txt",
  ];
  for (const target of cases) {
    const quoted = quoteShellWord(target);
    assert.ok(quoted.startsWith("'") && quoted.endsWith("'"));
    // A real shell reads it as a single argument, byte for byte.
    const out = execFileSync("sh", ["-c", `set -- ${quoted}; printf '%s\\0%s' "$#" "$1"`], { encoding: "utf8" });
    assert.equal(out, `1\0${target}`, target);
  }
  assert.equal(quoteShellWord("it's"), `'it'\\''s'`);
  assert.equal(quoteShellWord(""), "''");
});

// The routes, on a real bridge with a fixture herdr that records every write.
const HERDR = `#!${process.execPath}
import { appendFileSync } from "node:fs";
const a = process.argv.slice(2);
if (a[0] === "api") console.log(JSON.stringify({ result: { snapshot: { agents: [{ pane_id: "pane-a", agent: "codex", agent_status: "idle", cwd: "" }] } } }));
else if (a[0] === "pane" && a[1] === "list") console.log(JSON.stringify({ result: { panes: [{ pane_id: "pane-a", terminal_id: "term-a" }] } }));
else if (a[0] === "pane" && a[1] === "layout") console.log(JSON.stringify({ result: { layout: { area: { width: 80, height: 24 } } } }));
else if (a[0] === "pane" && a[1] === "read") console.log("");
else { appendFileSync(process.env.HERDR_WRITES, JSON.stringify(a) + "\\n"); console.log("{}"); }
`;

async function startBridge(t) {
  const dir = await scratch(t);
  const bin = path.join(dir, "herdr-fixture");
  const writes = path.join(dir, "writes.jsonl");
  await writeFile(writes, "");
  await writeFile(bin, HERDR, { mode: 0o700 });
  await writeFile(path.join(dir, "package.json"), '{"type":"module"}');
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const stateDir = path.join(dir, "state");
  const child = spawn(...bridgeCommand(), {
    env: { ...isolatedEnv(), ...boundaryEnv(port), MOSHPIT_BIND: "127.0.0.1", ...await passwordEnv(dir), MOSHPIT_STATE_DIR: stateDir, MOSHPIT_HERDR_BIN: bin, MOSHPIT_POLL_MS: "600000", HERDR_WRITES: writes },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => { child.kill("SIGKILL"); await once(child, "exit").catch(() => {}); });
  await once(child.stdout, "data");
  const login = await fetch(`${url}/api/login`, { method: "POST", headers: { "content-type": "application/json", origin: url }, body: JSON.stringify({ password: "review-pass" }) }).then((r) => r.json());
  const identity = { origin: url, authorization: `Bearer ${login.token}` };
  const device = await pairDevice(url, { ...identity, "content-type": "application/json" }, { stateDir });
  const send = (query, body, headers = {}) => fetch(`${url}/api/files?${query}`, {
    method: "POST",
    headers: { ...identity, "x-moshpit-device": device, "content-type": "application/octet-stream", ...headers },
    body,
  });
  return {
    url, stateDir, identity, device, send,
    get: (pathname, headers) => fetch(`${url}${pathname}`, { headers: { ...identity, "x-moshpit-device": device, ...headers } }),
    writes: async () => (await readFile(writes, "utf8")).split("\n").filter(Boolean),
    stored: () => entries(path.join(stateDir, "files")),
  };
}

test("a file posted to the route is stored, reported with its path and sent to no one", { timeout: 30000 }, async (t) => {
  const bridge = await startBridge(t);
  const bytes = Buffer.from([0, 1, 2, 255, 254, 10, 13, 0]);
  const res = await bridge.send("target=pane-a&name=" + encodeURIComponent("my data.bin"), bytes);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const saved = await res.json();
  assert.deepEqual(Object.keys(saved).sort(), ["name", "path", "size"]);
  assert.equal(saved.name, "my data.bin");
  assert.equal(saved.size, bytes.length);
  assert.ok(path.isAbsolute(saved.path) && saved.path.startsWith(path.join(bridge.stateDir, "files") + path.sep));
  assert.deepEqual(await readFile(saved.path), bytes);
  assert.equal(await mode(saved.path), 0o600);
  assert.deepEqual(await bridge.writes(), [], "the pane received nothing");
});

test("the route refuses without identity, without an approved device and for another pane", { timeout: 30000 }, async (t) => {
  const bridge = await startBridge(t);
  const query = "target=pane-a&name=a.txt";
  const anonymous = await fetch(`${bridge.url}/api/files?${query}`, { method: "POST", headers: { origin: bridge.url, "content-type": "application/octet-stream" }, body: "x" });
  assert.equal(anonymous.status, 401);
  const noDevice = await fetch(`${bridge.url}/api/files?${query}`, { method: "POST", headers: { ...bridge.identity, "content-type": "application/octet-stream" }, body: "x" });
  assert.equal(noDevice.status, 403);
  const stranger = await bridge.send(query, "x", { "x-moshpit-device": "unpaired.secret" });
  assert.equal(stranger.status, 403);
  const unknown = await bridge.send("target=nope&name=a.txt", "x");
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error.code, "file_target_unknown");
  const json = await bridge.send(query, "{}", { "content-type": "application/json" });
  assert.equal(json.status, 415, "a file is not accepted as JSON");
  const elsewhere = await fetch(`${bridge.url}/api/action`, { method: "POST", headers: { ...bridge.identity, "x-moshpit-device": bridge.device, "content-type": "application/octet-stream" }, body: "{}" });
  assert.equal(elsewhere.status, 415, "no other route takes a file body");
  assert.deepEqual(await bridge.stored(), [], "nothing was stored by any refusal");
});

test("a bad name or an empty body is a plain 400 and stores nothing", { timeout: 30000 }, async (t) => {
  const bridge = await startBridge(t);
  for (const name of [".env", "a/b", "..", "con", "a%00b", "a%0Ab"]) {
    const res = await bridge.send(`target=pane-a&name=${name}`, "x");
    assert.equal(res.status, 400, name);
    assert.equal((await res.json()).error.code, "file_name_invalid", name);
  }
  const empty = await bridge.send("target=pane-a&name=a.txt", "");
  assert.equal(empty.status, 400);
  assert.equal((await empty.json()).error.code, "file_empty");
  assert.deepEqual(await bridge.stored(), []);
});

test("the size cap holds on the declared length and on a stream that declares none", { timeout: 60000 }, async (t) => {
  const bridge = await startBridge(t);
  const declared = await bridge.send("target=pane-a&name=big.bin", Buffer.alloc(MAX_FILE_BYTES + 1));
  assert.equal(declared.status, 413);
  assert.equal((await declared.json()).error.code, "file_too_large");
  const block = Buffer.alloc(1024 * 1024, 7);
  let sent = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (sent > MAX_FILE_BYTES + 3 * block.length) return controller.close();
      sent += block.length;
      controller.enqueue(block);
    },
  });
  const streamed = await fetch(`${bridge.url}/api/files?target=pane-a&name=stream.bin`, {
    method: "POST",
    headers: { ...bridge.identity, "x-moshpit-device": bridge.device, "content-type": "application/octet-stream" },
    body,
    duplex: "half",
  });
  assert.equal(streamed.status, 413);
  assert.deepEqual(await bridge.stored(), [], "no file and no directory is left");
  const exact = await bridge.send("target=pane-a&name=exact.bin", Buffer.alloc(MAX_FILE_BYTES, 1));
  assert.equal(exact.status, 200, "a file of exactly the cap is accepted");
});

test("a client that hangs up mid-upload leaves nothing behind", { timeout: 30000 }, async (t) => {
  const bridge = await startBridge(t);
  const abort = new AbortController();
  const body = new ReadableStream({
    start(controller) { controller.enqueue(Buffer.alloc(64 * 1024, 1)); },
    pull() { return new Promise(() => {}); },
  });
  const pending = fetch(`${bridge.url}/api/files?target=pane-a&name=hangup.bin`, {
    method: "POST",
    headers: { ...bridge.identity, "x-moshpit-device": bridge.device, "content-type": "application/octet-stream" },
    body,
    duplex: "half",
    signal: abort.signal,
  }).catch(() => {});
  // Wait until the bridge has begun the file, then hang up.
  for (let i = 0; i < 100 && !(await bridge.stored()).length; i++) await delay(20);
  assert.equal((await bridge.stored()).length, 1, "the upload had started");
  abort.abort();
  await pending;
  for (let i = 0; i < 100 && (await bridge.stored()).length; i++) await delay(20);
  assert.deepEqual(await bridge.stored(), []);
});

test("the route is rate limited per device", { timeout: 30000 }, async (t) => {
  const bridge = await startBridge(t);
  const results = [];
  for (let n = 0; n < 21; n++) results.push(await bridge.send(`target=pane-a&name=f${n}.txt`, "x"));
  assert.deepEqual(results.slice(0, 20).map((r) => r.status), Array(20).fill(200));
  assert.equal(results[20].status, 429);
  assert.equal((await results[20].json()).error.code, "file_rate_limited");
  assert.ok(Number(results[20].headers.get("retry-after")) >= 1);
  assert.equal((await bridge.stored()).length, 20);
});

test("a stored file cannot be read back through GET /api/upload or anywhere else", { timeout: 30000 }, async (t) => {
  const bridge = await startBridge(t);
  const saved = await (await bridge.send("target=pane-a&name=secret.txt", "private text")).json();
  // A name shaped like an image upload, in the place a file lives.
  const lookalike = await (await bridge.send("target=pane-a&name=00000000-0000-4000-8000-000000000000.png", Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]))).json();
  const uploads = path.join(bridge.stateDir, "uploads");
  const attempts = [
    saved.path,
    lookalike.path,
    path.join(uploads, "..", "files", path.basename(path.dirname(saved.path)), "secret.txt"),
    path.join(uploads, "..", "files", path.basename(path.dirname(lookalike.path)), path.basename(lookalike.path)),
    path.relative(bridge.stateDir, saved.path),
  ];
  for (const attempt of attempts) {
    const res = await bridge.get(`/api/upload?path=${encodeURIComponent(attempt)}`);
    assert.equal(res.status, 404, attempt);
    assert.ok(!(await res.text()).includes("private text"));
  }
  for (const route of ["/api/files", `/api/files?path=${encodeURIComponent(saved.path)}`, `/api/files/${encodeURIComponent(saved.path)}`]) {
    const res = await bridge.get(route);
    assert.ok([404, 405].includes(res.status), `${route} answered ${res.status}`);
    assert.ok(!(await res.text()).includes("private text"));
  }
});
