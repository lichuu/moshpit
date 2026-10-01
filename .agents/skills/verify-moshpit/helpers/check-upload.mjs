import assert from "node:assert/strict";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { saveImage } from "../../../../bridge/upload.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const scratch = await mkdtemp(path.join(tmpdir(), "moshpit-upload-proof-"));
const fixture = await readFile(new URL("./fixtures/tiny.png", import.meta.url));
const reserve = createServer();
await new Promise((resolve) => reserve.listen(0, "127.0.0.1", resolve));
const port = reserve.address().port;
await new Promise((resolve) => reserve.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const user = "upload-proof";
const bridge = spawn(process.execPath, [path.join(root, "bridge/index.mjs")], {
  cwd: root,
  env: {
    ...process.env,
    MOSHPIT_PORT: String(port),
    MOSHPIT_TRUSTED_USER: user,
    MOSHPIT_STATE_DIR: scratch,
    MOSHPIT_HERDR_BIN: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let browser;
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Bridge startup timed out")),
      10000,
    );
    bridge.stdout.on("data", (chunk) => {
      if (String(chunk).includes("moshpit-bridge")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    bridge.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Bridge exited ${code}`));
    });
  });
  const image = {
    name: "tiny.png",
    type: "image/png",
    data: fixture.toString("base64"),
  };
  const headers = {
    "content-type": "application/json",
    "tailscale-user-login": user,
  };
  const unpaired = await fetch(`${origin}/api/action`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      kind: "prompt",
      target: "migrate",
      text: "",
      attachment: image,
    }),
  });
  assert.equal(unpaired.status, 403);
  assert.ok(
    !(await readdir(scratch)).includes("uploads"),
    "Unpaired uploads cannot write files",
  );
  await assert.rejects(
    saveImage(
      {
        ...image,
        data: Buffer.from("<svg>not a PNG</svg>").toString("base64"),
      },
      scratch,
    ),
    /valid PNG/,
  );
  await assert.rejects(
    saveImage({ ...image, type: "image/jpeg" }, scratch),
    /don't match/,
  );
  await assert.rejects(
    saveImage({ ...image, data: "A".repeat(14 * 1024 * 1024) }, scratch),
    /10 MB/,
  );
  console.log(
    "ok   unpaired, invalid, mislabeled, and oversized uploads are rejected",
  );

  browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    extraHTTPHeaders: { "tailscale-user-login": user },
  });
  const page = await context.newPage();
  await page.goto(origin, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /^migrate/ }).click();
  const composer = page.getByRole("textbox", { name: "Message agent" });
  const input = page.locator('input[type="file"]');
  await input.setInputFiles({
    name: "tiny.png",
    mimeType: "image/png",
    buffer: fixture,
  });
  await page
    .getByRole("img", { name: "Attachment preview: tiny.png", exact: true })
    .waitFor();
  await composer.fill("Please inspect this screenshot.");
  await page.route("**/api/action", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Upload test: host unavailable" }),
    }),
  );
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByText("Message wasn't sent", { exact: true }).waitFor();
  assert.equal(await composer.inputValue(), "Please inspect this screenshot.");
  await page
    .getByRole("img", { name: "Attachment preview: tiny.png", exact: true })
    .waitFor();
  await page.unroute("**/api/action");
  console.log("ok   failed upload preserves image and message for retry");

  const response = page.waitForResponse(
    (res) =>
      res.url().endsWith("/api/action") && res.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const sent = await response;
  assert.equal(sent.status(), 200);
  const result = await sent.json();
  assert.deepEqual(
    await readFile(result.attachment.path),
    fixture,
    "Host file has the exact uploaded bytes",
  );
  assert.equal((await stat(result.attachment.path)).mode & 0o777, 0o600);
  await page.waitForFunction(
    () =>
      document.querySelector('textarea[aria-label="Message agent"]').value ===
      "",
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Remove image", exact: true })
      .count(),
    0,
  );
  const snapshot = await fetch(`${origin}/api/snapshot`, { headers }).then(
    (res) => res.json(),
  );
  const output = snapshot.agents
    .find((agent) => agent.id === "migrate")
    .lines.map((line) => line.text)
    .join("\n");
  assert.ok(
    output.includes("Please inspect this screenshot.") &&
      output.includes(result.attachment.path),
    "Agent prompt contains the message and host image path",
  );
  console.log(
    "ok   browser upload writes exact bytes privately and delivers the image path with the prompt",
  );

  await composer.evaluate((element, base64) => {
    const data = new DataTransfer();
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    data.items.add(new File([bytes], "pasted.png", { type: "image/png" }));
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, fixture.toString("base64"));
  await page
    .getByRole("img", { name: "Attachment preview: pasted.png", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Remove image", exact: true }).click();
  await page.locator(".composer-wrap").evaluate((element, base64) => {
    const data = new DataTransfer();
    data.items.add(
      new File(
        [Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))],
        "dropped.png",
        { type: "image/png" },
      ),
    );
    element.dispatchEvent(
      new DragEvent("drop", {
        dataTransfer: data,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, fixture.toString("base64"));
  await page
    .getByRole("img", { name: "Attachment preview: dropped.png", exact: true })
    .waitFor();
  const imageOnly = page.waitForResponse(
    (res) =>
      res.url().endsWith("/api/action") && res.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const imageResult = await (await imageOnly).json();
  assert.deepEqual(await readFile(imageResult.attachment.path), fixture);
  console.log(
    "ok   clipboard paste, removal, drag-and-drop, and image-only send",
  );
  await page.screenshot({ path: path.join(scratch, "uploaded-image.png") });
  console.log(`Upload evidence: ${scratch}`);
} finally {
  await browser?.close();
  bridge.kill();
  await new Promise((resolve) => {
    if (bridge.exitCode !== null) resolve();
    else bridge.once("exit", resolve);
  });
}
