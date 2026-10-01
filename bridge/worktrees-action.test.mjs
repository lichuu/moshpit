import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { boundaryEnv, bridgeCommand, freePort, isolatedEnv, pairDevice, passwordEnv } from './test-support.mjs';

// End-to-end: a real bridge, a fake herdr (disposable "host"), and a real
// temporary Git repository. Covers the start-with-checkout payload, the 422
// partial-failure contract, and retry-in-retained-worktree without git rerun.
test('start action with worktree checkout over HTTP', { timeout: 30000 }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'moshpit-wt-http-'));
  const repo = path.join(dir, 'repo');
  await mkdir(repo, { recursive: true });
  const git = (args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'test']);
  await writeFile(path.join(repo, 'tracked.txt'), 'v1\n');
  await writeFile(path.join(repo, 'untracked.txt'), 'scratch\n');
  git(['add', 'tracked.txt']);
  git(['commit', '-m', 'base']);
  await writeFile(path.join(repo, 'tracked.txt'), 'v2-dirty\n'); // dirty checkout under test
  const writes = path.join(dir, 'writes.jsonl');
  await writeFile(writes, '');
  const bin = path.join(dir, 'herdr-fixture');
  await writeFile(bin, `#!${process.execNodePath ?? process.execPath}
import {appendFileSync, existsSync} from 'node:fs';
const a = process.argv.slice(2);
const log = (m) => appendFileSync(process.env.WT_WRITES, JSON.stringify(m) + '\\n');
if (a[0] === 'api' && a[1] === 'snapshot') console.log(JSON.stringify({result:{snapshot:{agents:[]}}}));
else if (a[0] === 'pane' && a[1] === 'list') console.log(JSON.stringify({result:{panes:[]}}));
else if (a[0] === 'worktree' && a[1] === 'list') console.log(JSON.stringify({result:{worktrees:[]}}));
else if (a[0] === 'tab' && a[1] === 'create') { log(['tab', ...a.slice(1)]); console.log(JSON.stringify({result:{root_pane:{pane_id:'pane-wt'}}})); }
else if (a[0] === 'agent' && a[1] === 'start') {
  log(['agent', ...a.slice(1)]);
  if (existsSync(process.env.WT_FAIL_START)) { console.error('fake agent start failure'); process.exit(1); }
  console.log('{}');
}
else if (a[0] === 'pane' && (a[1] === 'rename' || a[1] === 'close')) { log(['pane', ...a.slice(1)]); console.log('{}'); }
else console.log('{}');
`, { mode: 0o700 });
  await writeFile(path.join(dir, 'package.json'), '{"type":"module"}');
  const failStart = path.join(dir, 'fail-start');
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(...bridgeCommand(), {
    env: { ...isolatedEnv(), ...boundaryEnv(port), MOSHPIT_BIND: '127.0.0.1', ...await passwordEnv(dir), MOSHPIT_STATE_DIR: path.join(dir, 'state'), MOSHPIT_HERDR_BIN: bin, WT_WRITES: writes, WT_FAIL_START: failStart },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    child.kill();
    await once(child, 'exit').catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });
  await once(child.stdout, 'data');
  const login = await fetch(`${url}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: url }, body: JSON.stringify({ password: 'review-pass' }) }).then(r => r.json());
  const headers = { 'content-type': 'application/json', origin: url, authorization: `Bearer ${login.token}`, 'x-moshpit-device': 'review' };
  headers['x-moshpit-device'] = await pairDevice(url, headers, { stateDir: path.join(dir, 'state') });
  const post = (body) => fetch(`${url}/api/action`, { method: 'POST', headers, body: JSON.stringify(body) });

  // Payload validation: checkout without a branch is rejected before git runs.
  let res = await post({ kind: 'start', cwd: repo, agentKind: 'pi', checkout: { baseRef: 'HEAD' } });
  assert.equal(res.status, 400);
  res = await post({ kind: 'start', cwd: repo, agentKind: 'pi', checkout: { branch: 'wt-x' } });
  assert.equal(res.status, 400);
  res = await post({ kind: 'start', cwd: repo, agentKind: 'nope', checkout: { baseRef: 'HEAD', branch: 'wt-x' } });
  assert.equal(res.status, 400);

  // Happy path: worktree created by real git, agent started in it.
  res = await post({ kind: 'start', cwd: repo, agentKind: 'pi', checkout: { baseRef: 'HEAD', branch: 'wt-http' } });
  assert.equal(res.status, 200);
  const started = await res.json();
  assert.equal(started.paneId, 'pane-wt');
  assert.equal(started.checkout.path, `${repo}-worktrees/wt-http`);
  assert.equal(started.checkout.branch, 'wt-http');
  assert.ok(existsSync(path.join(repo, '..', 'repo-worktrees/wt-http', 'tracked.txt')));
  assert.match(git(['worktree', 'list']), /wt-http/);
  // The original dirty checkout is untouched.
  assert.equal(git(['status', '--porcelain']).split('\n').filter(Boolean).length, 2);

  // Partial failure: agent start fails, the created worktree is retained.
  await writeFile(failStart, 'x');
  res = await post({ kind: 'start', cwd: repo, agentKind: 'pi', checkout: { baseRef: 'HEAD', branch: 'wt-fail' } });
  assert.equal(res.status, 422);
  const partial = await res.json();
  assert.match(partial.error.message, /fake agent start failure/);
  assert.deepEqual({ state: partial.partial.state, path: partial.partial.path, branch: partial.partial.branch }, { state: 'created-agent-failed', path: `${repo}-worktrees/wt-fail`, branch: 'wt-fail' });
  assert.ok(existsSync(partial.partial.path), 'partial worktree must stay on disk');
  const worktreesBeforeRetry = git(['worktree', 'list']).trim().split('\n').length;

  // A failed retry over the retained directory is a plain start: a failed
  // agent is a plain 500 (no git, no 422 partial) — the client keeps the
  // earlier partial visible for another retry.
  res = await post({ kind: 'start', cwd: partial.partial.path, agentKind: 'pi' });
  assert.equal(res.status, 500);
  assert.equal(git(['worktree', 'list']).trim().split('\n').length, worktreesBeforeRetry, 'a failed retry must not create another worktree');

  // Repeated retry failure: the second 422 keeps reporting the retained worktree.
  res = await post({ kind: 'start', cwd: repo, agentKind: 'pi', checkout: { baseRef: 'HEAD', branch: 'wt-fail2' } });
  assert.equal(res.status, 422);
  const partial2 = await res.json();
  assert.deepEqual({ state: partial2.partial.state, path: partial2.partial.path, branch: partial2.partial.branch }, { state: 'created-agent-failed', path: `${repo}-worktrees/wt-fail2`, branch: 'wt-fail2' });
  assert.ok(existsSync(partial2.partial.path), 'the second partial worktree must stay on disk too');

  // Read-only repo-root probe: subdirectory resolves to the toplevel; invalid input 400s.
  res = await fetch(`${url}/api/repo-root`, { headers });
  assert.equal(res.status, 400);
  res = await fetch(`${url}/api/repo-root?cwd=${encodeURIComponent(repo)}`, { headers });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { root: repo });
  res = await fetch(`${url}/api/repo-root?cwd=${encodeURIComponent('/nonexistent/nope')}`, { headers });
  assert.equal(res.status, 400);
  assert.match(await res.json().then(j => j.error.message), /Not a Git repository/);

  // Retry: plain start in the retained directory. No git rerun.
  const rowsBeforeRetry = git(['worktree', 'list']).trim().split('\n').length;
  await rm(failStart, { force: true });
  res = await post({ kind: 'start', cwd: partial.partial.path, agentKind: 'pi' });
  assert.equal(res.status, 200);
  const retried = await res.json();
  assert.equal(retried.paneId, 'pane-wt');
  assert.equal(git(['worktree', 'list']).trim().split('\n').length, rowsBeforeRetry, 'retry must not create another worktree');

  // Invalid base ref and existing branch fail clearly through the API.
  res = await post({ kind: 'start', cwd: repo, agentKind: 'pi', checkout: { baseRef: 'nope-ref', branch: 'wt-ref' } });
  assert.equal(res.status, 400);
  assert.match(await res.json().then(j => j.error.message), /Unknown base ref/);
  res = await post({ kind: 'start', cwd: repo, agentKind: 'pi', checkout: { baseRef: 'HEAD', branch: 'main' } });
  assert.equal(res.status, 400);
  assert.match(await res.json().then(j => j.error.message), /Branch already exists/);

  // Launch-in-place still works with no checkout field.
  res = await post({ kind: 'start', cwd: repo, agentKind: 'pi' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).paneId, 'pane-wt');

  // A child-directory project resolves the repository root, so the worktree
  // lands next to the repo, not next to the subdirectory.
  await mkdir(path.join(repo, 'sub'));
  res = await post({ kind: 'start', cwd: path.join(repo, 'sub'), agentKind: 'pi', checkout: { baseRef: 'HEAD', branch: 'wt-sub' } });
  assert.equal(res.status, 200);
  const subStarted = await res.json();
  assert.equal(subStarted.checkout.path, `${repo}-worktrees/wt-sub`);
  assert.ok(existsSync(path.join(`${repo}-worktrees/wt-sub`, 'tracked.txt')));
  res = await fetch(`${url}/api/repo-root?cwd=${encodeURIComponent(path.join(repo, 'sub'))}`, { headers });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { root: repo });
});
