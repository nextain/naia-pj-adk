import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {evaluateCommand, evaluateEdit, verdict, sha256} from './lib/pretool-guard.mjs';

const root = '/work/repo';
const ctx = (extra = {}) => ({cwd: root, repoRoot: root, currentBranch: 'issue/1-x', home: '/home/me', ...extra});
const policy = JSON.parse(fs.readFileSync(new URL('../.agents/context/guard-policy.json', import.meta.url)));
const d = (cmd, c = ctx(), p = policy) => evaluateCommand(cmd, c, p).decision;

test('pushes to protected branches, force pushes and remote deletes are denied', () => {
  for (const cmd of [
    'git push origin main', 'git push origin HEAD:main', 'git push origin feat:refs/heads/main', 'git push origin refs/heads/master',
    'sudo -E git -C /x push origin main', 'cd a && git push origin main', 'git push --force origin feat', 'git push -f origin feat',
    'git push -uf origin feat', 'git push --force-with-lease', 'git push origin +feat', 'git push origin :feat', 'git push --delete origin feat',
    'git push -d origin feat', 'git push --all', 'git push --mirror', 'timeout 60 git push origin main',
  ]) assert.equal(d(cmd), 'deny', cmd);
  assert.equal(d('git push', ctx({currentBranch: 'main'})), 'deny');
  assert.equal(d('git push --repo origin main'), 'deny');
  assert.equal(d('git push --repo=origin HEAD:master'), 'deny');
  assert.equal(d('git push origin HEAD', ctx({currentBranch: 'main'})), 'deny');
});

test('routine pushes and text that only mentions a push are allowed', () => {
  for (const cmd of [
    'git push origin issue/1-x', 'git push -u origin issue/1-x', 'git push', 'git push --dry-run origin feat', 'git push -n origin feat',
    'git commit -m "do not git push origin main"', 'echo "git push origin main"', 'git push origin HEAD', 'git push --tags origin',
  ]) assert.equal(d(cmd), 'allow', cmd);
});

test('recursive deletes of roots, home and the repository are denied; ordinary deletes pass', () => {
  for (const cmd of ['rm -rf /', 'rm -rf /*', 'rm -rf ~', 'rm -rf $HOME', 'rm -r -f /opt', 'rm -rf .', 'rm -rf ./', 'rm -rf /work', 'rm --no-preserve-root -rf x', 'sudo rm -rf /storage']) {
    assert.equal(d(cmd), 'deny', cmd);
  }
  assert.equal(d('rm -rf ..', ctx({cwd: '/work/repo/sub'})), 'deny');
  for (const cmd of ['rm -rf *', 'rm -rf ./*', 'rm -rf .git', 'rm -rf .git/']) assert.equal(d(cmd), 'deny', cmd);
  assert.equal(d('rm -rf *', ctx({cwd: '/work/repo/build'})), 'allow', 'a glob inside a subdirectory is ordinary');
  for (const cmd of ['rm -rf ./build', 'rm -rf /tmp/x', 'rm file.txt', 'rm -f /opt/x.log', 'rm -rf ~/scratch']) assert.equal(d(cmd), 'allow', cmd);
});

test('approval patterns need a lease for the exact command, unexpired and short', () => {
  const cmd = 'terraform apply plan.out';
  const result = evaluateCommand(cmd, ctx(), policy);
  assert.equal(result.decision, 'approval');
  const now = Date.parse('2026-09-23T10:00:00Z');
  const lease = (over = {}) => ({command_sha256: sha256(cmd), created_at: '2026-09-23T09:55:00Z', expires_at: '2026-09-23T10:05:00Z', ...over});
  assert.equal(verdict(result, cmd, null, now).block, true);
  assert.equal(verdict(result, cmd, lease(), now).block, false);
  assert.equal(verdict(result, cmd + ' ', lease(), now).block, false, 'surrounding whitespace is not a different command');
  assert.equal(verdict(result, 'terraform apply other.out', lease(), now).block, true);
  assert.equal(verdict(result, cmd, lease({expires_at: '2026-09-23T09:59:00Z'}), now).block, true);
  assert.equal(verdict(result, cmd, lease({expires_at: '2026-09-23T10:30:00Z'}), now).block, true, 'lease longer than 15 minutes');
  assert.equal(verdict({decision: 'deny', rule: 'x', reason: 'y'}, cmd, lease(), now).block, true, 'a lease never lifts a deny');
  assert.equal(d('git commit -m "run terraform apply later"'), 'allow', 'structure rules ignore free text');
  assert.equal(d('bash -c "terraform apply plan.out"'), 'approval', 'sh -c text is still a command');
});

