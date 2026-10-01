import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const server = await createServer({ server: { host: '127.0.0.1', port: 0 } });
await server.listen();
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  let socket;
  let connections = 0;
  await page.routeWebSocket(/\/pty\?/, ws => { socket = ws; connections++; ws.send(JSON.stringify({ dump: 'initial terminal output' })); });
  await page.goto(`${server.resolvedUrls.local[0]}?demo=1`);
  const result = await page.evaluate(async () => {
    const { mergeSession } = await import('/src/lib/moshpit/session.ts');
    const entry = (id, text) => ({ id, turnId: 't', kind: 'message', role: 'assistant', text });
    const previous = { kind: 'available', agentId: 'pane', sessionId: 'session', entries: [entry('old', 'abandoned branch')], cursor: 'old', before: 'older', reset: false, capabilities: { inputModes: ['send'], stop: false, fit: false } };
    const reset = { ...previous, entries: [entry('new', 'active branch')], cursor: 'new', before: null, reset: true };
    return mergeSession(previous, reset, true);
  });
  assert.deepEqual(result.entries.map(e => e.text), ['active branch'], 'Reset during pagination replaces the abandoned branch');
  assert.equal(result.cursor, 'new');

  for (let i = 0; i < 2; i++) await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("button", { name: "Open moshpit" }).click();

  await page.route('**/api/snapshot', route => route.fulfill({ status: 503, body: '{}' }));
  await page.evaluate(async () => {
    const { useMoshpitStore } = await import('/src/lib/moshpit/store.ts');
    const s = useMoshpitStore.getState();
    useMoshpitStore.setState({ onboarded: true, connectedHostId: 'review-host', bridgeDeviceId: 'review-device', hosts: [{ ...s.hosts[0], id: 'review-host', demo: false, tailnetUrl: location.origin }], selectedAgentId: 'migrate', detailAgentId: 'migrate', focusedPaneId: 'w1:p2', detailView: 'terminal', herdrRunning: true });
  });
  const terminal = page.getByRole('application');
  await terminal.getByText('initial terminal output', { exact: true }).waitFor({ timeout: 3000 });
  const input = page.getByRole('textbox', { name: 'Terminal input', exact: true });
  await input.fill('preserve my draft');
  socket.send(JSON.stringify({ dump: 'output while typing' }));
  await terminal.getByText('output while typing', { exact: true }).waitFor({ timeout: 2000 });
  assert.equal(await input.inputValue(), 'preserve my draft');
  assert.equal(await input.evaluate(e => e === document.activeElement), true);
  await terminal.evaluate(el => {
    const node = el.querySelector('pre');
    const range = document.createRange(); range.selectNodeContents(node);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  socket.send(JSON.stringify({ dump: 'output after selection' }));
  await page.waitForTimeout(350);
  assert.equal(await terminal.innerText(), 'output while typing');
  await page.evaluate(() => { getSelection().removeAllRanges(); document.dispatchEvent(new Event('selectionchange')); });
  await terminal.getByText('output after selection', { exact: true }).waitFor({ timeout: 2000 });
  await input.focus();
  socket.close();
  await page.waitForFunction(() => document.querySelector('[role="application"]')?.textContent.includes('initial terminal output'));
  assert.ok(connections >= 2, 'Socket reconnects while composer retains focus');
  let heldHistory;
  let resetSent = false;
  let branchChanged = false;
  const entry = (id, text) => ({ id, turnId: 't', kind: 'message', role: 'assistant', text });
  const feed = { kind: 'available', agentId: 'migrate', sessionId: 'test-session', capabilities: { inputModes: ['send'], stop: false, fit: false } };
  await page.route('**/api/session?*', async route => {
    const query = new URL(route.request().url()).searchParams;
    if (query.has('before')) { heldHistory = route; branchChanged = true; return; }
    const reset = branchChanged && !resetSent;
    const entries = reset ? [entry('new', 'Active branch answer')] : query.has('after') ? [] : [entry('old', 'Abandoned branch answer')];
    resetSent ||= reset;
    await route.fulfill({ json: { ...feed, entries, cursor: branchChanged ? 'new' : 'old', before: branchChanged ? null : 'older', reset } });
  });
  await page.getByRole('button', { name: 'Chat view', exact: true }).click();
  await page.getByText('Abandoned branch answer', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Load older history', exact: true }).click();
  await page.getByText('Active branch answer', { exact: true }).waitFor({ timeout: 3000 });
  assert.ok(heldHistory);
  await heldHistory.fulfill({ json: { ...feed, entries: [entry('ancient', 'Stale older history')], cursor: 'old', before: null, reset: false } });
  await page.waitForTimeout(700);
  assert.equal(await page.getByText('Stale older history', { exact: true }).count(), 0, 'Late pagination cannot resurrect a branch after a polling reset');
  assert.equal(await page.getByText('Active branch answer', { exact: true }).count(), 1);
  console.log('Session review: reset, stale pagination, live typing, selection preservation and focused reconnect passed');
} finally { await browser.close(); await server.close(); }
