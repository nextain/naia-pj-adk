import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
const script = path.join(repositoryRoot, 'projects/naia-land/scripts/project-ops.mjs');

function git(workspace, ...args) {
  execFileSync('git', ['-C', workspace, ...args], { stdio: 'ignore' });
}

function fixture(overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naia-pj-test-'));
  const workspace = path.join(directory, 'workspace');
  fs.mkdirSync(workspace);
  git(workspace, 'init', '-b', 'main');
  git(workspace, 'remote', 'add', 'origin', 'https://github.com/nextain/naia.land.git');
  const runtime = {
    version: 1,
    project: 'naia-land',
    actorRole: 'integrator',
    issueNumber: 72,
    workspace,
    discord: {
      // public-safety-allow: documented Discord test snowflakes, not payment data
      guildId: '1474553972521177242',
      // public-safety-allow: documented Discord test snowflakes, not payment data
      channelId: '1540179115020263474',
      // public-safety-allow: documented Discord test snowflakes, not payment data
      applicationId: '1525373011375558726',
      gatewayInstanceId: 'naia',
    },
    development: {
      integrationBranch: 'main',
      url: 'https://dev.naia.land',
      minimumBodyBytes: 100,
      requiredStrings: ['Naia'],
      deployCommand: ['/bin/true'],
      reloadCommand: ['/bin/true'],
      cacheInvalidationCommand: ['/bin/true'],
      servingRevisionCommand: ['/bin/true'],
      rollbackPrepareCommand: ['/bin/true'],
      rollbackCommand: ['/bin/true'],
      ...overrides,
    },
  };
  const runtimeFile = path.join(directory, 'runtime.json');
  fs.writeFileSync(runtimeFile, `${JSON.stringify(runtime)}\n`, { mode: 0o600 });
  return { directory, runtimeFile };
}

function validate(runtimeFile) {
  return spawnSync(process.execPath, [script, 'validate-runtime'], {
    env: {
      ...process.env,
      NAIA_PJ_RUNTIME_FILE: runtimeFile,
      NAIA_DISCORD_BOT_TOKEN: 'test-token-never-used',
    },
    encoding: 'utf8',
  });
}

test('accepts a complete Naia development runtime contract', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.directory, { recursive: true, force: true }));
  const result = validate(data.runtimeFile);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /configuration accepted/);
});

test('rejects blank verification content requirements', (t) => {
  const data = fixture({ requiredStrings: [''] });
  t.after(() => fs.rmSync(data.directory, { recursive: true, force: true }));
  const result = validate(data.runtimeFile);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /non-empty string array/);
});

test('rejects blank command arguments', (t) => {
  const data = fixture({ deployCommand: ['/bin/true', ''] });
  t.after(() => fs.rmSync(data.directory, { recursive: true, force: true }));
  const result = validate(data.runtimeFile);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /non-empty argv array/);
});
