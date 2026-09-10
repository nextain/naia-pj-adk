import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { parseYaml } from './lib/yaml-lite.mjs';
import { evaluatePolicy } from './policy-guard.mjs';

const root = path.resolve(import.meta.dirname, '..');
const adapterSource = path.join(root, 'projects/example/project.yaml');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'naia-pj-policy-'));
const adapterFile = path.join(tempRoot, 'project.yaml');
const registryFile = path.join(tempRoot, 'participants.json');
const issueFile = path.join(tempRoot, 'issue.json');
const sentinel = path.join(tempRoot, 'handoff.txt');
const fakeCtl = path.join(tempRoot, 'project-gateway.sh');
const productionCtl = path.join(tempRoot, 'production-gateway.sh');
const fakeCtlRelative = path.relative(root, fakeCtl);
const productionCtlRelative = path.relative(root, productionCtl);
const projectArgs = path.join(tempRoot, 'project-args.txt');
const projectWorkspace = path.join(tempRoot, 'project-workspace.txt');
const projectCwd = path.join(tempRoot, 'project-cwd.txt');
const contributorWorkspace = path.join(tempRoot, 'workspace-contributor');
const integratorWorkspace = path.join(tempRoot, 'workspace-integrator');
const releaseOwnerWorkspace = path.join(tempRoot, 'workspace-release-owner');
const releaseApproverWorkspace = path.join(tempRoot, 'workspace-release-approver');
function shellPath(value) {
  if (process.platform !== 'win32') return value;
  const commands = [
    'cygpath.exe',
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'usr', 'bin', 'cygpath.exe'),
  ];
  for (const command of commands) {
    const result = spawnSync(command, ['-u', value], { encoding: 'utf8' });
    if (result.status === 0) return result.stdout.trim();
  }
  return value;
}
const contributorShellWorkspace = shellPath(contributorWorkspace);
const releaseOwnerShellWorkspace = shellPath(releaseOwnerWorkspace);
for (const workspace of [
  contributorWorkspace,
  integratorWorkspace,
  releaseOwnerWorkspace,
  releaseApproverWorkspace,
]) {
  fs.mkdirSync(workspace, { recursive: true });
}
const fakeAdkRoot = path.join(tempRoot, 'fake-adk');
const fakeAdkScript = path.join(
  fakeAdkRoot,
  '.agents/skills/manage-discord-sessions/scripts/manage-discord-sessions.sh',
);
const fakeNativeContractModule = path.join(
  fakeAdkRoot,
  '.agents/skills/manage-discord-sessions/helper/native-command-contract.mjs',
);
const adkArgs = path.join(tempRoot, 'adk-args.txt');

// Keep generated fixtures independent of the checkout's platform line ending.
// Windows Git clients may materialize YAML as CRLF, while the fixture edits
// below intentionally target the canonical LF form.
const adapterText = fs.readFileSync(adapterSource, 'utf8').replace(/\r\n/g, '\n');
fs.writeFileSync(adapterFile, adapterText);
fs.appendFileSync(adapterFile, `
gateway:
  project_backend:
    capabilities:
      production_deploy:
        argv: [deploy-production, --revision]
        revision_arg: --revision
      database_write:
        argv: [database-write, --revision]
        revision_arg: --revision
      rollback:
        argv: [rollback, --revision]
        revision_arg: --revision
      issue_work:
        commands:
          submit:
            argv: [submit, --issue-repository, "{{issue_repository}}", --issue-number, "{{issue_number}}", --issue-assignee, "{{issue_assignee}}"]
          restart:
            argv: [restart, --job, "{{job_id}}", --issue-repository, "{{issue_repository}}", --issue-number, "{{issue_number}}", --issue-assignee, "{{issue_assignee}}"]
          amend:
            argv: [amend, --issue-repository, "{{issue_repository}}", --issue-number, "{{issue_number}}", --issue-assignee, "{{issue_assignee}}"]
`);
const adapter = parseYaml(fs.readFileSync(adapterFile, 'utf8'));
const revision = 'a'.repeat(40);
const previousRevision = 'b'.repeat(40);
const testNow = new Date('2026-09-07T09:00:00Z');
const registry = {
  participants: [
    {
      discordUserId: '1'.repeat(18),
      alias: 'contributor',
      project: 'example',
      workspace: contributorWorkspace,
      roles: ['contributor'],
    },
    {
      discordUserId: '2'.repeat(18),
      alias: 'integrator',
      project: 'example',
      workspace: integratorWorkspace,
      roles: ['integrator'],
    },
    {
      discordUserId: '3'.repeat(18),
      alias: 'release-owner',
      project: 'example',
      workspace: releaseOwnerWorkspace,
      roles: ['release_owner'],
    },
    {
      discordUserId: '4'.repeat(18),
      alias: 'release-approver',
      project: 'example',
      workspace: releaseApproverWorkspace,
      roles: ['release_owner'],
    },
  ],
};
fs.writeFileSync(registryFile, JSON.stringify(registry));
fs.writeFileSync(issueFile, JSON.stringify({
  repository: adapter.project.repository,
  number: 1,
  state: 'OPEN',
  assignee: 'contributor',
}));
fs.mkdirSync(path.dirname(fakeAdkScript), { recursive: true });
const checkedInNativeContract = JSON.parse(fs.readFileSync(path.join(root, 'ops/gateway/native-command-contract.json'), 'utf8'));
const nativeSourceRoot = process.env.NAIA_NATIVE_ROOT;
const nativeSourceModule = nativeSourceRoot
  ? path.join(nativeSourceRoot, checkedInNativeContract.native_dependency.module)
  : '';
