import assert from "node:assert/strict";
import { layoutFor, pairFor } from "../../../../src/lib/moshpit/layout.ts";

const tabs = ["moshpit", "inbox", "hosts"];

for (const tab of tabs) {
  const phone = layoutFor("phone", tab);
  assert.equal(phone.regime, "phone");
  assert.equal(phone.chrome, "bottom");
  assert.equal(phone.pane.kind, "single");

  const wide = layoutFor("wide", tab);
  assert.equal(wide.regime, "wide");
  assert.equal(wide.chrome, "side");
  assert.equal(wide.pane.kind, "pair");
  assert.equal(wide.pane.pair, pairFor(tab));
}

assert.equal(pairFor("moshpit"), "pit-steer");
assert.equal(pairFor("inbox"), "inbox-steer");
assert.equal(pairFor("hosts"), "hosts-settings");

console.log("ok   layoutFor 3 tabs × 2 regimes");
