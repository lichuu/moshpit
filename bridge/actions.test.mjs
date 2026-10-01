import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { boundaryEnv, bridgeCommand, freePort, isolatedEnv, pairDevice, passwordEnv } from './test-support.mjs';

test('rename and close actions hit herdr and reject bad input', { timeout: 20000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'moshpit-actions-'));
  const log = path.join(dir, 'actions.jsonl');
  const bin = path.join(dir, 'herdr-fixture');
  await writeFile(log, '');
  await writeFile(bin, `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';
const a=process.argv.slice(2);
if(a[0]==='api') console.log(JSON.stringify({result:{snapshot:{agents:[{pane_id:'pane',agent:'codex',agent_status:'idle',cwd:''}]}}}));
else if(a[0]==='pane'&&(a[1]==='rename'||a[1]==='close')) {appendFileSync(process.env.REVIEW_WRITES, JSON.stringify(a)+'\\n');console.log('{}');}
else console.log('{}');
`, { mode: 0o700 });
  await writeFile(path.join(dir, 'package.json'), '{"type":"module"}');
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(...bridgeCommand(), { env: { ...isolatedEnv(), ...boundaryEnv(port), MOSHPIT_BIND: '127.0.0.1', ...await passwordEnv(dir), MOSHPIT_STATE_DIR: path.join(dir, 'state'), MOSHPIT_HERDR_BIN: bin, REVIEW_WRITES: log }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { child.kill(); await once(child, 'exit').catch(() => {}); await rm(dir, { recursive: true, force: true }); });
  await once(child.stdout, 'data');
  const login = await fetch(`${url}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: url }, body: JSON.stringify({ password: 'review-pass' }) }).then(r => r.json());
  const headers = { 'content-type': 'application/json', origin: url, authorization: `Bearer ${login.token}`, 'x-moshpit-device': 'review' };
  headers['x-moshpit-device'] = await pairDevice(url, headers, { stateDir: path.join(dir, 'state') });
  const rows = async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const post = (body) => fetch(`${url}/api/action`, { method: 'POST', headers, body: JSON.stringify(body) });

  let res = await post({ kind: 'rename', target: 'pane', name: 'My label' });
  assert.equal(res.status, 200);
  await (async function waitForRename() { for (let i = 0; i < 100; i++) { if ((await rows()).length > 0) return; await new Promise(r => setTimeout(r, 20)); } throw new Error('Timed out waiting for rename write'); })();
  assert.deepEqual(await rows(), [['pane', 'rename', 'pane', 'My label']]);

  await writeFile(log, '');
  res = await post({ kind: 'rename', target: 'pane', clear: true });
  assert.equal(res.status, 200);
  await (async function waitForClear() { for (let i = 0; i < 100; i++) { if ((await rows()).length > 0) return; await new Promise(r => setTimeout(r, 20)); } throw new Error('Timed out waiting for clear write'); })();
  assert.deepEqual(await rows(), [['pane', 'rename', 'pane', '--clear']]);

  await writeFile(log, '');
  res = await post({ kind: 'rename', target: 'pane', name: '   ' });
  assert.equal(res.status, 400);
  assert.deepEqual(await rows(), []);

  res = await post({ kind: 'rename', target: 'pane', name: 'x'.repeat(101) });
  assert.equal(res.status, 400);
  assert.deepEqual(await rows(), []);
  res = await post({ kind: 'rename', target: 'pane', name: '--clear' });
  assert.equal(res.status, 400);
  assert.deepEqual(await rows(), []);
  res = await post({ kind: 'rename', target: 'pane', name: '--foo' });
  assert.equal(res.status, 400);
  assert.deepEqual(await rows(), []);

  await writeFile(log, '');
  res = await post({ kind: 'close', target: 'pane' });
  assert.equal(res.status, 200);
  await (async function waitForClose() { for (let i = 0; i < 100; i++) { if ((await rows()).length > 0) return; await new Promise(r => setTimeout(r, 20)); } throw new Error('Timed out waiting for close write'); })();
  assert.deepEqual(await rows(), [['pane', 'close', 'pane']]);

  res = await post({ kind: 'close' });
  assert.equal(res.status, 400);
});
