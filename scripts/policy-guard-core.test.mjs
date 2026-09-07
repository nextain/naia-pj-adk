import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { validateNativeCommandContract } from './native-command-validator.mjs';
import { validateParticipantRegistry } from './lib/participant-registry.mjs';
import {
  adapter,
  adapterFile,
  evaluatePolicy,
  issueFile,
  policy,
  policyFor,
  previousRevision,
  registry,
  registryFile,
  revision,
  root,
  tempRoot,
  testNow,
} from './policy-guard-fixture.mjs';

test('launch validates a complete adapter before mutation paths', () => {
  assert.doesNotThrow(() => policy({ operation: 'launch' }));
});

test('the CLI accepts an explicit test clock only when the test gate is enabled', () => {
  const guard = path.join(root, 'scripts/policy-guard.mjs');
  const args = [
    guard,
    '--operation', 'read-only',
    '--adapter', adapterFile,
    '--now', '2026-09-07T09:00:00Z',
  ];
  const deniedEnv = { ...process.env };
  delete deniedEnv.POLICY_GUARD_TEST_CLOCK;
  const denied = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    env: deniedEnv,
  });
  assert.equal(denied.status, 1);
  assert.match(denied.stderr, /test clock is disabled/);

  const allowed = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, POLICY_GUARD_TEST_CLOCK: '1' },
  });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.match(allowed.stdout, /policy guard accepted: read-only/);
});

test('native command contract is versioned at the project boundary', () => {
  const contract = JSON.parse(fs.readFileSync(path.join(root, 'ops/gateway/native-command-contract.json'), 'utf8'));
  assert.doesNotThrow(() => validateNativeCommandContract(contract));
  assert.equal(contract.contract_version, 1);
  assert.deepEqual(Object.keys(contract).sort(), [
    'binding', 'contract_version', 'native_dependency', 'runtime', 'scope',
  ]);
  assert.equal(contract.native_dependency.source_revision, 'a47745a792e6e563acc7fcb50503171f28f2ab8d');
  assert.match(contract.native_dependency.module_sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(contract.native_dependency.adapter).sort(), [
    'readonly_commands', 'unsupported_commands',
  ]);
  assert.deepEqual(contract.native_dependency.adapter.readonly_commands, ['artifacts list']);
  assert.deepEqual(contract.native_dependency.adapter.unsupported_commands, ['artifacts prune', 'retry']);
});

test('participant validation rejects wrong field types and duplicate identity', () => {
  const malformed = {
    participants: [
      {
        discordUserId: 123,
        alias: 'worker',
        project: 'example',
        workspace: 'workspace',
        roles: ['contributor', 'contributor'],
        enabled: 'yes',
        extra: true,
      },
      {
        discordUserId: '4'.repeat(18),
        alias: 'worker',
        project: 'example',
        workspace: 'workspace-two',
        roles: ['contributor'],
      },
    ],
  };
  const problems = validateParticipantRegistry(malformed);
  assert.ok(problems.some((problem) => problem.includes('discordUserId must be')));
  assert.ok(problems.some((problem) => problem.includes('roles[1] repeats')));
  assert.ok(problems.some((problem) => problem.includes('enabled must be boolean')));
  assert.ok(problems.some((problem) => problem.includes('unknown field extra')));
  assert.ok(problems.some((problem) => problem.includes('alias repeats within the project')));
});

test('diagnostics and owner-local launch survive a damaged registry', () => {
  const invalidRegistry = structuredClone(registry);
  invalidRegistry.participants[0].roles = ['unlisted'];
  const invalidFile = path.join(tempRoot, 'invalid-role.json');
  fs.writeFileSync(invalidFile, JSON.stringify(invalidRegistry));
  assert.doesNotThrow(() => evaluatePolicy({
    operation: 'launch',
    adapterFile,
    registryFile: invalidFile,
  }));
  assert.throws(
    () => policy({
      operation: 'issue-work',
      actorAlias: 'contributor',
      issueEvidenceFile: issueFile,
      registryFile: invalidFile,
      day: 1,
      hour: 9,
    }),
    /participant role is not declared by the adapter/,
  );
});

test('legacy adapters require an explicit policy migration', () => {
  const legacyFile = path.join(tempRoot, 'legacy-project.yaml');
  fs.writeFileSync(
    legacyFile,
    fs.readFileSync(adapterFile, 'utf8').replace('policy_contract_version: 1\n', ''),
  );
  assert.throws(
    () => evaluatePolicy({ operation: 'launch', adapterFile: legacyFile }),
    /policy contract version is required; migrate the legacy adapter explicitly/,
  );
});

