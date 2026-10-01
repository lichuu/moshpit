import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { boundaryEnv, bridgeCommand, freePort, isolatedEnv, releaseBin } from "./test-support.mjs";

const skip = releaseBin() ? false : "needs the release executable; run npm run test:release";

test("the release executable serves the embedded SPA", { skip, timeout: 20_000 }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "moshpit-release-"));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  await writeFile(path.join(dir, "password"), "pw", { mode: 0o600 });
  // An empty working directory, so nothing can come from a dist/spa on disk.
  const child = spawn(...bridgeCommand(), {
    cwd: dir,
    env: {
      ...isolatedEnv(),
      ...boundaryEnv(port),
      MOSHPIT_AUTH_MODE: "password",
      MOSHPIT_PASSWORD_FILE: path.join(dir, "password"),
      MOSHPIT_STATE_DIR: path.join(dir, "state"),
      MOSHPIT_HERDR_BIN: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    child.kill();
    await once(child, "exit").catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });
  await once(child.stdout, "data");
  const get = (pathname) => fetch(`${origin}${pathname}`, { headers: { origin } });

  const shell = await get("/");
  const html = await shell.text();
  assert.equal(shell.status, 200);
  assert.equal(shell.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(shell.headers.get("cache-control"), "no-cache, must-revalidate");
  assert.match(shell.headers.get("content-security-policy") ?? "", /default-src/);
  assert.match(html, /<div id="root">/);

  const deepLink = await get("/sessions/some-pane");
  assert.equal(deepLink.status, 200);
  assert.equal(await deepLink.text(), html, "an unknown path falls back to index.html");

  const script = html.match(/src="(\/assets\/index-[A-Za-z0-9_-]+\.js)"/)?.[1];
  assert.ok(script, "index.html names its hashed entry script");
  const asset = await get(script);
  const body = Buffer.from(await asset.arrayBuffer());
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(asset.headers.get("etag"), `"${createHash("sha256").update(body).digest("hex")}"`);

  assert.equal((await get("/..%2f..%2fetc%2fpasswd")).status, 400);
});
