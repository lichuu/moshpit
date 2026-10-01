import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect, openApp, seedHosts, loginBridge, pairBridge, type Bridge } from "../fixtures";

const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");

const herdr = `
case "$*" in
  "api snapshot"*) echo '{"result":{"snapshot":{"agents":[{"pane_id":"w1:p1","agent":"codex","agent_status":"working","cwd":"/repo/app","workspace_id":"w1","terminal_title":"codex","revision":1}]}}}' ;;
  "pane list"*) echo '{"result":{"panes":[{"pane_id":"w1:p1","label":"typist","terminal_id":"term_ty1","cwd":"/repo/app","workspace_id":"w1"}]}}' ;;
  "pane read w1:p1"*) printf '$ ' ;;
  "pane send-text "*|"pane send-keys "*)
    capture="$(dirname "$(dirname "$0")")/terminal-writes"
    printf '%s\\0' "$@" >> "$capture"
    printf '\\0' >> "$capture"
    echo '{}'
    ;;
  *) echo '{}' ;;
esac`;

async function openTerminal(page: Page, host: Bridge) {
  await openApp(page, { demo: false });
  const token = await loginBridge(page, host.url);
  await pairBridge(page, host.url, token);
  await seedHosts(page, [{
    id: "e2e", label: "E2E", transport: "tailscale", user: "",
    hostname: "127.0.0.1", port: host.port, demo: false, tailnetUrl: host.url,
  }], "e2e");
  await page.getByRole("button", { name: /typist/ }).first().click({ timeout: 20_000 });
  await page.getByRole("button", { name: "Terminal view", exact: true }).click();
  await expect(page.getByRole("status", { name: "Live PTY" })).toBeVisible({ timeout: 20_000 });
}

async function capturedWrites(host: Bridge) {
  const contents = await readFile(path.join(host.dir, "terminal-writes"), "utf8").catch(() => "");
  return contents.split("\0\0").filter(Boolean).map((record) => record.split("\0"));
}

async function savedImage(host: Bridge, prompt: string, text: string) {
  const prefix = `${text || "Please inspect this image."}\n\nAttached image on this machine: `;
  const suffix = "\nOpen this file to view the image.";
  expect(prompt.startsWith(prefix)).toBe(true);
  expect(prompt.endsWith(suffix)).toBe(true);
  const filename: unknown = JSON.parse(prompt.slice(prefix.length, -suffix.length));
  expect(typeof filename).toBe("string");
  if (typeof filename !== "string") throw new Error("The image prompt has no file path.");
  expect(path.dirname(filename)).toBe(path.join(host.dir, "state", "uploads"));
  expect(await readFile(filename)).toEqual(imageBytes);
  expect((await stat(filename)).mode & 0o777).toBe(0o600);
  expect((await stat(path.dirname(filename))).mode & 0o777).toBe(0o700);
}

// The socket only shows the pane; keys go over HTTP through one queue, so
// what reaches herdr is the text typed, in order, then Enter.
test("typing in a live terminal reaches the pane in order over HTTP", async ({ page, bridge }) => {
  const host = await bridge({ herdr });
  const socketFrames: string[] = [];
  page.on("websocket", (ws) => ws.on("framesent", (frame) => socketFrames.push(String(frame.payload))));

  await openTerminal(page, host);

  await page.getByRole("application", { name: "Pane w1:p1" }).focus();
  await page.keyboard.type("ls -a");
  await page.keyboard.press("Enter");

  const writes = async () =>
    (await host.calls()).filter((line) => /^pane send-(text|keys) /.test(line));
  await expect.poll(async () => (await writes()).at(-1)).toBe("pane send-keys w1:p1 enter");
  const typed = (await writes())
    .filter((line) => line.startsWith("pane send-text w1:p1 "))
    .map((line) => line.slice("pane send-text w1:p1 ".length))
    .join("");
  expect(typed).toBe("ls -a");
  expect(socketFrames, "nothing is typed over the socket").toEqual([]);
});

