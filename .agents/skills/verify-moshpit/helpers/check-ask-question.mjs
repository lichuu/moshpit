// One-shot check: chat mode renders ask-user question cards and a tap
// answers them. Same launch/doctor/cleanup contract as the drive scenarios.
// The demo agent asks a three-step wizard, so the card carries all three
// questions and only the step the dialog is on is tappable.
import { chromium } from "playwright";

const port = process.argv[2] ?? "8188";
const out = process.argv[3];
const b = await chromium.launch();
let failed = false;
const log = (ok, msg) => {
  console.log(ok ? `ok   ${msg}` : `FAIL ${msg}`);
  if (!ok) failed = true;
};

const WIZARD = [
  {
    text: "Which deployment experience should we design first?",
    options: ["Own machine (Recommended)", "Remote server", "Both equally"],
  },
  {
    text: "How should the machines talk to each other?",
    options: ["Require Tailscale (Recommended)", "Public ports"],
  },
  {
    text: "What is the first step after choosing?",
    options: ["One command, then browser (Recommended)", "Full setup docs"],
  },
];

const row = (p, question, label) =>
  p.getByRole("button", { name: `Answer ${question.text}: ${label}` });

async function onboard(p) {
  for (let i = 0; i < 2; i++)
    await p.getByRole("button", { name: "Next", exact: true }).click();
  await p.getByRole("button", { name: "Open moshpit" }).click();
}

const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
const p = await ctx.newPage();
await p.goto(`http://127.0.0.1:${port}/?demo=1`, { waitUntil: "networkidle" });
await onboard(p);
await p.waitForTimeout(300);

// Pending question card on the blocked demo agent.
await p.getByRole("button", { name: "postcard-ui" }).click();
await p.waitForTimeout(400);
log(
  (await p.getByText("waiting on you").count()) === 1,
  "pending question card shows its waiting header",
);
for (const question of WIZARD)
  log(
    (await p.getByText(question.text).count()) >= 1,
    `card renders "${question.text}"`,
  );

// Only the step the dialog is on prints keys, so only it can be tapped: a
// positional guess against a later question would answer the wrong one.
const first = WIZARD[0];
for (const [index, label] of first.options.entries()) {
  const option = row(p, first, label);
  log((await option.count()) === 1, `step 1 offers "${label}"`);
  log(
    (await option.innerText()).includes(String(index + 1)),
    `"${label}" shows printed key ${index + 1}`,
  );
}
const laterRow = row(p, WIZARD[1], WIZARD[1].options[0]);
log(
  (await laterRow.count()) === 1 && (await laterRow.isDisabled()) === true,
  "a step the dialog has not reached is listed but not tappable",
);
if (out) await p.screenshot({ path: `${out}/01-question-pending.png` });

// Each tap answers its own step and hands the card the next one. The agent
// stays blocked until the last answer, which is what keeps the Inbox row open.
for (const [index, question] of WIZARD.entries()) {
  await row(p, question, question.options[0]).click();
  await p.waitForTimeout(400);
  const last = index === WIZARD.length - 1;
  log(
    (await p.getByText("waiting on you").count()) === (last ? 0 : 1),
    last ? "card stops waiting after the last answer" : `card still waits at step ${index + 2}`,
  );
  if (!last)
    log(
      (await row(p, WIZARD[index + 1], WIZARD[index + 1].options[0]).isDisabled()) === false,
      `step ${index + 2} became tappable`,
    );
}
log(
  (await p.getByText("working", { exact: true }).count()) >= 1,
  "the last answer starts the agent working",
);
for (const question of WIZARD)
  log(
    (await row(p, question, question.options[0]).isDisabled()) === true,
    `"${question.text}" is not tappable once answered`,
  );
log(
  (await p.getByText(`Answered: ${first.options[0]}`).count()) === 1,
  "the resolved card shows the answer each step was given",
);
if (out) await p.screenshot({ path: `${out}/02-question-sent.png` });

// Resolved question card on the working demo agent.
await p.getByRole("button", { name: "Back" }).click();
await p.waitForTimeout(300);
await p.getByRole("button", { name: "auth-rewrite" }).click();
await p.waitForTimeout(400);
log(
  (await p.getByText("Answered: rotate on use").count()) === 1,
  "resolved card shows the recorded answer",
);
const resolvedOption = p.getByRole("button", {
  name: "Answer Which refresh strategy?: rotate on use",
});
log((await resolvedOption.count()) === 1, "resolved card keeps the option list");
log(
  (await resolvedOption.isDisabled()) === true,
  "resolved card options are not tappable",
);
if (out) await p.screenshot({ path: `${out}/03-question-resolved.png` });

await b.close();
process.exit(failed ? 1 : 0);
