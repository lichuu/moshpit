import test from "node:test";
import assert from "node:assert/strict";
import { createHerdr } from "./herdr.mjs";

test("demo choose wizard keeps the agent blocked until its last answer", async () => {
  const herdr = createHerdr({ bin: "" });
  let snapshot = await herdr.snapshot();
  let agent = snapshot.agents.find((candidate) => candidate.id === "accent");
  assert.equal(agent.blockedDialog.step.index, 0);

  for (let step = 0; step < 3; step += 1) {
    const dialog = agent.blockedDialog;
    await herdr.answer(agent.id, dialog.expected.token, "1");
    snapshot = await herdr.snapshot();
    agent = snapshot.agents.find((candidate) => candidate.id === "accent");
    assert.equal(agent.question[step].answer, agent.question[step].options[0].label);
    if (step < 2) {
      assert.equal(agent.status, "blocked");
      assert.equal(agent.blockedDialog.step.index, step + 1);
    } else {
      assert.equal(agent.status, "working");
      assert.equal(agent.blockedDialog, null);
    }
  }
});

test("demo blocked prompt inserts text until Enter commits it", async () => {
  const herdr = createHerdr({ bin: "" });
  await herdr.prompt("migrate", "y");
  let agent = (await herdr.snapshot()).agents.find((candidate) => candidate.id === "migrate");
  assert.equal(agent.status, "blocked");
  assert.match(agent.lines.at(-1).text, /> y$/);

  await herdr.keys("migrate", "enter");
  agent = (await herdr.snapshot()).agents.find((candidate) => candidate.id === "migrate");
  assert.equal(agent.status, "working");
});

test("demo Enter answers the block it was typed into, not an earlier turn", async () => {
  const herdr = createHerdr({ bin: "" });
  const find = async () => (await herdr.snapshot()).agents.find((candidate) => candidate.id === "auth");

  // A prompt sent while the agent was working leaves "> y" in the pane.
  await herdr.prompt("auth", "y");
  assert.ok((await find()).lines.some((item) => item.text === "> y"));

  await herdr.block("auth");
  assert.equal((await find()).status, "blocked");

  // Enter now has nothing typed into this block, so it must not reach back and
  // commit the earlier turn's text.
  await herdr.keys("auth", "enter");
  const still = await find();
  assert.equal(still.status, "blocked");
  assert.equal(still.blockedPrompt, "Should I run prisma migrate? y/n");

  // The insertion made into this block is the one Enter commits.
  await herdr.prompt("auth", "n");
  await herdr.keys("auth", "enter");
  const answered = await find();
  assert.equal(answered.status, "idle");
  assert.equal(answered.blockedPrompt, null);
});
