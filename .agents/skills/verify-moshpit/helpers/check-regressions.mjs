import assert from "node:assert/strict";
import { safeJoin } from "../../../../bridge/paths.mjs";

// Bridge: safeJoin must reject root-escaped paths. The old
// `full.startsWith(root)` check let a sibling like `spaevil` through
// because its name prefixes `spa`.
const root = "/repo/dist/spa";
assert.equal(safeJoin(root, "/assets/app-abc12345.js"), `${root}/assets/app-abc12345.js`);
assert.equal(safeJoin(root, "/"), `${root}/index.html`);
assert.equal(safeJoin(root, "/../spaevil/x.js"), null);
assert.equal(safeJoin(root, "/a/../../secret"), null);
assert.equal(safeJoin(root, "/..%2Fspaevil"), null);

// Store: event ids must stay unique across sessions. Events persist to
// localStorage while the app reloads, so two "sessions" (module instances)
// must never hand out the same id — the old session counter restarted at
// 1 and reused the persisted ids.
const sessionA = await import("../../../../src/lib/moshpit/events.ts?session=1");
const sessionB = await import("../../../../src/lib/moshpit/events.ts?session=2");
const batch = (make) =>
  ["one", "two", "three"].map((text) => make("migrate", "blocked", text).id);
const a = batch(sessionA.makeEvent);
const b = batch(sessionB.makeEvent);
for (const id of [...a, ...b]) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
assert.equal(new Set([...a, ...b]).size, 6, "ids must be unique across sessions");

console.log("ok   safeJoin rejects sibling-prefix escapes; event ids unique across reloads");
