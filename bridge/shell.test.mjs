import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHerdr } from './herdr.mjs';
import { boundaryEnv, bridgeCommand, freePort, isolatedEnv, pairDevice, passwordEnv } from './test-support.mjs';

// A stateful herdr stand-in: panes persist in a JSON file so the bridge's
// per-call spawns see one coherent workspace, like herdr's does.
const FIXTURE = `#!${process.execPath}
import { readFile, writeFile } from 'node:fs/promises';
const state = JSON.parse(await readFile(process.env.HERDR_STATE, 'utf8'));
const a = process.argv.slice(2);
const log = (row) => import('node:fs').then(({ appendFileSync }) => appendFileSync(process.env.REVIEW_WRITES, JSON.stringify(row) + '\\n'));
const out = (o) => console.log(JSON.stringify({ id: 'fixture', result: o }));
if (a[0] === 'api') {
  out({ snapshot: { agents: state.panes.filter(p => p.agent).map(p => ({ pane_id: p.pane_id, agent: p.agent, agent_status: 'idle', cwd: p.cwd, tab_id: p.tab, workspace_id: p.workspace_id })) } });
} else if (a[0] === 'pane' && a[1] === 'list') {
  out({ panes: state.panes });
} else if (a[0] === 'pane' && a[1] === 'read') {
  console.log('output of ' + a[2] + '\\n');
} else if (a[0] === 'pane' && a[1] === 'layout') {
  out({ layout: { area: { width: 80, height: 24 } } });
} else if (a[0] === 'pane' && a[1] === 'close') {
  state.panes = state.panes.filter(p => p.pane_id !== a[2]);
  await writeFile(process.env.HERDR_STATE, JSON.stringify(state));
  await log(a);
  console.log('{}');
} else if (a[0] === 'pane' && (a[1] === 'send-text' || a[1] === 'send-keys')) {
  await log(a);
  console.log('{}');
} else if (a[0] === 'pane' && a[1] === 'rename') {
  // Real herdr keeps a pane rename as the pane's own label in pane list.
  state.panes = state.panes.map(p => p.pane_id === a[2] ? { ...p, label: a[3] } : p);
  await writeFile(process.env.HERDR_STATE, JSON.stringify(state));
  await log(a);
  console.log('{}');
} else if (a[0] === 'tab' && a[1] === 'create') {
  let cwd = '', workspace = '', label = '', noFocus = false;
  for (let i = 2; i < a.length; i++) {
    if (a[i] === '--cwd') cwd = a[++i];
    else if (a[i] === '--workspace') workspace = a[++i];
    else if (a[i] === '--label') label = a[++i];
    else if (a[i] === '--no-focus') noFocus = true;
  }
  const id = 'w0:p' + state.n++;
  // As in herdr 0.8.2: --label names the tab; the new pane has no label.
  state.panes.push({ pane_id: id, cwd, label: '', tabLabel: label, workspace_id: workspace || 'w0', tab: 'w0:t' + id });
  await writeFile(process.env.HERDR_STATE, JSON.stringify(state));
  await log(['tab', 'create', cwd, workspace, label, noFocus]);
  out({ root_pane: { pane_id: id } });
} else if (a[0] === 'worktree') {
  out({});
} else {
  console.log('{}');
}
`;

