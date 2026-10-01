import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWorktreeAgent } from './worktrees.mjs';
import { worktreeDestination, defaultWorktreeBranch } from '../src/lib/moshpit/worktrees-policy.mjs';

// Hash every non-.git file so a worktree operation can be proven not to touch
// the original checkout's content (tracked or untracked).
async function fingerprint(root) {
  const entries = [];
  async function walk(dir, rel) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (rel === '' && entry.name === '.git') continue;
      const p = path.join(dir, entry.name);
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(p, r);
      else entries.push(`${r}:${createHash('sha256').update(await readFile(p)).digest('hex')}`);
    }
  }
  await walk(root, '');
  return entries.sort().join('\n');
}

const git = (args) => execFileSync('git', args, { encoding: 'utf8' });

async function makeRepo(dir) {
  const gitIn = (args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  await mkdir(dir, { recursive: true });
  gitIn(['init', '-b', 'main']);
  gitIn(['config', 'user.email', 'test@example.com']);
  gitIn(['config', 'user.name', 'test']);
  await writeFile(path.join(dir, 'tracked.txt'), 'v1\n');
  await writeFile(path.join(dir, 'untracked.txt'), 'scratch\n');
  gitIn(['add', 'tracked.txt']);
  gitIn(['commit', '-m', 'base']);
  // Dirty checkout: a modified tracked file plus an untracked file.
  await writeFile(path.join(dir, 'tracked.txt'), 'v2-dirty\n');
  await writeFile(path.join(dir, 'new.txt'), 'unborn\n');
  return gitIn(['status', '--porcelain']);
}

test('worktree policy is one shared formula', { timeout: 10000 }, () => {
  assert.equal(worktreeDestination('/home/user/repo', 'wt-1'), '/home/user/repo-worktrees/wt-1');
  assert.equal(worktreeDestination('/home/user/repo/', 'feat/nested'), '/home/user/repo-worktrees/feat/nested');
  assert.match(defaultWorktreeBranch(), /^wt-\d{8}$/);
});

test('worktree launch: created, original checkout byte-for-byte unchanged', { timeout: 30000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'moshpit-wt-'));
  try {
    const before = await makeRepo(dir);
    const beforeFingerprint = await fingerprint(dir);
    let startCwd = null;
    const result = await createWorktreeAgent({
      repoCwd: dir,
      baseRef: 'HEAD',
      branch: 'wt-test',
      agentKind: 'pi',
      model: 'prov/model',
      startAgent: async (args) => {
        startCwd = args.cwd;
        assert.equal(args.agentKind, 'pi');
        assert.equal(args.model, 'prov/model');
        return { paneId: 'pane1' };
      },
    });
    assert.deepEqual({ state: result.state, paneId: result.paneId, branch: result.branch }, { state: 'started', paneId: 'pane1', branch: 'wt-test' });
    const destination = worktreeDestination(dir, 'wt-test');
    assert.equal(startCwd, destination);
    assert.ok(existsSync(path.join(destination, 'tracked.txt')));
    assert.equal(await readFile(path.join(destination, 'tracked.txt'), 'utf8'), 'v1\n');
    const list = git(['-C', dir, 'worktree', 'list']);
    assert.match(list, /wt-test/);
    assert.equal(await fingerprint(dir), beforeFingerprint, 'original checkout files changed');
    assert.equal(git(['-C', dir, 'status', '--porcelain']), before, 'original checkout git status changed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('worktree launch from a child directory resolves the repository root', { timeout: 30000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'moshpit-wt-'));
  try {
    await makeRepo(dir);
    await mkdir(path.join(dir, 'sub'));
    let startCwd = null;
    const result = await createWorktreeAgent({
      repoCwd: path.join(dir, 'sub'),
      baseRef: 'HEAD',
      branch: 'wt-sub',
      agentKind: 'pi',
      startAgent: async (args) => {
        startCwd = args.cwd;
        return { paneId: 'pane1' };
      },
    });
    assert.equal(result.state, 'started');
    const destination = worktreeDestination(dir, 'wt-sub');
    assert.equal(startCwd, destination, 'the agent starts next to the repo root, not the subdirectory');
    assert.ok(existsSync(path.join(destination, 'tracked.txt')));
    assert.match(git(['-C', dir, 'worktree', 'list']), /wt-sub/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a linked-worktree project anchors on the main worktree and keeps its own HEAD', { timeout: 30000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'moshpit-wt-'));
  try {
    await makeRepo(dir);
    // A second commit on a side branch, checked out as a linked worktree, so
    // the linked worktree's HEAD differs from the main worktree's.
    const linked = path.join(dir, 'linked');
    git(['-C', dir, 'worktree', 'add', '-q', '-b', 'side', linked, 'HEAD']);
    await writeFile(path.join(linked, 'only-on-side.txt'), 'side\n');
    git(['-C', linked, 'add', 'only-on-side.txt']);
    git(['-C', linked, '-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-q', '-m', 'side']);
    const sideHead = git(['-C', linked, 'rev-parse', 'HEAD']).trim();
    const mainHead = git(['-C', dir, 'rev-parse', 'HEAD']).trim();
    assert.notEqual(sideHead, mainHead, 'fixture must have divergent heads');

    let startCwd = null;
    const result = await createWorktreeAgent({
      repoCwd: linked,
      baseRef: 'HEAD',
      branch: 'wt-from-linked',
      agentKind: 'pi',
      startAgent: async (args) => {
        startCwd = args.cwd;
        return { paneId: 'pane1' };
      },
    });
    assert.equal(result.state, 'started');

    // Destination beside the main worktree, not nested under the linked one.
    assert.equal(startCwd, worktreeDestination(dir, 'wt-from-linked'));
    assert.notEqual(startCwd, worktreeDestination(linked, 'wt-from-linked'));

    // HEAD still means the project's own HEAD, so the new branch carries the
    // side commit. Anchoring refs on the main worktree would silently branch
    // from master instead.
    assert.equal(git(['-C', startCwd, 'rev-parse', 'HEAD']).trim(), sideHead);
    assert.ok(existsSync(path.join(startCwd, 'only-on-side.txt')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('repoToplevel resolves subdirectory and rejects non-repositories', { timeout: 10000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'moshpit-wt-'));
  const plain = await mkdtemp(path.join(tmpdir(), 'moshpit-wt-plain-'));
  try {
    await makeRepo(dir);
    await mkdir(path.join(dir, 'sub'));
    const { repoToplevel } = await import('./worktrees.mjs');
    assert.equal(await repoToplevel(path.join(dir, 'sub')), dir);
    assert.equal(await repoToplevel(dir), dir);
    await assert.rejects(repoToplevel(path.join(plain, 'sub')), /Not a Git repository/);
    await assert.rejects(repoToplevel(''), /A project path is required/);
    await assert.rejects(repoToplevel('-x'), /may not start with a dash/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(plain, { recursive: true, force: true });
  }
});

test('worktree launch: agent failure keeps the created worktree', { timeout: 30000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'moshpit-wt-'));
  try {
    await makeRepo(dir);
    const result = await createWorktreeAgent({
      repoCwd: dir,
      baseRef: 'HEAD',
      branch: 'wt-fail',
      agentKind: 'pi',
      startAgent: async () => {
        throw new Error('agent start exploded');
      },
    });
    assert.equal(result.state, 'created-agent-failed');
    assert.equal(result.error, 'agent start exploded');
    assert.equal(result.path, worktreeDestination(dir, 'wt-fail'));
    assert.ok(existsSync(result.path), 'partial result must leave the worktree on disk');
    assert.match(git(['-C', dir, 'worktree', 'list']), /wt-fail/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('worktree launch: invalid refs, names and directories fail clearly', { timeout: 30000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'moshpit-wt-'));
  const notRepo = await mkdtemp(path.join(tmpdir(), 'moshpit-wt-plain-'));
  const base = {
    repoCwd: dir,
    agentKind: 'pi',
    startAgent: async () => {
      throw new Error('must not start an agent');
    },
  };
  await makeRepo(dir);
  try {
    await assert.rejects(createWorktreeAgent({ ...base, baseRef: 'nope', branch: 'wt-1' }), /Unknown base ref: nope/);
    await assert.rejects(createWorktreeAgent({ ...base, baseRef: '-u', branch: 'wt-1' }), /may not start with a dash/);
    await assert.rejects(createWorktreeAgent({ ...base, baseRef: 'HEAD', branch: '-x' }), /may not start with a dash/);
    await assert.rejects(createWorktreeAgent({ ...base, baseRef: 'HEAD', branch: 'bad name' }), /Invalid branch name: bad name/);
    await assert.rejects(createWorktreeAgent({ ...base, baseRef: '', branch: 'wt-1' }), /A base ref is required/);
    await assert.rejects(createWorktreeAgent({ ...base, baseRef: 'HEAD', branch: 'x'.repeat(201) }), /under 200/);
    await assert.rejects(createWorktreeAgent({ ...base, repoCwd: notRepo, baseRef: 'HEAD', branch: 'wt-1' }), /Not a Git repository/);
    await assert.rejects(createWorktreeAgent({ ...base, baseRef: 'HEAD', branch: 'main' }), /Branch already exists: main/);
    const destination = worktreeDestination(dir, 'wt-collide');
    await mkdir(destination, { recursive: true });
    await writeFile(path.join(destination, 'file.txt'), 'x\n');
    await assert.rejects(createWorktreeAgent({ ...base, baseRef: 'HEAD', branch: 'wt-collide' }), /Destination already exists/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(notRepo, { recursive: true, force: true });
  }
});
