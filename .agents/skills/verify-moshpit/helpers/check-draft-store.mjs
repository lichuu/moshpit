import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "playwright";

const server = await createServer({
  configFile: false,
  appType: "custom",
  optimizeDeps: { noDiscovery: true, include: ["react", "zod"] },
  server: { host: "127.0.0.1", port: 0 },
});
server.middlewares.use("/draft-test", (_request, response) => {
  response.setHeader("Content-Type", "text/html");
  response.end("<!doctype html><title>Draft store verification</title>");
});
await server.listen();
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`${server.resolvedUrls.local[0]}draft-test`);
  const result = await page.evaluate(async () => {
    const { draftStore, listDrafts } =
      await import("/src/lib/moshpit/drafts.ts");
    const first = draftStore(["host", "session", "conversation"]);
    first.update({
      text: "first",
      attachment: new File(["image bytes"], "draft.png", { type: "image/png" }),
    });
    await first.flush();
    const revision = first.getSnapshot().draft.revision;
    first.markSubmitting("one");
    first.update({ text: "newer typing" });
    first.settle({ requestId: "one", state: "delivered" }, revision);
    const newerPreserved = first.getSnapshot().draft.text;
    first.markSubmitting("two");
    first.settle(
      { requestId: "two", state: "failed", message: "offline" },
      first.getSnapshot().draft.revision,
    );
    const failedPreserved = first.getSnapshot().draft.text;
    first.markSubmitting("three");
    await first.flush();
    const terminal = draftStore(["host", "session", "terminal"]);
    terminal.update({ text: "terminal draft" });
    await terminal.flush();
    const other = draftStore(["host", "other", "conversation"]);
    other.update({ text: "old session" });
    await other.flush();
    const clear = draftStore(["host", "clear", "conversation"]);
    clear.update({ text: "clear me" });
    clear.markSubmitting("clear");
    clear.settle(
      { requestId: "clear", state: "queued" },
      clear.getSnapshot().draft.revision,
    );
    await clear.flush();
    return {
      newerPreserved,
      failedPreserved,
      cleared: clear.getSnapshot().draft.text,
      recovered: (await listDrafts()).length,
    };
  });
  assert.deepEqual(result, {
    newerPreserved: "newer typing",
    failedPreserved: "newer typing",
    cleared: "",
    recovered: 3,
  });
  await page.reload();
  const restored = await page.evaluate(async () => {
    const { draftStore } = await import("/src/lib/moshpit/drafts.ts");
    const first = draftStore(["host", "session", "conversation"]);
    await first.flush();
    const draft = first.getSnapshot().draft;
    const terminal = draftStore(["host", "session", "terminal"]);
    await terminal.flush();
    const hydration = draftStore(["host", "other", "conversation"]);
    hydration.update({ text: "edit before hydration" });
    await hydration.flush();
    return {
      text: draft.text,
      state: draft.submission.state,
      name: draft.attachment.name,
      bytes: await draft.attachment.text(),
      terminal: terminal.getSnapshot().draft.text,
      hydration: hydration.getSnapshot().draft.text,
    };
  });
  assert.deepEqual(restored, {
    text: "newer typing",
    state: "unknown",
    name: "draft.png",
    bytes: "image bytes",
    terminal: "terminal draft",
    hydration: "edit before hydration",
  });
  const blocked = await browser.newPage();
  await blocked.addInitScript(() =>
    Object.defineProperty(window, "indexedDB", {
      get() {
        throw new Error("storage blocked");
      },
    }),
  );
  await blocked.goto(`${server.resolvedUrls.local[0]}draft-test`);
  const memory = await blocked.evaluate(async () => {
    const { draftStore } = await import("/src/lib/moshpit/drafts.ts");
    const store = draftStore(["blocked", "session", "conversation"]);
    store.update({ text: "keep me" });
    await store.flush();
    return store.getSnapshot();
  });
  assert.equal(memory.draft.text, "keep me");
  assert.match(memory.error, /only saved in memory/);
  console.log(
    "Draft persistence: passed revision safety, failed send, restart, attachments, hydration, mode isolation, recovery and storage failure.",
  );
} finally {
  await browser.close();
  await server.close();
}