const nativeIntegrationAvailable = Boolean(
  nativeSourceRoot
  && path.isAbsolute(nativeSourceRoot)
  && fs.existsSync(nativeSourceModule),
);
if (nativeIntegrationAvailable) {
  fs.mkdirSync(path.dirname(fakeNativeContractModule), { recursive: true });
  fs.copyFileSync(nativeSourceModule, fakeNativeContractModule);
}
fs.writeFileSync(fakeCtl, `#!/usr/bin/env bash
printf '%s' handoff > "$DCG_TEST_SENTINEL"
if [[ -n "\${DCG_TEST_ARGS:-}" ]]; then printf '%s' "$*" > "$DCG_TEST_ARGS"; fi
if [[ -n "\${DCG_TEST_WORKSPACE:-}" ]]; then printf '%s' "$PROJECT_GATEWAY_WORKSPACE" > "$DCG_TEST_WORKSPACE"; fi
if [[ -n "\${DCG_TEST_CWD:-}" ]]; then pwd -P > "$DCG_TEST_CWD"; fi
`);
fs.chmodSync(fakeCtl, 0o755);
fs.writeFileSync(productionCtl, `#!/usr/bin/env bash
printf '%s' handoff > "$DCG_TEST_SENTINEL"
printf '%s' "$*" > "$DCG_TEST_ARGS"
printf '%s' "$PROJECT_GATEWAY_WORKSPACE" > "$DCG_TEST_WORKSPACE"
pwd -P > "$DCG_TEST_CWD"
`);
fs.chmodSync(productionCtl, 0o755);
fs.writeFileSync(fakeAdkScript, `#!/usr/bin/env bash
if [[ -n "\${DCG_TEST_ADK_ARGS:-}" ]]; then printf '%s' "$*" > "$DCG_TEST_ADK_ARGS"; fi
`);
fs.chmodSync(fakeAdkScript, 0o755);

function policyFor(adapterPath, options) {
  const actorWorkspaces = {
    contributor: contributorWorkspace,
    integrator: integratorWorkspace,
    'release-owner': releaseOwnerWorkspace,
    'release-approver': releaseApproverWorkspace,
  };
  return evaluatePolicy({
    adapterFile: adapterPath,
    registryFile,
    now: testNow,
    senderId: options.actorAlias === 'contributor'
      ? '1'.repeat(18)
      : options.actorAlias === 'integrator'
        ? '2'.repeat(18)
        : options.actorAlias === 'release-owner'
          ? '3'.repeat(18)
          : options.actorAlias === 'release-approver'
            ? '4'.repeat(18)
            : undefined,
    targetWorkspace: actorWorkspaces[options.actorAlias],
    command: options.command
      ?? (options.operation === 'production-deploy' ? 'deploy-production'
        : options.operation === 'database-write' ? 'database-write'
          : options.operation === 'rollback' ? 'rollback'
            : options.operation === 'issue-work' ? 'submit' : undefined),
    commandArgs: options.commandArgs
      ?? (['production-deploy', 'database-write', 'rollback'].includes(options.operation)
        ? ['--revision', options.revision ?? previousRevision]
        : options.operation === 'issue-work' && options.command === 'restart'
          ? ['--job', 'job-1']
          : []),
    ...options,
  });
}

function policy(options) {
  return policyFor(adapterFile, options);
}

function runDcg(commandArgs, overrides = {}) {
  const env = {
    ...process.env,
    GATEWAY_PROJECT_YAML: adapterFile,
    PROJECT_GATEWAY_CTL: fakeCtlRelative,
    NAIA_ADK_ROOT: fakeAdkRoot,
    NAIA_DCG_BACKEND: 'project',
    DCG_TEST_SENTINEL: sentinel,
    DCG_TEST_ARGS: projectArgs,
    DCG_TEST_WORKSPACE: projectWorkspace,
    DCG_TEST_CWD: projectCwd,
    ...overrides,
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key];
  }
  return spawnSync('bash', ['ops/gateway/dcg.sh', ...commandArgs], {
    cwd: root,
    encoding: 'utf8',
    env,
  });
}

function resetHandoffs() {
  for (const file of [sentinel, projectArgs, projectWorkspace, projectCwd, adkArgs]) {
    fs.rmSync(file, { force: true });
  }
}

test.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

export {
  adapter,
  adapterFile,
  adapterSource,
  adkArgs,
  contributorWorkspace,
  contributorShellWorkspace,
  evaluatePolicy,
  fakeAdkRoot,
  fakeCtl,
  fakeCtlRelative,
  fs,
  integratorWorkspace,
  issueFile,
  nativeIntegrationAvailable,
  parseYaml,
  path,
  policy,
  policyFor,
  previousRevision,
  productionCtl,
  productionCtlRelative,
  projectArgs,
  projectCwd,
  projectWorkspace,
  registry,
  registryFile,
  releaseApproverWorkspace,
  releaseOwnerWorkspace,
  releaseOwnerShellWorkspace,
  revision,
  root,
  runDcg,
  sentinel,
  spawnSync,
  tempRoot,
  testNow,
  resetHandoffs,
};
