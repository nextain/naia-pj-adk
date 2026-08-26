import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '../../..');
const runtimePath = path.resolve(
  process.env.NAIA_PJ_RUNTIME_FILE || path.join(root, '.runtime/naia-land.json'),
);
const leasePath = path.join(root, '.runtime/naia-land-mutation-lease.json');

function fail(message) {
  throw new Error(message);
}

function loadRuntime({ requireToken = true } = {}) {
  let runtime;
  try {
    runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
  } catch (error) {
    fail(`runtime configuration is unavailable: ${error.message}`);
  }
  const required = ['version', 'project', 'actorRole', 'issueNumber', 'workspace', 'discord', 'development'];
  for (const key of required) {
    if (runtime[key] === undefined) fail(`runtime configuration is missing ${key}`);
  }
  if (runtime.version !== 1 || runtime.project !== 'naia-land') fail('runtime project identity is invalid');
  if (runtime.actorRole !== 'integrator') fail('development deployment requires the integrator role');
  if (!Number.isInteger(runtime.issueNumber) || runtime.issueNumber < 1) fail('runtime issueNumber must be positive');
  for (const key of ['guildId', 'channelId', 'applicationId']) {
    if (!/^[0-9]{17,20}$/.test(runtime.discord?.[key] || '')) fail(`discord.${key} must be a snowflake`);
  }
  if (!/^[a-z0-9][a-z0-9_-]{2,63}$/.test(runtime.discord?.gatewayInstanceId || '')) {
    fail('discord.gatewayInstanceId is invalid');
  }
  if (requireToken && !process.env.NAIA_DISCORD_BOT_TOKEN) fail('NAIA_DISCORD_BOT_TOKEN is not set');
  const dev = runtime.development;
  if (!/^[a-z0-9][a-z0-9._/-]*$/.test(dev.integrationBranch || '')) {
    fail('development.integrationBranch is invalid');
  }
  try {
    new URL(dev.url);
  } catch {
    fail('development.url must be an absolute URL');
  }
  if (!Number.isInteger(dev.minimumBodyBytes) || dev.minimumBodyBytes < 1) fail('minimumBodyBytes must be positive');
  if (!Array.isArray(dev.requiredStrings) || !dev.requiredStrings.length
      || dev.requiredStrings.some((item) => typeof item !== 'string' || !item.trim())) {
    fail('requiredStrings must be a non-empty string array');
  }
  for (const key of [
    'deployCommand', 'reloadCommand', 'cacheInvalidationCommand', 'servingRevisionCommand',
    'rollbackPrepareCommand', 'rollbackCommand',
  ]) {
    if (!Array.isArray(dev[key]) || !dev[key].length
        || dev[key].some((item) => typeof item !== 'string' || !item.trim())) {
      fail(`development.${key} must be a non-empty argv array`);
    }
  }
  const workspace = path.resolve(runtime.workspace);
  if (!fs.statSync(workspace, { throwIfNoEntry: false })?.isDirectory()) fail('registered workspace does not exist');
  const remote = run(['git', '-C', workspace, 'remote', 'get-url', 'origin'], { capture: true }).stdout.trim();
  if (!/(github\.com[/:])nextain\/naia\.land(?:\.git)?$/.test(remote)) fail('registered workspace origin is not nextain/naia.land');
  return { ...runtime, workspace };
}

function run(argv, options = {}) {
  if (!Array.isArray(argv) || !argv.length) fail('refusing an empty command');
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd: options.cwd || root,
    env: { ...process.env, ...(options.env || {}) },
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.error || result.status !== 0) {
    const detail = options.capture ? (result.stderr || result.stdout || '').trim() : '';
    fail(`command failed: ${argv[0]}${detail ? ` (${detail})` : ''}`);
  }
  return result;
}

function git(runtime, ...args) {
  return run(['git', '-C', runtime.workspace, ...args], { capture: true });
}

function validateIssueAndBranch(runtime) {
  const issue = run([
    'gh', 'issue', 'view', String(runtime.issueNumber), '-R', 'nextain/naia.land',
    '--json', 'state', '--jq', '.state',
  ], { capture: true }).stdout.trim();
  if (issue !== 'OPEN') fail('deployment gate: GitHub issue is not open');
  const branch = git(runtime, 'branch', '--show-current').stdout.trim();
  if (!branch.startsWith(`issue/${runtime.issueNumber}-`)) fail('deployment gate: branch does not match the issue');
  if (git(runtime, 'status', '--porcelain').stdout.trim()) fail('deployment gate: workspace is not clean');
  const integration = `origin/${runtime.development.integrationBranch}`;
  run(['git', '-C', runtime.workspace, 'merge-base', '--is-ancestor', integration, 'HEAD']);
  const changed = git(runtime, 'rev-list', '--count', `${integration}..HEAD`).stdout.trim();
  if (Number(changed) < 1) fail(`deployment gate: branch has no committed change from ${integration}`);
}

