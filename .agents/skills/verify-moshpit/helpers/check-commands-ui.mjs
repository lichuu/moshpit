import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// Phone behavior check: isolated bridge (own state dir, own port) in front of
// the REAL read-only herdr snapshot, driving the app on the assigned 8191.
// The composer suggestions come from the host's actual per-agent skill
// catalogs (claude: ~/.claude/skills as /<name>, pi: ~/.pi/agent/skills
// as /skill:<name>, codex: ~/.codex/skills as $<name>). No input is ever
// sent to a pane; the check only types into the draft and taps.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const { sendAdminRequest } = await import(path.join(root, "bridge/admin.mjs"));
const user = "command-ui-check";
const password = "command-ui-check-pass";
const state = await mkdtemp(path.join(tmpdir(), "moshpit-command-ui-"));
const passwordFile = path.join(state, "password");
await writeFile(passwordFile, password, { mode: 0o600 });
const userDir = homedir();
const claudeSkills = new Set(await readdir(path.join(userDir, ".claude/skills")).catch(() => []));
const piSkills = new Set(await readdir(path.join(userDir, ".pi", "agent", "skills")).catch(() => []));
assert.ok(claudeSkills.size > 0, "host has a real claude skill directory");
assert.ok(piSkills.size > 0, "host has a real pi skill directory");