test("terminal picker, paste and drop deliver private images followed by Enter", async ({ page, bridge }, testInfo) => {
  const host = await bridge({ herdr });
  await openTerminal(page, host);
  const input = page.getByRole("textbox", { name: "Terminal input" });
  const text = "  inspect this\nkeep the spacing  ";
  await input.fill(text);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Attach image", exact: true }).click();
  await (await chooser).setFiles({ name: "picked.png", mimeType: "image/png", buffer: imageBytes });
  await expect(page.getByRole("img", { name: "Attachment preview: picked.png", exact: true })).toBeVisible();
  const screenshot = testInfo.outputPath("terminal-image-preview.png");
  await page.screenshot({ path: screenshot });
  await testInfo.attach("Terminal image preview", { path: screenshot, contentType: "image/png" });
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(input).toHaveValue("");
  await expect(page.getByRole("button", { name: "Remove image", exact: true })).toHaveCount(0);
  await expect.poll(async () => (await capturedWrites(host)).length).toBe(2);
  let writes = await capturedWrites(host);
  expect(writes[0].slice(0, 3)).toEqual(["pane", "send-text", "w1:p1"]);
  await savedImage(host, writes[0][3], text);
  expect(writes[1]).toEqual(["pane", "send-keys", "w1:p1", "enter"]);

  for (const action of ["paste", "drop"]) {
    await input.evaluate((element, { action, data }) => {
      const bytes = Uint8Array.from(atob(data), (byte) => byte.charCodeAt(0));
      const files = new DataTransfer();
      files.items.add(new File([bytes], `${action}.png`, { type: "image/png" }));
      if (action === "paste") element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: files, bubbles: true, cancelable: true }));
      else {
        element.dispatchEvent(new DragEvent("dragover", { dataTransfer: files, bubbles: true, cancelable: true }));
        element.dispatchEvent(new DragEvent("drop", { dataTransfer: files, bubbles: true, cancelable: true }));
      }
    }, { action, data: imageBytes.toString("base64") });
    await expect(page.getByRole("img", { name: `Attachment preview: ${action}.png`, exact: true })).toBeVisible();
    if (action === "drop") {
      await page.getByRole("button", { name: "Remove image", exact: true }).click();
      await expect(page.getByRole("img", { name: "Attachment preview: drop.png", exact: true })).toHaveCount(0);
      expect((await capturedWrites(host)).length).toBe(4);
    } else {
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await expect.poll(async () => (await capturedWrites(host)).length).toBe(4);
      writes = await capturedWrites(host);
      await savedImage(host, writes[2][3], "");
      expect(writes[3]).toEqual(["pane", "send-keys", "w1:p1", "enter"]);
      await expect(page.getByRole("button", { name: "Remove image", exact: true })).toHaveCount(0);
    }
  }

  const literal = "  printf '%s' \"hello\"\n  ";
  await input.fill(literal);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(input).toHaveValue("");
  await expect.poll(async () => (await capturedWrites(host)).length).toBe(6);
  expect((await capturedWrites(host)).slice(4)).toEqual([
    ["pane", "send-text", "w1:p1", literal],
    ["pane", "send-keys", "w1:p1", "enter"],
  ]);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(async () => (await capturedWrites(host)).length).toBe(7);
  expect((await capturedWrites(host))[6]).toEqual(["pane", "send-keys", "w1:p1", "enter"]);
});

test("a rejected terminal image preserves the draft and image for retry", async ({ page, bridge }) => {
  const host = await bridge({ herdr });
  await openTerminal(page, host);
  const input = page.getByRole("textbox", { name: "Terminal input" });
  await input.fill("keep this draft ");
  await page.locator('input[type="file"]').setInputFiles({ name: "invalid.png", mimeType: "image/png", buffer: Buffer.from("not an image") });
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("Choose a valid PNG, JPEG, WebP, or GIF image.", { exact: true })).toBeVisible();
  await expect(input).toHaveValue("keep this draft ");
  await expect(page.getByRole("img", { name: "Attachment preview: invalid.png", exact: true })).toBeVisible();
  expect(await capturedWrites(host)).toEqual([]);

  await page.locator('input[type="file"]').setInputFiles({ name: "retry.png", mimeType: "image/png", buffer: imageBytes });
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(input).toHaveValue("");
  await expect.poll(async () => (await capturedWrites(host)).length).toBe(2);
  const writes = await capturedWrites(host);
  await savedImage(host, writes[0][3], "keep this draft ");
  expect(writes[1]).toEqual(["pane", "send-keys", "w1:p1", "enter"]);
});