test('adapters without team policy fail closed until migrated', () => {
  const source = fs.readFileSync(adapterFile, 'utf8');
  const policyStart = source.indexOf('team_policy:\n');
  const discordStart = source.indexOf('discord:\n', policyStart);
  assert.ok(policyStart >= 0 && discordStart > policyStart);
  const missingPolicyFile = path.join(tempRoot, 'missing-team-policy.yaml');
  fs.writeFileSync(missingPolicyFile, source.slice(0, policyStart) + source.slice(discordStart));
  assert.throws(
    () => evaluatePolicy({ operation: 'launch', adapterFile: missingPolicyFile, registryFile }),
    /team policy is required; migrate the legacy adapter explicitly/,
  );
});

test('role groups may overlap and collaborator mutation stays opt-in', () => {
  const compatibilityFile = path.join(tempRoot, 'compatibility-project.yaml');
  const compatibilitySource = fs.readFileSync(adapterFile, 'utf8')
    .replace(
      'contributors: [contributor]\n  integrators: [integrator]\n  release_owners: [release_owner]',
      'contributors: [policy_collaborator]\n  integrators: [workspace_owner]\n  release_owners: [workspace_owner]',
    )
    .replace(
      'issue_work_roles: [contributor, integrator, release_owner]',
      'issue_work_roles: [integrators, release_owners]',
    );
  fs.writeFileSync(compatibilityFile, compatibilitySource);
  const compatibilityCollaboratorWorkspace = path.join(tempRoot, 'workspace-collaborator');
  const compatibilityOwnerWorkspace = path.join(tempRoot, 'workspace-owner');
  fs.mkdirSync(compatibilityCollaboratorWorkspace, { recursive: true });
  fs.mkdirSync(compatibilityOwnerWorkspace, { recursive: true });
  const compatibilityRegistryFile = path.join(tempRoot, 'compatibility-participants.json');
  fs.writeFileSync(compatibilityRegistryFile, JSON.stringify({
    participants: [
      {
        discordUserId: '5'.repeat(18),
        alias: 'collaborator',
        project: 'example',
        workspace: compatibilityCollaboratorWorkspace,
        roles: ['policy_collaborator'],
      },
      {
        discordUserId: '6'.repeat(18),
        alias: 'owner',
        project: 'example',
        workspace: compatibilityOwnerWorkspace,
        roles: ['workspace_owner'],
      },
    ],
  }));
  const compatibilityIssueFile = path.join(tempRoot, 'compatibility-issue.json');
  fs.writeFileSync(compatibilityIssueFile, JSON.stringify({
    repository: adapter.project.repository,
    number: 8,
    state: 'OPEN',
    assignee: 'owner',
  }));
  assert.doesNotThrow(() => evaluatePolicy({
    operation: 'issue-work',
    adapterFile: compatibilityFile,
    registryFile: compatibilityRegistryFile,
    senderId: '6'.repeat(18),
    actorAlias: 'owner',
    issueEvidenceFile: compatibilityIssueFile,
    command: 'submit',
    targetWorkspace: compatibilityOwnerWorkspace,
    now: testNow,
  }));
  const collaboratorIssueFile = path.join(tempRoot, 'compatibility-collaborator-issue.json');
  fs.writeFileSync(collaboratorIssueFile, JSON.stringify({
    repository: adapter.project.repository,
    number: 9,
    state: 'OPEN',
    assignee: 'collaborator',
  }));
  assert.throws(
    () => evaluatePolicy({
      operation: 'issue-work',
      adapterFile: compatibilityFile,
      registryFile: compatibilityRegistryFile,
      senderId: '5'.repeat(18),
      actorAlias: 'collaborator',
      issueEvidenceFile: collaboratorIssueFile,
      command: 'submit',
      targetWorkspace: compatibilityCollaboratorWorkspace,
      now: testNow,
    }),
    /actor has no issue-work role/,
  );
});

test('contact window follows its own schedule', () => {
  assert.doesNotThrow(() => policy({ operation: 'contact-window', day: 1, hour: 9 }));
  assert.throws(
    () => policy({ operation: 'contact-window', day: 6, hour: 9 }),
    /outside the project contact window/,
  );
  assert.throws(
    () => policy({ operation: 'contact-window', day: 'noday', hour: 9 }),
    /requested day is invalid/,
  );
});

