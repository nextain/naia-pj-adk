import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { authorizeProjectPolicy, PUBLIC_REASONS } from './project-policy-bridge.mjs';

const root = path.resolve(import.meta.dirname, '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'naia-pj-project-policy-'));
const adapterFile = path.join(tempRoot, 'project.yaml');
const registryFile = path.join(tempRoot, 'participants.json');
const issueFile = path.join(tempRoot, 'issue.json');
const workspace = path.join(tempRoot, 'workspace');
const routeFile = path.join(tempRoot, 'route.json');
fs.mkdirSync(workspace, { recursive: true });
fs.copyFileSync(path.join(root, 'projects/example/project.yaml'), adapterFile);
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
`);
const participantId = '1'.repeat(18);
const nowMs = Date.parse('2026-09-07T09:00:00Z');
const baseParticipant = {
  discordUserId: participantId,
  alias: 'contributor',
  project: 'example',
  workspace,
  roles: ['contributor'],
};
fs.writeFileSync(registryFile, JSON.stringify({ participants: [baseParticipant] }));
fs.writeFileSync(issueFile, JSON.stringify({ repository: 'example-owner/example-project', number: 1, state: 'OPEN', assignee: 'contributor' }));
const route = {
  schemaVersion: 1,
  enabled: true,
  project: 'example',
  operation: 'issue-work',
  actorAlias: 'contributor',
  participantUserId: participantId,
  bindingIdentity: 'example:guild:channel',
  backendId: 'codex',
  workspace,
  adapterFile,
  registryFile,
  issueEvidenceFile: issueFile,
  command: 'submit',
  commandArgs: [],
};
const input = {
  schemaVersion: 1,
  participantUserId: participantId,
  bindingIdentity: route.bindingIdentity,
  participantProfile: { ...baseParticipant },
  backendId: 'codex',
  cwd: workspace,
  allowedPaths: [workspace],
  access: 'workspace-write',
  jobId: 'job-1',
  phase: 'pre_spawn',
  nowMs,
};

function runNative(nativeInput = input, nativeRoute = route) {
  fs.writeFileSync(routeFile, JSON.stringify(nativeRoute));
  return spawnSync(process.execPath, [path.join(root, 'scripts/project-policy-bridge.mjs'), '--route', routeFile], {
    cwd: root,
    input: JSON.stringify(nativeInput),
    encoding: 'utf8',
  });
}

test.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

test('native bridge authorizes the exact authenticated project participant', () => {
  const result = authorizeProjectPolicy({ route, input });
  assert.deepEqual(result.allowed, true);
  assert.equal(result.cwd, fs.realpathSync.native(workspace));
  assert.deepEqual(result.allowedPaths, [fs.realpathSync.native(workspace)]);
  assert.equal(result.participantUserId, participantId);
  assert.equal(result.bindingIdentity, route.bindingIdentity);
  assert.equal(result.access, 'workspace-write');
});

test('native bridge binds the route project to the adapter identity', () => {
  const result = authorizeProjectPolicy({
    route: { ...route, project: 'other-project' },
    input,
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reasonCode, 'project_policy_authority_changed');
});

test('native bridge re-reads registry and returns a bounded authority denial', () => {
  fs.writeFileSync(registryFile, JSON.stringify({ participants: [{ ...baseParticipant, alias: 'renamed' }] }));
  const result = authorizeProjectPolicy({ route, input });
  assert.equal(result.allowed, false);
  assert.ok(PUBLIC_REASONS.has(result.reasonCode));
  assert.equal(result.reasonCode, 'project_policy_authority_changed');
  assert.equal(Object.hasOwn(result, 'message'), false);
  fs.writeFileSync(registryFile, JSON.stringify({ participants: [baseParticipant] }));
});

test('participant mutation window narrows project work and closes at the boundary', () => {
  fs.writeFileSync(registryFile, JSON.stringify({ participants: [{ ...baseParticipant, mutationWindow: { timezone: 'UTC', days: [1], start: '10:00', end: '11:00' } }] }));
  const result = authorizeProjectPolicy({ route, input });
  assert.equal(result.allowed, false);
  assert.equal(result.reasonCode, 'project_policy_window_closed');
  fs.writeFileSync(registryFile, JSON.stringify({ participants: [baseParticipant] }));
});

test('native CLI output is safe and proves the real child boundary', () => {
  const child = runNative();
  assert.equal(child.status, 0);
  assert.equal(child.stderr, '');
  const result = JSON.parse(child.stdout);
  assert.equal(result.allowed, true);
  assert.equal(result.cwd, fs.realpathSync.native(workspace));
  const otherWorkspace = path.join(tempRoot, 'other');
  fs.mkdirSync(otherWorkspace, { recursive: true });
  const denied = runNative({ ...input, cwd: otherWorkspace, allowedPaths: [otherWorkspace] });
  assert.equal(denied.status, 0);
  const deniedResult = JSON.parse(denied.stdout);
  assert.equal(deniedResult.allowed, false);
  assert.ok(PUBLIC_REASONS.has(deniedResult.reasonCode));
  assert.equal(deniedResult.reasonCode, 'project_policy_workspace_mismatch');
  assert.equal(denied.stdout.includes(tempRoot), false);
});