const reserved = createServer();
const port = await new Promise((resolve, reject) => {
  reserved.once("error", reject);
  reserved.listen(0, "127.0.0.1", () => resolve(reserved.address().port));
});
await new Promise((resolve) => reserved.close(resolve));
const child = spawn(process.execPath, [path.join(root, "bridge/index.mjs")], {
  env: {
    ...process.env,
    MOSHPIT_PORT: String(port),
    MOSHPIT_BIND: "127.0.0.1",
    MOSHPIT_PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
    MOSHPIT_ALLOWED_AUTHORITIES: `127.0.0.1:${port}`,
    MOSHPIT_ALLOWED_ORIGINS: "http://127.0.0.1:8191",
    MOSHPIT_DEV_INSECURE: "1",
    MOSHPIT_AUTH_MODE: "password",
    MOSHPIT_PASSWORD_FILE: passwordFile,
    MOSHPIT_STATE_DIR: state,
    MOSHPIT_HERDR_BIN: "/usr/bin/herdr",
    MOSHPIT_POLL_MS: "30000",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stderr.on("data", (buf) => console.error("bridge:", String(buf).trim()));
const app = spawn(process.execPath, ["node_modules/.bin/vite", "--host", "127.0.0.1", "--port", "8191", "--strictPort"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
});
let failed = false;
const log = (ok, msg) => { console.log(ok ? `ok   ${msg}` : `FAIL ${msg}`); if (!ok) failed = true; };
const cleanup = () => { child.kill(); app.kill(); };
process.on("exit", cleanup);
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("bridge startup timed out")), 10000);
    child.stdout.once("data", () => { clearTimeout(timer); resolve(); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error("bridge exited")); });
  });
  assert.ok(port, "bridge port reserved");
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("vite startup timed out")), 30000);
    app.stdout.on("data", (buf) => { if (String(buf).includes("ready in")) { clearTimeout(timer); resolve(); } });
    app.once("exit", () => { clearTimeout(timer); reject(new Error("vite exited")); });
  });
  console.log(`ok   isolated bridge 127.0.0.1:${port}, app 127.0.0.1:8191`);
  const origin = `http://127.0.0.1:${port}`;
  const login = await fetch(`${origin}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ password }),
  });
  assert.equal(login.ok, true, "bridge login");
  const { token } = await login.json();
  // Only the private admin socket issues grants; identity alone cannot.
  const grant = await sendAdminRequest({ action: "pair", name: "command-ui" }, { stateDir: state });
  assert.ok(grant.result, "pairing grant");
  const { secret } = grant.result;
  const paired = await fetch(`${origin}/api/devices/pairing`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", origin },
    body: JSON.stringify({ secret, name: "command-ui" }),
  });
  assert.equal(paired.ok, true, "device pairing");
  const device = await paired.json();
  const deviceHeader = `${device.deviceId}.${device.deviceSecret}`;
  const apiHeaders = {
    authorization: `Bearer ${token}`,
    "x-moshpit-device": deviceHeader,
    origin,
  };
  // The bridge catalogs (not the raw directory listings) are the reference
  // for which commands are actually listed: pi resolves skill names from
  // frontmatter and drops SKILL.md files without a description.
  const catalogOf = async (kind) => {
    const res = await fetch(`${origin}/api/commands?agent=${kind}`, { headers: apiHeaders });
    const body = await res.json();
    if (!body.prefix) console.error("catalog", kind, res.status, JSON.stringify(body).slice(0, 500));
    assert.ok(body.prefix, `bridge catalog for ${kind} has a prefix`);
    assert.ok(body.commands.length > 0, `bridge catalog for ${kind} is non-empty`);
    return body;
  };
  const claude = await catalogOf("claude");
  const pi = await catalogOf("pi");
  const claudeNames = new Set(claude.commands.map((c) => c.name));
  const piNames = new Set(pi.commands.map((c) => c.name));
  log(true, `bridge catalogs: ${claude.commands.length} claude (/<name>), ${pi.commands.length} pi (/skill:<name>)`);

  // Pick a real claude agent and a real pi agent with an exact session
  // identity, computing the card label the way the app does (label.ts).
  const { paneLabel } = await import(path.join(root, "src/lib/moshpit/label.ts"));
  const snap = await (await fetch(`${origin}/api/snapshot`, { headers: apiHeaders })).json();
  const withSession = snap.agents.filter((a) => a.sessionId);
  const claudeAgent = withSession.find((a) => a.kind === "claude");
  const piAgent = withSession.find((a) => a.kind === "pi");
  assert.ok(claudeAgent && piAgent, "live herdr has a sessioned claude and pi agent");
  const claudeCard = paneLabel(claudeAgent, snap.agents).name;
  const piCard = paneLabel(piAgent, snap.agents).name;
  console.log(`ok   picked "${claudeCard}" (claude) and "${piCard}" (pi)`);

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  await page.addInitScript(({ origin, token, deviceId, deviceSecret, expiresAt }) => {
    localStorage.setItem(origin, JSON.stringify({ deviceId, deviceSecret, sessionToken: token, deviceExpiresAt: expiresAt }));
  }, { origin, token, deviceId: device.deviceId, deviceSecret: device.deviceSecret, expiresAt: device.expiresAt });
  const sends = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/api\/(submit|action)$/.test(request.url())) {
      sends.push(request.url());
    }
  });
  await page.goto(`http://127.0.0.1:8191/`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.waitForTimeout(150);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("button", { name: "Open moshpit" }).click();
  const nav = page.locator('nav[aria-label="Primary"] > button');
  await nav.nth(2).click();
  await page.getByRole("button", { name: "Add host" }).click();
  await page.getByLabel("Bridge URL").fill(`http://127.0.0.1:${port}`);
  await page.getByRole("button", { name: "Save host" }).click();
  await page.getByRole("button", { name: "Connect" }).first().click();
  await nav.nth(0).click();
  // Expand any collapsed project groups so the cards are reachable.
  for (const toggle of await page.locator('button[aria-label^="Project "][aria-expanded="false"]').all()) {
    await toggle.click();
  }
  const listbox = page.getByRole("listbox", { name: "Command suggestions" });
  const prompt = page.getByPlaceholder("Message this agent…");
  const openAgent = async (card) => {
    const back = page.getByRole("button", { name: "Back", exact: true });
    if (await back.count()) await back.click();
    for (const toggle of await page.locator('button[aria-label^="Project "][aria-expanded="false"]').all()) {
      await toggle.click();
    }
    await page.getByRole("button", { name: card, exact: true }).click();
    const chatView = page.getByRole("button", { name: "Chat" });
    if (await chatView.count()) await chatView.click();
    await prompt.waitFor({ state: "visible", timeout: 15000 });
  };
  await page.getByRole("button", { name: claudeCard }).waitFor({ timeout: 15000 });
  console.log("ok   isolated bridge host saved, connected, agents listed");

  // Claude agent: real / catalog from ~/.claude/skills.
  await openAgent(claudeCard);
  const slashButton = page.getByRole("button", { name: "Insert slash command" });
  await slashButton.waitFor({ state: "visible", timeout: 15000 });
  await prompt.click();
  await page.keyboard.insertText("/");
  await listbox.waitFor({ state: "visible", timeout: 15000 });
  const firstSkill = [...claudeNames].sort()[0];
  await page.keyboard.insertText(firstSkill.slice(0, 1));
  await page.waitForTimeout(300);
  const filtered = await listbox.locator("button[role=option]").allInnerTexts();
  log(filtered.length > 0 && filtered.some((text) => text.includes(firstSkill.slice(0, 1))), `filter narrows to names starting with "${firstSkill.slice(0, 1)}"`);
  await page.screenshot({ path: path.join(state, "suggestions-list.png") });
  // Tap-to-insert: replaces the token, preserves surrounding text, sends nothing.
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Delete");
  await page.keyboard.insertText(`please /${firstSkill.slice(0, 1)}`);
  await page.waitForTimeout(300);
  await listbox.locator("button[role=option]", { hasText: firstSkill }).first().click();
  await page.waitForTimeout(300);
  assert.equal(await prompt.inputValue(), `please /${firstSkill} `, "tap inserts the invocation with a trailing space");
  assert.equal(sends.length, 0, "selection sends nothing");
  await page.screenshot({ path: path.join(state, "suggestions-inserted.png") });
  log(true, `tap inserted "/${firstSkill}" and sent nothing`);
  // Dismissal: hidden until the token changes, then reappears for a match.
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Delete");
  await page.keyboard.insertText("/");
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "Dismiss suggestions" }).click();
  await page.waitForTimeout(300);
  assert.equal(await listbox.count(), 0, "dismissed list is hidden");
  await page.keyboard.insertText(firstSkill.slice(0, 1));
  await page.waitForTimeout(300);
  assert.equal(await listbox.count(), 1, "list reappears once the token changes");
  // URL / path text never opens the list.
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Delete");
  await page.keyboard.insertText("see https://x.com and /path/to here");
  await page.waitForTimeout(300);
  assert.equal(await listbox.count(), 0, "urls and paths do not trigger suggestions");
  await page.screenshot({ path: path.join(state, "suggestions-no-trigger.png") });

  // Pi agent: /skill: prefix. A bare / (another agent's syntax) never
  // triggers; the tappable prefix button inserts /skill: with the caret in
  // the active prefix so the list opens; tap inserts /skill:<name>.
  await openAgent(piCard);
  await page.getByRole("button", { name: "Insert slash command" }).waitFor({ state: "visible", timeout: 15000 });
  // Pi has / built-ins now, so a bare / opens the list; it must still offer
  // skills only in their /skill: form.
  await prompt.click();
  await page.keyboard.insertText("/");
  await page.waitForTimeout(300);
  await listbox.waitFor({ state: "visible", timeout: 15000 });
  const bare = await listbox.locator("button[role=option]").allInnerTexts();
  log(bare.some((text) => text.startsWith("/model")), "a bare / lists pi's built-ins");
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Delete");
  const firstPiSkill = [...piNames].sort()[0];
  await page.keyboard.insertText(`/skill:${firstPiSkill.slice(0, 1)}`);
  await page.waitForTimeout(300);
  await listbox.waitFor({ state: "visible", timeout: 15000 });
  const piOptions = await listbox.locator("button[role=option]").allInnerTexts();
  log(piOptions.length > 0 && piOptions.some((text) => text.includes(`/skill:${firstPiSkill.slice(0, 1)}`)), `pi catalog opens with /skill: and filters (${firstPiSkill} available)`);
  const exclusive = [...claudeNames].filter((name) => !piNames.has(name));
  const piOptionNames = piOptions.map((text) => text.split("\n")[0].replace(/^\//, "").replace(/^skill:/, ""));
  log(!piOptionNames.some((name) => exclusive.includes(name)), "claude-exclusive skills never leak into the pi agent");
  log(piOptions.every((text) => text.split("\n")[0].startsWith("/skill:")), "every suggested /skill: match is a /skill: command");
  await page.screenshot({ path: path.join(state, "suggestions-agent-switch.png") });
  // Tap-to-insert on pi: real /skill:<name> invocation, trailing space, no send.
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Delete");
  await page.keyboard.insertText(`please /skill:${firstPiSkill.slice(0, 1)}`);
  await page.waitForTimeout(300);
  await listbox.locator("button[role=option]", { hasText: firstPiSkill }).first().click();
  await page.waitForTimeout(300);
  assert.equal(await prompt.inputValue(), `please /skill:${firstPiSkill} `, "tap inserts the /skill: invocation with a trailing space");
  assert.equal(sends.length, 0, "selection sends nothing");
  await page.screenshot({ path: path.join(state, "suggestions-pi-inserted.png") });
  log(true, `tap inserted "/skill:${firstPiSkill}" and sent nothing`);
  // The prefix button inserts the agent's prefix with the caret in the
  // active prefix, so the list opens immediately on a pi agent.
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Delete");
  await page.getByRole("button", { name: "Insert slash command" }).click();
  await page.waitForTimeout(300);
  assert.equal(await prompt.inputValue(), "/", "prefix button inserts /, which reaches built-ins, templates and skills");
  await listbox.waitFor({ state: "visible", timeout: 15000 });
  assert.ok(await listbox.count() >= 1, "caret stays in the active prefix, list opens");
  assert.equal(sends.length, 0, "no submit or action requests were sent at any point");
  await browser.close();
  console.log(`ok   phone flow: real catalogs, filter, tap-insert, dismissal, agent switch — ${sends.length} sends`);
} finally {
  cleanup();
}
if (failed) process.exit(1);