test('contact and mutation windows may differ and guard their own operations', () => {
  const splitWindowFile = path.join(tempRoot, 'split-window-project.yaml');
  const source = fs.readFileSync(adapterFile, 'utf8');
  const splitWindowSource = source
    .replace(
      '  work_hours:\n    timezone: UTC\n    days: [mon, tue, wed, thu, fri]\n    start_hour: 9\n    end_hour: 17',
      '  work_hours:\n    timezone: UTC\n    days: [mon, tue, wed, thu, fri]\n    start_hour: 9\n    end_hour: 12',
    )
    .replace(
      '  contact_window:\n    timezone: UTC\n    days: [mon, tue, wed, thu, fri]\n    start_hour: 9\n    end_hour: 17',
      '  contact_window:\n    timezone: UTC\n    days: [mon, tue, wed, thu, fri]\n    start_hour: 13\n    end_hour: 17',
    );
  assert.notEqual(splitWindowSource, source);
  fs.writeFileSync(splitWindowFile, splitWindowSource);

  assert.doesNotThrow(() => policyFor(splitWindowFile, {
    operation: 'contact-window',
    day: 1,
    hour: 13,
  }));
  assert.throws(
    () => policyFor(splitWindowFile, { operation: 'contact-window', day: 1, hour: 10 }),
    /outside the project contact window/,
  );
  assert.doesNotThrow(() => policyFor(splitWindowFile, {
    operation: 'issue-work',
    actorAlias: 'contributor',
    issueEvidenceFile: issueFile,
    day: 1,
    hour: 10,
  }));
  assert.throws(
    () => policyFor(splitWindowFile, {
      operation: 'issue-work',
      actorAlias: 'contributor',
      issueEvidenceFile: issueFile,
      day: 1,
      hour: 13,
    }),
    /outside the project work window/,
  );
});

test('issue work requires an open issue assigned to the active actor', () => {
  assert.doesNotThrow(() => policy({
    operation: 'issue-work',
    actorAlias: 'contributor',
    issueEvidenceFile: issueFile,
  }));
  const mismatch = path.join(tempRoot, 'mismatch.json');
  fs.writeFileSync(mismatch, JSON.stringify({
    ...JSON.parse(fs.readFileSync(issueFile, 'utf8')),
    assignee: 'integrator',
  }));
  assert.throws(
    () => policy({ operation: 'issue-work', actorAlias: 'contributor', issueEvidenceFile: mismatch }),
    /actor must match the issue assignee/,
  );
});

test('production requires release role, open issue, and matching approval', () => {
  const productionIssue = path.join(tempRoot, 'production-issue.json');
  fs.writeFileSync(productionIssue, JSON.stringify({
    repository: adapter.project.repository,
    number: 2,
    state: 'OPEN',
    assignee: 'contributor',
    approval: {
      approved: true,
      approved_by: 'release-approver',
      approved_revision: revision,
    },
  }));
  assert.doesNotThrow(() => policy({
    operation: 'production-deploy',
    actorAlias: 'release-owner',
    issueEvidenceFile: productionIssue,
    revision,
  }));
  const wrongRevision = path.join(tempRoot, 'wrong-revision.json');
  fs.writeFileSync(wrongRevision, JSON.stringify({
    ...JSON.parse(fs.readFileSync(productionIssue, 'utf8')),
    approval: { approved: true, approved_by: 'release-approver', approved_revision: previousRevision },
  }));
  assert.throws(
    () => policy({
      operation: 'production-deploy',
      actorAlias: 'release-owner',
      issueEvidenceFile: wrongRevision,
      revision,
    }),
    /approval does not identify the revision and approver/,
  );

  const unapproved = path.join(tempRoot, 'unapproved-production.json');
  fs.writeFileSync(unapproved, JSON.stringify({
    ...JSON.parse(fs.readFileSync(productionIssue, 'utf8')),
    approval: { approved: false, approved_by: 'release-approver', approved_revision: revision },
  }));
  assert.throws(
    () => policy({
      operation: 'production-deploy',
      actorAlias: 'release-owner',
      issueEvidenceFile: unapproved,
      revision,
    }),
    /approval does not identify the revision and approver/,
  );

  const selfApproved = path.join(tempRoot, 'self-approved-production.json');
  fs.writeFileSync(selfApproved, JSON.stringify({
    ...JSON.parse(fs.readFileSync(productionIssue, 'utf8')),
    assignee: 'release-owner',
    approval: { approved: true, approved_by: 'release-owner', approved_revision: revision },
  }));
  assert.throws(
    () => policy({
      operation: 'production-deploy',
      actorAlias: 'release-owner',
      issueEvidenceFile: selfApproved,
      revision,
    }),
    /approval must be independent of the issue assignee/,
  );
});