test('companion shell: create, reuse, coalesce, guards, and close', { timeout: 30000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'moshpit-shell-'));
  const log = path.join(dir, 'writes.jsonl');
  const state = path.join(dir, 'herdr-state.json');
  const bin = path.join(dir, 'herdr-fixture');
  await writeFile(log, '');
  await writeFile(state, JSON.stringify({
    n: 100,
    panes: [
      { pane_id: 'w0:pA', agent: 'codex', cwd: '/tmp/ws1', workspace_id: 'w0', tab: 'w0:tA', label: '' },
      { pane_id: 'w0:pUnmanaged', cwd: '/tmp/private', workspace_id: 'w0', tab: 'w0:tOther', label: '' },
    ],
  }));
  await writeFile(bin, FIXTURE, { mode: 0o700 });
  await writeFile(path.join(dir, 'package.json'), '{"type":"module"}');
  // The restart below rebinds the same port, so one configured authority and
  // public origin cover both runs.
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  async function boot() {
    const child = spawn(...bridgeCommand(), {
      env: {
        ...isolatedEnv(),
        ...boundaryEnv(port),
        MOSHPIT_BIND: '127.0.0.1',
        ...await passwordEnv(dir),
        MOSHPIT_STATE_DIR: path.join(dir, 'state'),
        MOSHPIT_HERDR_BIN: bin,
        HERDR_STATE: state,
        REVIEW_WRITES: log,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await once(child.stdout, 'data');
    return child;
  }
  let child = await boot();
  t.after(async () => { child.kill(); await once(child, 'exit').catch(() => {}); await rm(dir, { recursive: true, force: true }); });
  const login = await fetch(`${url}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: url }, body: JSON.stringify({ password: 'review-pass' }) }).then(r => r.json());
  let headers = { 'content-type': 'application/json', origin: url, authorization: `Bearer ${login.token}`, 'x-moshpit-device': 'review' };
  headers['x-moshpit-device'] = await pairDevice(url, headers, { stateDir: path.join(dir, 'state') });
  const rows = async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const clearLog = () => writeFile(log, '');
  const post = (route, body) => fetch(`${url}${route}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const snapshot = () => fetch(`${url}/api/snapshot`, { headers }).then(r => r.json());
  const openShell = (cwd) => post('/api/action', { kind: 'open-shell', cwd });

  // Authenticated but unpaired requests never reach herdr.
  const unpairedRes = await fetch(`${url}/api/action`, { method: 'POST', headers: { ...headers, 'x-moshpit-device': 'never-paired' }, body: JSON.stringify({ kind: 'open-shell', cwd: '/tmp/ws1' }) });
  assert.equal(unpairedRes.status, 403);

  // Create in an existing workspace: tab create carries the workspace flag.
  let res = await openShell('/tmp/ws1');
  assert.equal(res.status, 200);
  const first = await res.json();
  assert.match(first.paneId, /^w0:p\d+$/);
  const created = (await rows()).filter(r => r[0] === 'tab');
  assert.equal(created.length, 1);
  assert.equal(created[0][2], '/tmp/ws1');
  assert.equal(created[0][3], 'w0');
  assert.equal(created[0][4], 'moshpit shell');
  assert.equal(created[0][5], true, 'shell tabs open unfocused');

  // The snapshot exposes the shell without pretending it is an agent.
  const snap = await snapshot();
  const shellRow = snap.shells.find(s => s.id === first.paneId);
  assert.deepEqual(shellRow, { id: first.paneId, cwd: '/tmp/ws1', alive: true });
  assert.ok(!snap.agents.some(a => a.id === first.paneId), 'shell is not an agent');

  // A repeat open (even with a trailing slash) reuses the pane.
  await clearLog();
  const again = await openShell('/tmp/ws1/');
  assert.equal(again.status, 200);
  assert.equal((await again.json()).paneId, first.paneId);
  assert.equal((await rows()).filter(r => r[0] === 'tab').length, 0);

  // Concurrent opens for a new cwd coalesce into one tab.
  await clearLog();
  const [c1, c2] = await Promise.all([openShell('/tmp/ws2'), openShell('/tmp/ws2')]);
  assert.equal(c1.status, 200);
  assert.equal(c2.status, 200);
  assert.equal((await c1.json()).paneId, (await c2.json()).paneId);
  assert.equal((await rows()).filter(r => r[0] === 'tab').length, 1, 'one tab for the race');

  // Raw terminal writes land on the shell pane only.
  await clearLog();
  const sub = await post('/api/submit', { id: randomUUID(), target: first.paneId, sessionId: `unresolved:${first.paneId}`, mode: 'terminal', text: 'echo hi' });
  assert.equal(sub.status, 200);
  assert.equal((await sub.json()).state, 'delivered');
  await new Promise(r => setTimeout(r, 300));
  const writes = await rows();
  assert.ok(writes.some(r => r[0] === 'pane' && r[1] === 'send-text' && r[2] === first.paneId), 'text went to the shell pane');
  assert.ok(writes.some(r => r[0] === 'pane' && r[1] === 'send-keys' && r[2] === first.paneId && r[3] === 'enter'), 'enter followed the text');
  assert.ok(!writes.some(r => r[2] === 'w0:pA'), 'the agent pane received nothing');
  const keys = await post('/api/action', { kind: 'keys', target: first.paneId, keys: 'esc' });
  assert.equal(keys.status, 200);
  assert.ok((await rows()).some(r => r[1] === 'send-keys' && r[2] === first.paneId && r[3] === 'esc'));

  // The agent guards stay intact: no session identity means no prompt path.
  // /api/submit guard failures are failed receipts, not transport errors.
  const badSend = await post('/api/submit', { id: randomUUID(), target: first.paneId, sessionId: 'some-other-session', mode: 'send', text: 'x' });
  assert.equal(badSend.status, 200);
  assert.equal((await badSend.json()).state, 'failed');
  const unknown = await post('/api/submit', { id: randomUUID(), target: 'no-such-pane', sessionId: 'unresolved:no-such-pane', mode: 'terminal', text: 'x' });
  assert.equal(unknown.status, 200);
  assert.equal((await unknown.json()).state, 'failed', 'an unknown pane is not a shell');
  const unmanaged = await post('/api/submit', { id: randomUUID(), target: 'w0:pUnmanaged', sessionId: 'unresolved:w0:pUnmanaged', mode: 'terminal', text: 'do not send' });
  assert.equal((await unmanaged.json()).state, 'failed', 'an existing unmanaged pane is not a companion shell');
  const promptToShell = await post('/api/action', { kind: 'prompt', target: first.paneId, text: 'x' });
  assert.ok(!promptToShell.ok, 'prompt refuses a bare shell pane');

  // A pane that died on the host is marked dead, and the next open recreates.
  const st = JSON.parse(await readFile(state, 'utf8'));
  st.panes = st.panes.filter(p => p.pane_id !== first.paneId);
  await writeFile(state, JSON.stringify(st));
  const dead = await snapshot();
  assert.equal(dead.shells.find(s => s.id === first.paneId)?.alive, false);
  await clearLog();
  const recreated = await openShell('/tmp/ws1');
  assert.equal(recreated.status, 200);
  const recreatedId = (await recreated.json()).paneId;
  assert.notEqual(recreatedId, first.paneId);
  assert.equal((await rows()).filter(r => r[0] === 'tab').length, 1);

  // Closing the shell kills only the shell pane; the agent survives.
  await clearLog();
  const close = await post('/api/action', { kind: 'close', target: recreatedId });
  assert.equal(close.status, 200);
  await new Promise(r => setTimeout(r, 300));
  assert.ok((await rows()).some(r => r[0] === 'pane' && r[1] === 'close' && r[2] === recreatedId));
  const after = await snapshot();
  assert.ok(!after.shells.some(s => s.id === recreatedId));
  assert.ok(after.agents.some(a => a.id === 'w0:pA'), 'the coding agent pane is untouched');

  // A bridge restart re-adopts the surviving labeled pane instead of
  // creating a duplicate, and a repeat open still reuses it.
  await clearLog();
  const reopened = await openShell('/tmp/ws1');
  assert.equal(reopened.status, 200);
  const reopenedId = await (await reopened.json()).paneId;
  assert.notEqual(reopenedId, recreatedId, 'a closed shell never resurrects its dead pane');
  child.kill();
  await once(child, 'exit').catch(() => {});
  child = await boot();
  // Auth sessions are in-memory; pairings persist in the state dir.
  const relaunch = await fetch(`${url}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: url }, body: JSON.stringify({ password: 'review-pass' }) }).then(r => r.json());
  headers = { 'content-type': 'application/json', origin: url, authorization: `Bearer ${relaunch.token}`, 'x-moshpit-device': headers['x-moshpit-device'] };
  const resumed = await snapshot();
  assert.equal(resumed.shells.find(s => s.id === reopenedId)?.alive, true, 'the shell is re-adopted after a bridge restart');
  await clearLog();
  const resumedOpen = await openShell('/tmp/ws1');
  assert.equal((await resumedOpen.json()).paneId, reopenedId);
  assert.equal((await rows()).filter(r => r[0] === 'tab').length, 0, 'restart adoption creates no duplicate tab');
});

test('demo herdr: open, reuse, echo, and close a shell', async () => {
  const herdr = createHerdr({});
  const one = await herdr.openShell({ cwd: '/tmp/demo-proj' });
  assert.match(one.paneId, /^demo:shell/);
  const again = await herdr.openShell({ cwd: '/tmp/demo-proj/' });
  assert.equal(again.paneId, one.paneId, 'demo reuses one shell per cwd');
  const other = await herdr.openShell({ cwd: '/tmp/other' });
  assert.notEqual(other.paneId, one.paneId, 'a different cwd gets its own shell');
  const snap = await herdr.snapshot();
  assert.equal(snap.shells.length, 2);
  assert.ok(snap.shells.every(s => s.alive === true));
  assert.ok(!snap.agents.some(a => a.id === one.paneId));
  await herdr.prompt(one.paneId, 'ls -la');
  const dump = await herdr.dump(one.paneId);
  assert.match(dump, /ls -la/);
  await herdr.keys(one.paneId, 'ctrl+c');
  assert.match(await herdr.dump(one.paneId), /\^C/);
  assert.equal(await herdr.isShell(one.paneId), true);
  await herdr.close(one.paneId);
  const after = await herdr.snapshot();
  assert.ok(!after.shells.some(s => s.id === one.paneId));
  assert.equal(await herdr.isShell(one.paneId), false);
  assert.ok(after.agents.some(a => a.id === 'migrate'), 'demo agents survive a shell close');
});
