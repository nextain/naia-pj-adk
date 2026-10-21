import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';

// Throwaway repositories stand in for an upstream and a follower: a bare
// remote that a writer clone pushes to, and a detached worktree of another
// clone that docs-follow.sh moves.
const script = path.join(import.meta.dirname, 'docs-follow.sh');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-follow-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const remote = path.join(tmp, 'remote.git');
execFileSync('git', ['init', '--bare', '-q', '-b', 'main', remote]);
const writer = path.join(tmp, 'writer');
execFileSync('git', ['clone', '-q', remote, writer], { stdio: 'pipe' });
git(writer, 'config', 'user.email', 'docs-follow@test');
git(writer, 'config', 'user.name', 'docs-follow');

function publish(name, body) {
  fs.writeFileSync(path.join(writer, name), body);
  git(writer, 'add', name);
  git(writer, 'commit', '-q', '-m', `docs: ${name}`);
  git(writer, 'push', '-q', 'origin', 'HEAD:main');
  return git(writer, 'rev-parse', 'HEAD');
}

const first = publish('index.md', '# v1\n');
// The documented setup: a detached worktree beside someone's own clone.
const local = path.join(tmp, 'local');
execFileSync('git', ['clone', '-q', remote, local], { stdio: 'pipe' });
const follower = path.join(tmp, 'follower');
git(local, 'worktree', 'add', '-q', '--detach', follower, 'origin/main');
const logDir = path.join(tmp, 'logs');

function follow(checkout = follower, extra = []) {
  return spawnSync('bash', [script, '--checkout', checkout, '--log-dir', logDir, ...extra], { encoding: 'utf8' });
}
function lastLog() {
  const files = fs.readdirSync(logDir).filter((f) => f.endsWith('.log')).sort();
  const lines = fs.readFileSync(path.join(logDir, files.at(-1)), 'utf8').trim().split('\n');
  return JSON.parse(lines.at(-1));
}

test('follows a new upstream commit and records before and after', () => {
  assert.equal(git(follower, 'rev-parse', 'HEAD'), first);
  const second = publish('index.md', '# v2\n');
  const run = follow();
  assert.equal(run.status, 0, run.stderr);
  assert.equal(git(follower, 'rev-parse', 'HEAD'), second);
  assert.equal(fs.readFileSync(path.join(follower, 'index.md'), 'utf8'), '# v2\n');
  const entry = lastLog();
  assert.equal(entry.step, 'done');
  assert.match(entry.msg, new RegExp(`${first} -> ${second}`));
});

test('skips and records when the checkout has local changes', () => {
  const held = git(follower, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(follower, 'index.md'), '# edited by hand\n');
  publish('index.md', '# v3\n');
  const run = follow();
  assert.equal(run.status, 3);
  assert.equal(git(follower, 'rev-parse', 'HEAD'), held);
  assert.equal(fs.readFileSync(path.join(follower, 'index.md'), 'utf8'), '# edited by hand\n');
  assert.equal(lastLog().step, 'skip');
  git(follower, 'checkout', '-q', '--', 'index.md');
});

test('exits non-zero when fetch fails', () => {
  const before = git(follower, 'rev-parse', 'HEAD');
  git(follower, 'remote', 'set-url', 'origin', path.join(tmp, 'missing.git'));
  try {
    const run = follow();
    assert.notEqual(run.status, 0);
    assert.notEqual(run.status, 3);
    assert.equal(git(follower, 'rev-parse', 'HEAD'), before);
    assert.equal(lastLog().step, 'error');
  } finally {
    git(follower, 'remote', 'set-url', 'origin', remote);
  }
});

test('refuses a checkout that is on a branch', () => {
  const before = git(local, 'rev-parse', 'HEAD');
  publish('index.md', '# v4\n');
  const run = follow(local);
  assert.equal(run.status, 4);
  assert.equal(git(local, 'symbolic-ref', '--short', 'HEAD'), 'main');
  assert.equal(git(local, 'rev-parse', 'HEAD'), before);
});

test('rejects missing settings', () => {
  const run = spawnSync('bash', [script, '--log-dir', logDir], { encoding: 'utf8', env: { ...process.env, DOCS_FOLLOW_CHECKOUT: '' } });
  assert.equal(run.status, 2);
  assert.equal(spawnSync('bash', [script, '--checkout'], { encoding: 'utf8' }).status, 2);
});
