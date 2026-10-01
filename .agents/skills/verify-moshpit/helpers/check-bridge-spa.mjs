import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boundaryEnv, freePort, isolatedEnv, passwordEnv } from "../../../../bridge/test-support.mjs";

// The bridge serves the production build straight from dist/spa. Without a
// build there is nothing to verify, which is not the same as passing.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
if (!existsSync(path.join(root, "dist/spa/index.html"))) {
  console.log("blocked: no dist/spa build; run `npm run build` first");
  process.exit(77);
}

const port = await freePort();
const origin = `http://127.0.0.1:${port}`;
const state = await mkdtemp(path.join(tmpdir(), "moshpit-bridge-spa-"));
// An isolated bridge: loopback origin policy, a throwaway password, the demo
// herdr, and none of the caller's MOSHPIT_* settings.
const child = spawn(process.execPath, [path.join(root, "bridge/index.mjs")], {
  env: {
    ...isolatedEnv(),
    ...boundaryEnv(port),
    ...(await passwordEnv(state)),
    MOSHPIT_BIND: "127.0.0.1",
    MOSHPIT_STATE_DIR: state,
    MOSHPIT_HERDR_BIN: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", (chunk) => (stderr += chunk));

try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("bridge did not start")), 10_000);
    child.stdout.on("data", (buf) => {
      if (String(buf).includes("moshpit-bridge")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("exit", (code) => reject(new Error(`bridge exited ${code}: ${stderr.trim()}`)));
  });

  // Static navigation must load before the browser has credentials.
  const index = await fetch(`${origin}/`);
  assert.equal(index.status, 200);
  const html = await index.text();
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /<div id="root"/);
  console.log("ok   bridge serves the built SPA index without credentials");

  const manifestRes = await fetch(`${origin}/manifest.webmanifest`);
  assert.equal(manifestRes.status, 200);
  const manifest = await manifestRes.json();
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.name, "moshpit");
  console.log("ok   bridge serves the standalone manifest");

  const sw = await fetch(`${origin}/sw.js`);
  assert.equal(sw.status, 200);
  assert.match(await sw.text(), /addEventListener\(["']fetch["']/);
  console.log("ok   bridge serves sw.js");
} finally {
  // SIGTERM is asynchronous. Unlinking the state directory while the bridge
  // is still flushing lets its own mkdir recreate it after the rm, which is
  // where the stray empty moshpit-bridge-spa-* directories in /tmp come from.
  if (child.exitCode === null && child.signalCode === null) {
    child.kill();
    const gone = new Promise((resolve) => child.on("exit", resolve));
    await Promise.race([
      gone,
      new Promise((resolve) => setTimeout(resolve, 3000)).then(() => {
        child.kill("SIGKILL");
        return gone;
      }),
    ]);
  }
  await rm(state, { recursive: true, force: true });
}
