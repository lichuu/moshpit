import { chromium } from "playwright";

const port = process.argv[2] ?? "8188";
const out = process.argv[3];
const b = await chromium.launch();
let failed = false;
const log = (ok, msg) => {
  console.log(ok ? `ok   ${msg}` : `FAIL ${msg}`);
  if (!ok) failed = true;
};

async function onboard(p) {
  for (let i = 0; i < 2; i++)
    await p.getByRole("button", { name: "Next", exact: true }).click();
  await p.getByRole("button", { name: "Open moshpit" }).click();
}

const nav = (p) => p.locator('nav[aria-label="Primary"] > button');

{
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  await p.goto(`http://127.0.0.1:${port}/?demo=1`, {
    waitUntil: "networkidle",
  });
  await onboard(p);
  await p.waitForTimeout(300);

  const buttons = nav(p);
  log((await buttons.count()) === 3, "wide rail has 3 targets");
  const box = await p.locator('nav[aria-label="Primary"]').boundingBox();
  log(box && box.x < 40 && box.width < 280, "wide rail is a left column");
  log(
    (await p.getByText("migrate", { exact: true }).count()) > 0 &&
      (await p
        .getByPlaceholder(/Type y, n, or a reply|Prompt this agent|Message this agent…/)
        .count()) > 0,
    "pit pair shows agent list and steer composer",
  );

  await p.getByRole("button", { name: "Terminal view" }).click();
  await p.waitForTimeout(200);
  const terminal = await p
    .getByRole("application", { name: /^Pane / })
    .boundingBox();
  log(
    Boolean(terminal && terminal.x > 300),
    "agent Terminal replaces only the detail pane",
  );

  await buttons.nth(2).click();
  await p.waitForTimeout(200);
  const demo = await p.getByText("Demo herdr").first().boundingBox();
  const settings = await p.getByText("Appearance", { exact: true }).boundingBox();
  log(
    Boolean(demo && settings && settings.x > demo.x + 200),
    "hosts two columns: cards left, settings right",
  );

  await p.getByRole("button", { name: "Jump to agent" }).click();
  await p.waitForTimeout(200);
  const sheet = p.getByText("Jump to");
  const sheetBox = await sheet.boundingBox();
  log(
    Boolean(sheetBox && sheetBox.y > 80 && sheetBox.y < 500),
    "jump opens as a centered dialog",
  );
  await p.getByText("migrate", { exact: true }).click();
  await p.getByRole("button", { name: "Chat view" }).click();
  await p.getByPlaceholder(/Type y, n, or a reply|Prompt this agent|Message this agent…/).waitFor({
    state: "visible",
  });
  log(
    (await buttons.nth(0).getAttribute("aria-current")) === "page",
    "wide jump opens the selected agent in the moshpit pair",
  );
  if (out) await p.screenshot({ path: `${out}-wide.png` });
  await ctx.close();
}

{
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  const p = await ctx.newPage();
  await p.goto(`http://127.0.0.1:${port}/?demo=1`, {
    waitUntil: "networkidle",
  });
  await onboard(p);
  await p.waitForTimeout(300);
  const box = await p.locator('nav[aria-label="Primary"]').boundingBox();
  log(box && box.y > 700 && box.height < 90, "phone keeps a bottom nav");
  const buttons = nav(p);
  const lastButton = await buttons.last().boundingBox();
  const firstButton = await buttons.first().boundingBox();
  const middleButton = await buttons.nth(1).boundingBox();
  log(
    (await buttons.count()) === 3 &&
      Boolean(
        box &&
        firstButton &&
        middleButton &&
        lastButton &&
        Math.abs(firstButton.width - middleButton.width) < 1 &&
        Math.abs(middleButton.width - lastButton.width) < 1 &&
        lastButton.x + lastButton.width <= box.x + box.width,
      ),
    "phone nav has 3 equal-width targets",
  );
  log(
    (await p
      .getByPlaceholder(/Type y, n, or a reply|Prompt this agent|Message this agent…/)
      .count()) === 0,
    "phone moshpit tab has no steer composer",
  );
  if (out) await p.screenshot({ path: `${out}-phone.png` });
  await ctx.close();
}

await b.close();
process.exit(failed ? 1 : 0);