function intakeScan(runtime) {
  const result = spawnSync('git', [
    '-C', runtime.workspace, 'grep', '-n', '-I', '-E',
    '(BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|gh[pousr]_[A-Za-z0-9]{20,})', 'HEAD',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error || ![0, 1].includes(result.status)) {
    fail(`intake scan could not run: ${(result.error?.message || result.stderr || '').trim()}`);
  }
  if (result.status === 0) fail('intake scan found a tracked credential pattern');
  console.log('intake scan passed');
}

function acquireLease(runtime) {
  fs.mkdirSync(path.dirname(leasePath), { recursive: true });
  if (fs.existsSync(leasePath)) fail('development mutation lease already exists');
  const now = Date.now();
  const lease = {
    project: 'naia-land',
    environment: 'development',
    owner: runtime.discord.gatewayInstanceId,
    issueNumber: runtime.issueNumber,
    acquiredAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 15 * 60 * 1000).toISOString(),
  };
  fs.writeFileSync(leasePath, `${JSON.stringify(lease, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

function releaseLease() {
  if (fs.existsSync(leasePath)) fs.unlinkSync(leasePath);
}

async function verify(runtime) {
  for (let pass = 1; pass <= 2; pass += 1) {
    const url = new URL(runtime.development.url);
    url.searchParams.set('__naia_verify', `${Date.now()}-${pass}`);
    const response = await fetch(url, { redirect: 'follow', cache: 'no-store' });
    const body = await response.text();
    if (!response.ok) fail(`verification ${pass}/2 failed: HTTP ${response.status}`);
    if (Buffer.byteLength(body) < runtime.development.minimumBodyBytes) fail(`verification ${pass}/2 failed: body too small`);
    for (const required of runtime.development.requiredStrings) {
      if (!body.includes(required)) fail(`verification ${pass}/2 failed: required content missing`);
    }
    console.log(`verification ${pass}/2 passed`);
  }
}

function proveRevision(runtime) {
  const expected = git(runtime, 'rev-parse', 'HEAD').stdout.trim();
  const actual = run(runtime.development.servingRevisionCommand, { capture: true }).stdout.trim();
  if (actual !== expected) fail('serving revision does not match the committed workspace revision');
  console.log(`serving revision proven: ${expected}`);
}

async function deploy(runtime) {
  validateIssueAndBranch(runtime);
  intakeScan(runtime);
  acquireLease(runtime);
  let rollbackReady = false;
  try {
    run(runtime.development.rollbackPrepareCommand, { cwd: runtime.workspace });
    rollbackReady = true;
    const artifact = fs.mkdtempSync(path.join(os.tmpdir(), 'naia-land-artifact-'));
    try {
      const archive = spawnSync('git', ['-C', runtime.workspace, 'archive', 'HEAD'], { encoding: null });
      if (archive.status !== 0) fail('failed to export committed revision');
      const unpack = spawnSync('tar', ['-xf', '-', '-C', artifact], { input: archive.stdout, stdio: ['pipe', 'inherit', 'inherit'] });
      if (unpack.status !== 0) fail('failed to unpack committed revision');
      run(runtime.development.deployCommand, { cwd: artifact, env: { NAIA_ARTIFACT_DIR: artifact } });
      run(runtime.development.reloadCommand, { cwd: runtime.workspace });
      run(runtime.development.cacheInvalidationCommand, { cwd: runtime.workspace });
      proveRevision(runtime);
      await verify(runtime);
      releaseLease();
      console.log('development deployment passed all gates');
    } finally {
      fs.rmSync(artifact, { recursive: true, force: true });
    }
  } catch (error) {
    if (rollbackReady) {
      try {
        run(runtime.development.rollbackCommand, { cwd: runtime.workspace });
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'deployment and rollback both failed');
      }
    }
    throw error;
  }
}

async function main() {
  const [command, tier] = process.argv.slice(2);
  if (!command) fail('usage: project-ops.mjs <command> [tier]');
  if (tier && tier !== 'development') fail('only the development tier is available');

  const runtime = loadRuntime({ requireToken: command === 'validate-runtime' || command === 'deploy-development' });

  switch (command) {
  case 'validate-runtime':
    console.log('Naia runtime configuration accepted');
    break;
  case 'deploy-gate':
    validateIssueAndBranch(runtime);
    console.log('development deployment gate passed');
    break;
  case 'intake-scan':
    intakeScan(runtime);
    break;
  case 'reload':
    run(runtime.development.reloadCommand, { cwd: runtime.workspace });
    break;
  case 'invalidate-cache':
    run(runtime.development.cacheInvalidationCommand, { cwd: runtime.workspace });
    break;
  case 'prove-revision':
  case 'drift-check':
    proveRevision(runtime);
    break;
  case 'verify':
    await verify(runtime);
    break;
  case 'rollback':
    run(runtime.development.rollbackCommand, { cwd: runtime.workspace });
    await verify(runtime);
    releaseLease();
    break;
  case 'deploy-development':
    await deploy(runtime);
    break;
  default:
    fail(`unknown command: ${command}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