test('agents cannot read, write or run the approval lease or tool', () => {
  assert.equal(d('cat .agents/work/high-risk-approval.json'), 'deny');
  assert.equal(d('node scripts/approve-high-risk.mjs --issue x -- terraform apply'), 'deny');
  assert.equal(evaluateEdit('.agents/work/high-risk-approval.json', ctx(), policy).decision, 'deny');
  assert.equal(evaluateEdit('/work/repo/.agents/work/high-risk-approval.json', ctx(), policy).decision, 'deny');
  assert.equal(evaluateEdit('README.md', ctx(), policy).decision, 'allow');
  assert.equal(d('git commit -m "docs: explain approve-high-risk.mjs"'), 'allow', 'naming the tool in free text is fine');
});

test('remote-execution scripts are read and judged by their content', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'));
  const p = {...policy, inspect_scripts: [{
    id: 'prod-run', command_pattern: 'run-command\\s+(create|invoke).*prod-vm', reason: 'Production run-command.',
    content_deny: [{id: 'db-write', pattern: '\\b(DELETE|UPDATE)\\b', reason: 'Production DB write.'}],
    content_approval: [{id: 'compose', pattern: 'docker\\s+compose\\b.*\\bup\\b', reason: 'Raw compose.'}],
  }]};
  const c = ctx({cwd: dir, readFile: (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } }});
  fs.writeFileSync(path.join(dir, 'ok.sh'), 'docker ps\n');
  fs.writeFileSync(path.join(dir, 'up.sh'), 'docker compose -f x.yml up -d origin\n');
  fs.writeFileSync(path.join(dir, 'db.sh'), 'mysql -e "DELETE FROM t"\n');
  const run = (s) => evaluateCommand(`az vm run-command create --vm-name prod-vm --script @${s}`, c, p).decision;
  assert.equal(run('ok.sh'), 'allow');
  assert.equal(run('up.sh'), 'approval');
  assert.equal(run('db.sh'), 'deny');
  assert.equal(run('missing.sh'), 'approval', 'an unreadable script cannot be cleared');
  assert.equal(evaluateCommand('az vm run-command create --vm-name dev-vm --script @up.sh', c, p).decision, 'allow');
  const wrapped = {...p, inspect_scripts: [{...p.inspect_scripts[0], id: 'wrapper', command_pattern: 'prodrun\\.sh', script_pattern: 'prodrun\\.sh\\s+\\S+\\s+(\\S+)'}]};
  assert.equal(evaluateCommand('bash prodrun.sh me up.sh', c, wrapped).decision, 'approval', 'a wrapper script argument is inspected too');
  assert.equal(evaluateCommand('bash prodrun.sh me ok.sh', c, wrapped).decision, 'allow');
});

test('hook adapter blocks with exit 2 for Claude and Grok payloads and passes benign calls', () => {
  const hook = new URL('./pretool-guard-hook.mjs', import.meta.url).pathname;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-cwd-'));
  const run = (payload) => spawnSync('node', [hook], {input: JSON.stringify(payload), encoding: 'utf8'});
  const blocked = run({tool_name: 'Bash', tool_input: {command: 'git push origin main'}, cwd});
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /guard:git-push-protected/);
  assert.equal(run({toolName: 'run_terminal_command', toolInput: {command: 'git push --force origin x'}, cwd}).status, 2);
  assert.equal(run({tool_name: 'Bash', tool_input: {command: 'ls -la'}, cwd}).status, 0);
  assert.equal(run({tool_name: 'Write', tool_input: {file_path: '.agents/work/high-risk-approval.json', content: '{}'}, cwd}).status, 2);
  assert.equal(run({tool_name: 'Read', tool_input: {file_path: 'x'}, cwd}).status, 0);
  assert.equal(spawnSync('node', [hook], {input: 'not json', encoding: 'utf8'}).status, 0, 'unparseable input fails open');
});