test('production policy rejects a non-owner member of a mixed deploy group', () => {
  const mixedAdapterFile = path.join(tempRoot, 'mixed-production-role.yaml');
  const mixedAdapterSource = fs.readFileSync(adapterFile, 'utf8')
    .replace('  integrators: [integrator]', '  integrators: [developer, owner]')
    .replace('  release_owners: [release_owner]', '  release_owners: [owner]')
    .replace('    production_deploy_role: release_owner', '    production_deploy_role: integrators');
  fs.writeFileSync(mixedAdapterFile, mixedAdapterSource);

  const mixedRegistryFile = path.join(tempRoot, 'mixed-production-role-participants.json');
  fs.writeFileSync(mixedRegistryFile, JSON.stringify({
    participants: [
      {
        discordUserId: '7'.repeat(18),
        alias: 'developer',
        project: 'example',
        workspace: 'workspace-developer',
        roles: ['developer'],
      },
      {
        discordUserId: '8'.repeat(18),
        alias: 'owner',
        project: 'example',
        workspace: 'workspace-owner',
        roles: ['owner'],
      },
      {
        discordUserId: '9'.repeat(18),
        alias: 'contributor',
        project: 'example',
        workspace: 'workspace-contributor',
        roles: ['contributor'],
      },
    ],
  }));
  const mixedIssueFile = path.join(tempRoot, 'mixed-production-role-issue.json');
  fs.writeFileSync(mixedIssueFile, JSON.stringify({
    repository: adapter.project.repository,
    number: 10,
    state: 'OPEN',
    assignee: 'contributor',
    approval: {
      approved: true,
      approved_by: 'owner',
      approved_revision: revision,
    },
  }));

  assert.throws(
    () => evaluatePolicy({
      operation: 'production-deploy',
      adapterFile: mixedAdapterFile,
      registryFile: mixedRegistryFile,
      senderId: '7'.repeat(18),
      actorAlias: 'developer',
      issueEvidenceFile: mixedIssueFile,
      revision,
      day: 1,
      hour: 9,
      now: testNow,
    }),
    /policy contract is incomplete: team_policy\.authorization\.production_deploy_role must resolve only to release owner roles/,
  );
});

test('database writes and incident rollback have separate role guards', () => {
  const databaseIssue = path.join(tempRoot, 'database-issue.json');
  fs.writeFileSync(databaseIssue, JSON.stringify({
    repository: adapter.project.repository,
    number: 3,
    state: 'OPEN',
    assignee: 'integrator',
    explicit_authority: true,
  }));
  assert.doesNotThrow(() => policy({
    operation: 'database-write',
    actorAlias: 'integrator',
    issueEvidenceFile: databaseIssue,
    revision,
  }));
  const rollbackIssue = path.join(tempRoot, 'rollback-issue.json');
  fs.writeFileSync(rollbackIssue, JSON.stringify({
    repository: adapter.project.repository,
    number: 4,
    state: 'OPEN',
    assignee: 'contributor',
    previous_revision: previousRevision,
    rollback_artifact: 'materialized-before-change',
  }));
  assert.doesNotThrow(() => policy({
    operation: 'rollback',
    actorAlias: 'release-owner',
    issueEvidenceFile: rollbackIssue,
    revision: previousRevision,
  }));
  assert.throws(
    () => policy({ operation: 'database-write', actorAlias: 'contributor', issueEvidenceFile: issueFile }),
    /no database role/,
  );

  const noAuthority = path.join(tempRoot, 'database-without-authority.json');
  fs.writeFileSync(noAuthority, JSON.stringify({
    ...JSON.parse(fs.readFileSync(databaseIssue, 'utf8')),
    explicit_authority: false,
  }));
  assert.throws(
    () => policy({
      operation: 'database-write',
      actorAlias: 'integrator',
      issueEvidenceFile: noAuthority,
      revision,
    }),
    /explicit database authority is required/,
  );

  assert.throws(
    () => policy({
      operation: 'rollback',
      actorAlias: 'release-owner',
      issueEvidenceFile: rollbackIssue,
      revision,
    }),
    /rollback revision must match the evidence previous revision/,
  );
});
