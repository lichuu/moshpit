import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile, readdir, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright";

const dir = await mkdtemp(path.join(tmpdir(), "moshpit-chat-upload-"));
const session = path.join(dir, "session.jsonl");
const bin = path.join(dir, "herdr-fixture.mjs");
await writeFile(session, "");
await writeFile(bin, `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'api') console.log(JSON.stringify({result:{snapshot:{agents:[{pane_id:'pane',agent:'codex',agent_status:'idle',agent_session:{kind:'path',value:${JSON.stringify(session)}},cwd:'/fixture'}]}}}));
else if (args[1] === 'send-text') {
  appendFileSync(${JSON.stringify(session)}, JSON.stringify({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:args[3]}]}})+'\\n');
  console.log('{}');
} else console.log('{}');
`, { mode: 0o700 });
const bridge = spawn(process.execPath, ["bridge/index.mjs"], {
  env: { ...process.env, MOSHPIT_PORT: "0", MOSHPIT_BIND: "127.0.0.1", MOSHPIT_PASSWORD: "upload-test", MOSHPIT_TRUSTED_USER: "", MOSHPIT_STATE_DIR: dir, MOSHPIT_HERDR_BIN: bin },
  stdio: ["ignore", "pipe", "pipe"],
});
const exited = once(bridge, "exit");
let vite;
let browser;
try {
  await once(bridge.stdout, "data");
  const port = execFileSync("ss", ["-ltnp"], { encoding: "utf8" }).split("\n").find(row => row.includes(`pid=${bridge.pid},`))?.match(/127\.0\.0\.1:(\d+)/)?.[1];
  assert.ok(port);
  const origin = `http://127.0.0.1:${port}`;
  const { token } = await fetch(`${origin}/api/login`, { method: "POST", body: JSON.stringify({ password: "upload-test" }) }).then(r => r.json());
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const { deviceId } = await fetch(`${origin}/api/pair`, { method: "POST", headers, body: "{}" }).then(r => r.json());
  vite = await createServer({ server: { host: "127.0.0.1", port: 0 } });
  await vite.listen();
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(15000);
  page.on("response", (r) => { if (r.status() >= 400) console.log("HTTP", r.status(), r.url()); });
  await page.addInitScript(({ origin, token, deviceId }) => {
    if (!localStorage.getItem("moshpit-v1")) localStorage.setItem("moshpit-v1", JSON.stringify({ version: 0, state: {
      onboarded: true, connectedHostId: "upload-host", bridgeDeviceId: deviceId,
      hosts: [{ id: "upload-host", label: "Upload test", tailnetUrl: origin, demo: false }],
      bridgeTokens: { [origin]: token },
    } }));
  }, { origin, token, deviceId });
  await page.goto(vite.resolvedUrls.local[0]);
  await page.getByRole("button", { name: /^codex/ }).click();
  const input = page.locator('input[type="file"]');
  const fixture = await readFile(new URL("./fixtures/tiny.png", import.meta.url));
  await input.setInputFiles({ name: "tiny.png", mimeType: "image/png", buffer: fixture });
  const composer = page.getByRole("textbox", { name: "Message agent" });
  await composer.fill("Look at this screenshot");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const image = page.locator('.conversation img[alt="Uploaded image"]');
  await image.waitFor();
  await page.waitForFunction(() => {
    const image = document.querySelector('.conversation img');
    return image?.complete && image.naturalWidth > 0;
  });
  assert.equal(await composer.inputValue(), "");
  assert.ok(!(await page.locator(".conversation").innerText()).includes("Attached image on this machine:"));
  const filename = path.join(dir, "uploads", (await readdir(path.join(dir, "uploads")))[0]);
  const endpoint = `${origin}/api/upload?${new URLSearchParams({ path: filename })}`;
  assert.equal((await fetch(endpoint)).status, 401, "Image reads require authentication");
  const response = await fetch(endpoint, { headers });
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), fixture);
  for (const invalid of [session, path.join(dir, "uploads", "../devices.json"), filename + ".svg"]) {
    assert.equal((await fetch(`${origin}/api/upload?${new URLSearchParams({ path: invalid })}`, { headers })).status, 404);
  }
  const link = path.join(dir, "uploads", "00000000-0000-0000-0000-000000000000.png");
  await symlink(session, link);
  assert.equal((await fetch(`${origin}/api/upload?${new URLSearchParams({ path: link })}`, { headers })).status, 404);
  const opened = page.waitForEvent("popup");
  await page.getByRole("link", { name: "Open uploaded image" }).click();
  await (await opened).close();
  await page.reload();
  await page.getByRole("button", { name: /^codex/ }).click();
  await image.waitFor();
  await page.waitForFunction(() => document.querySelector('.conversation img')?.naturalWidth > 0);
  assert.ok(await image.evaluate(el => el.getBoundingClientRect().right <= innerWidth), "Preview fits phone width");
  await rm(filename);
  await page.reload();
  await page.getByRole("button", { name: /^codex/ }).click();
  await page.getByText("Image unavailable", { exact: true }).waitFor();
  console.log("Chat upload: native send, inline preview, open, reload, missing image, authentication and traversal checks passed");
} finally {
  await browser?.close();
  await vite?.close();
  bridge.kill();
  await exited;
  await rm(dir, { recursive: true, force: true });
}
