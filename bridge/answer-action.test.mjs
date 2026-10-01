import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHerdr } from "./herdr.mjs";

const CARD = [
  "Question 1/2 (2 unanswered)",
  "How should the generated file be indented?",
  "› 1. Tabs (Recommended)  Indent code with tab characters.",
  "  2. Spaces              Indent code with space characters.",
  "",
  "tab to add notes | enter to submit answer | ←/→ to navigate questions | esc to interrupt",
].join("\n");

// The same wizard one step on: a different card, so a different signature.
const NEXT_CARD = CARD.replace("Question 1/2 (2 unanswered)", "Question 2/2 (1 unanswered)");

// An approval dialog the card parser refuses to read.
const APPROVAL = ["Allow codex to run `rm -rf build`?", "", "❯ 1. Yes", "  2. No"].join("\n");

/**
 * A herdr stand-in: `api snapshot` reports one blocked codex pane and
 * `pane read` returns whatever the screen file holds, so a test can move the
 * pane on between the poll that mints a token and the answer that spends it.
 * Writes are appended to a log the test reads back.
 */
async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "moshpit-answer-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const screen = path.join(dir, "screen");
  const writes = path.join(dir, "writes.jsonl");
  const bin = path.join(dir, "herdr-fixture");
  await writeFile(screen, CARD);
  await writeFile(writes, "");
  await writeFile(bin, `#!${process.execPath}
import {appendFileSync, readFileSync} from 'node:fs';
const a=process.argv.slice(2);
if(a[0]==='api') console.log(JSON.stringify({result:{snapshot:{agents:[{pane_id:'pane',agent:'codex',agent_status:'blocked',agent_session:{kind:'id',value:'session'},cwd:'/tmp',revision:3}]}}}));
else if(a[1]==='list') console.log(JSON.stringify({result:{panes:[{pane_id:'pane',terminal_id:'pane'}]}}));
else if(a[1]==='read') process.stdout.write(readFileSync(${JSON.stringify(screen)},'utf8'));
else if(a[1]==='send-text'||a[1]==='send-keys') {appendFileSync(${JSON.stringify(writes)}, JSON.stringify(a)+'\\n');console.log('{}');}
else console.log('{}');
`, { mode: 0o700 });
  await writeFile(path.join(dir, "package.json"), '{"type":"module"}');
  const herdr = createHerdr({ bin });
  return {
    herdr,
    show: (text) => writeFile(screen, text),
    sent: async () => (await readFile(writes, "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)),
  };
}

test("a blocked codex card publishes a choose dialog and answers with the printed digit", async (t) => {
  const { herdr, sent } = await fixture(t);
  const snap = await herdr.snapshot();
  const dialog = snap.agents[0].blockedDialog;
  assert.equal(dialog.kind, "choose");
  assert.equal(dialog.question, "How should the generated file be indented?");
  assert.deepEqual(dialog.step, { index: 0, total: 2 });

  await herdr.answer("pane", dialog.expected.token, "2");
  assert.deepEqual(await sent(), [["pane", "send-text", "pane", "2"]]);
});

test("a wrong token is refused and sends nothing", async (t) => {
  const { herdr, sent } = await fixture(t);
  const snap = await herdr.snapshot();
  await assert.rejects(
    herdr.answer("pane", `not-${snap.agents[0].blockedDialog.expected.token}`, "1"),
    /no longer on screen/,
  );
  assert.deepEqual(await sent(), []);
});

test("a key the card does not print is refused, and does not burn the question", async (t) => {
  const { herdr, sent } = await fixture(t);
  const token = (await herdr.snapshot()).agents[0].blockedDialog.expected.token;
  await assert.rejects(herdr.answer("pane", token, "9"), /no longer on screen/);
  assert.deepEqual(await sent(), []);
  // The refusal cost nothing: the same token still answers.
  await herdr.answer("pane", token, "1");
  assert.deepEqual(await sent(), [["pane", "send-text", "pane", "1"]]);
});

test("an answered card is refused a second time", async (t) => {
  const { herdr, sent } = await fixture(t);
  const token = (await herdr.snapshot()).agents[0].blockedDialog.expected.token;
  await herdr.answer("pane", token, "1");
  await assert.rejects(herdr.answer("pane", token, "1"), /no longer on screen/);
  assert.equal((await sent()).length, 1);
});

test("a token minted for a card that has left the screen sends nothing", async (t) => {
  const { herdr, show, sent } = await fixture(t);
  const token = (await herdr.snapshot()).agents[0].blockedDialog.expected.token;
  // Answered from the terminal instead; the pane is now on an approval
  // dialog. The phone still holds the card it was shown.
  await show(APPROVAL);
  await assert.rejects(herdr.answer("pane", token, "1"), /no longer on screen/);
  assert.deepEqual(await sent(), []);
});

test("a token minted for the previous wizard step sends nothing", async (t) => {
  const { herdr, show, sent } = await fixture(t);
  const token = (await herdr.snapshot()).agents[0].blockedDialog.expected.token;
  await show(NEXT_CARD);
  await assert.rejects(herdr.answer("pane", token, "1"), /no longer on screen/);
  assert.deepEqual(await sent(), []);
});

test("a dialog the parser cannot read is published as terminal, with no token", async (t) => {
  const { herdr, show } = await fixture(t);
  await herdr.snapshot();
  await show(APPROVAL);
  const dialog = (await herdr.snapshot()).agents[0].blockedDialog;
  assert.equal(dialog.kind, "terminal");
  assert.equal(dialog.question, "Allow codex to run `rm -rf build`?");
});
