import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "vite";

// Its own dependency cache: the shared node_modules/.vite belongs to the
// developer's `npm run dev`, and a different config root would re-optimize it.
const cacheDir = await mkdtemp(path.join(tmpdir(), "moshpit-start-store-"));
const server = await createServer({
  cacheDir,
  logLevel: "warn",
  server: { middlewareMode: true },
  appType: "custom",
});
const originalFetch = globalThis.fetch;

// A hung await fails the check instead of hanging the node-check run.
function within(promise, label, ms = 5000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

try {
  const { useMoshpitStore: store } = await server.ssrLoadModule("/src/lib/moshpit/store.ts");
  const access = await server.ssrLoadModule("/src/lib/moshpit/access.ts");
  const hostA = { id: "a", tailnetUrl: "http://host-a", label: "A" };
  const hostB = { id: "b", tailnetUrl: "http://host-b", label: "B" };
  const ready = (deviceId) => ({ status: "ready", deviceId, deviceExpiresAt: null });
  function reset() {
    // Writes need a paired host twice over: the store's gate for the
    // connected host, and the per-origin state every request header checks.
    access.setHostAccess(hostA.tailnetUrl, ready("device-a"));
    access.setHostAccess(hostB.tailnetUrl, ready("device-b"));
    store.setState({
      hosts: [hostA, hostB], connectedHostId: "a", hostAccess: ready("device-a"),
      agents: [], events: [], selectedAgentId: null, detailAgentId: null, focusedPaneId: null,
    });
  }
  function switchHost() {
    store.setState({
      connectedHostId: "b", hostAccess: ready("device-b"),
      selectedAgentId: "b-pane", detailAgentId: "b-pane", focusedPaneId: "b-pane",
    });
  }
  function assertHostB() {
    const state = store.getState();
    assert.equal(state.connectedHostId, "b");
    assert.equal(state.selectedAgentId, "b-pane");
    assert.equal(state.detailAgentId, "b-pane");
    assert.equal(state.focusedPaneId, "b-pane");
  }

  await test("a successful start survives a failed snapshot refresh", async () => {
    reset();
    let starts = 0;
    globalThis.fetch = async (url) => {
      if (url.endsWith("/api/action")) {
        starts++;
        return Response.json({ ok: true, paneId: "a-pane" });
      }
      return new Response("unavailable", { status: 503 });
    };
    assert.deepEqual(await within(store.getState().createAgent("/project", "pi"), "start"), { state: "started" });
    assert.equal(starts, 1);
  });

  for (const stage of ["action", "snapshot"]) {
    await test(`switching hosts during ${stage} preserves the new host's selection`, async () => {
      reset();
      const entered = Promise.withResolvers();
      const response = Promise.withResolvers();
      globalThis.fetch = async (url) => {
        if (url.endsWith(`/api/${stage}`)) {
          entered.resolve();
          return response.promise;
        }
        return Response.json(url.endsWith("/api/action")
          ? { ok: true, paneId: "a-pane" }
          : { agents: [], panes: [], kinds: [] });
      };
      const pending = store.getState().createAgent("/project", "pi");
      await within(entered.promise, `createAgent reaching /api/${stage}`);
      switchHost();
      response.resolve(Response.json(stage === "action"
        ? { ok: true, paneId: "a-pane" }
        : { agents: [], panes: [], kinds: [] }));
      assert.deepEqual(await within(pending, "start"), { state: "started" });
      assertHostB();
    });
  }

  await test("a rejected start still returns failure", async () => {
    reset();
    globalThis.fetch = async () => Response.json({ error: "Start failed" }, { status: 500 });
    assert.equal((await within(store.getState().createAgent("/project", "pi"), "start")).state, "failed");
  });

  await test("an unpaired host refuses the start before any request", async () => {
    reset();
    store.setState({ hostAccess: { status: "pairing-required", reason: "new" } });
    let requests = 0;
    globalThis.fetch = async () => {
      requests++;
      return Response.json({ ok: true, paneId: "a-pane" });
    };
    assert.equal((await within(store.getState().createAgent("/project", "pi"), "start")).state, "failed");
    assert.equal(requests, 0);
  });
} finally {
  globalThis.fetch = originalFetch;
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}
