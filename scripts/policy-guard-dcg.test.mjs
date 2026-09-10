import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  adapter, adapterFile, adapterSource, adkArgs, contributorShellWorkspace, contributorWorkspace, fakeAdkRoot, fakeCtl,
  fakeCtlRelative, issueFile, nativeIntegrationAvailable, previousRevision,
  productionCtlRelative, projectArgs, projectCwd, projectWorkspace, registryFile,
  releaseOwnerShellWorkspace, releaseOwnerWorkspace, revision, root, runDcg, sentinel, tempRoot, resetHandoffs,
} from './policy-guard-fixture.mjs';

test('dcg runs the policy guard before handing off to the project runtime', () => {
  const result = spawnSync('bash', ['ops/gateway/dcg.sh', 'status'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      GATEWAY_PROJECT_YAML: adapterFile,
      PROJECT_GATEWAY_CTL: fakeCtl,
      NAIA_DCG_BACKEND: 'project',
      DCG_TEST_SENTINEL: sentinel,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'handoff');

  fs.rmSync(sentinel, { force: true });
  const unsetOperation = spawnSync('bash', ['ops/gateway/dcg.sh', 'submit'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      GATEWAY_PROJECT_YAML: adapterFile,
      PROJECT_GATEWAY_CTL: fakeCtl,
      NAIA_DCG_BACKEND: 'project',
      DCG_TEST_SENTINEL: sentinel,
    },
  });
  assert.equal(unsetOperation.status, 1);
  assert.equal(fs.existsSync(sentinel), false);

  const mismatchedLaunch = spawnSync('bash', ['ops/gateway/dcg.sh', 'submit'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      GATEWAY_PROJECT_YAML: adapterFile,
      PROJECT_GATEWAY_CTL: fakeCtl,
      NAIA_DCG_BACKEND: 'project',
      PROJECT_POLICY_OPERATION: 'launch',
      DCG_TEST_SENTINEL: sentinel,
    },
  });
  assert.equal(mismatchedLaunch.status, 1);
  assert.equal(fs.existsSync(sentinel), false);

  const misclassifiedReadOnly = spawnSync('bash', ['ops/gateway/dcg.sh', 'submit'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      GATEWAY_PROJECT_YAML: adapterFile,
      PROJECT_GATEWAY_CTL: fakeCtl,
      NAIA_DCG_BACKEND: 'project',
      PROJECT_POLICY_OPERATION: 'read-only',
      DCG_TEST_SENTINEL: sentinel,
    },
  });
  assert.equal(misclassifiedReadOnly.status, 1);
  assert.match(misclassifiedReadOnly.stderr, /read-only policy is only valid/);
  assert.equal(fs.existsSync(sentinel), false);

  const issueEnv = {
    ...process.env,
    GATEWAY_PROJECT_YAML: adapterFile,
    GATEWAY_PARTICIPANT_REGISTRY: registryFile,
    PROJECT_GATEWAY_CTL: fakeCtlRelative,
    NAIA_DCG_BACKEND: 'project',
    PROJECT_POLICY_OPERATION: 'issue-work',
    POLICY_SENDER_ID: '1'.repeat(18),
    POLICY_ACTOR_ALIAS: 'contributor',
    POLICY_ISSUE_EVIDENCE: issueFile,
    POLICY_GUARD_TEST_CLOCK: '1',
    POLICY_DAY: '1',
    POLICY_HOUR: '9',
    PROJECT_GATEWAY_WORKSPACE: contributorWorkspace,
    DCG_TEST_SENTINEL: sentinel,
    DCG_TEST_ARGS: projectArgs,
    DCG_TEST_WORKSPACE: projectWorkspace,
    DCG_TEST_CWD: projectCwd,
  };
  const delegatedIssue = spawnSync('bash', ['ops/gateway/dcg.sh', 'submit'], {
    cwd: root,
    encoding: 'utf8',
    env: issueEnv,
  });
  assert.equal(delegatedIssue.status, 0, delegatedIssue.stderr);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'handoff');
  assert.equal(
    fs.readFileSync(projectArgs, 'utf8'),
    `submit --issue-repository ${adapter.project.repository} --issue-number 1 --issue-assignee contributor`,
  );
  assert.equal(fs.readFileSync(projectWorkspace, 'utf8'), contributorShellWorkspace);
  assert.equal(fs.readFileSync(projectCwd, 'utf8').trim(), contributorShellWorkspace);

  fs.rmSync(sentinel, { force: true });
  const restartedIssue = spawnSync('bash', ['ops/gateway/dcg.sh', 'restart', '--job', 'job-1'], {
    cwd: root,
    encoding: 'utf8',
    env: issueEnv,
  });
  assert.equal(restartedIssue.status, 0, restartedIssue.stderr);
  assert.equal(
    fs.readFileSync(projectArgs, 'utf8'),
    `restart --job job-1 --issue-repository ${adapter.project.repository} --issue-number 1 --issue-assignee contributor`,
  );
  assert.equal(fs.readFileSync(projectWorkspace, 'utf8'), contributorShellWorkspace);
  assert.equal(fs.readFileSync(projectCwd, 'utf8').trim(), contributorShellWorkspace);

  fs.rmSync(sentinel, { force: true });
  fs.rmSync(projectCwd, { force: true });
  const mismatchedIssueWorkspace = spawnSync('bash', ['ops/gateway/dcg.sh', 'submit'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...issueEnv, PROJECT_GATEWAY_WORKSPACE: releaseOwnerWorkspace },
  });
  assert.equal(mismatchedIssueWorkspace.status, 1);
  assert.match(mismatchedIssueWorkspace.stderr, /workspace/);
  assert.equal(fs.existsSync(sentinel), false);
  assert.equal(fs.existsSync(projectCwd), false);

  fs.rmSync(sentinel, { force: true });
  const unauthenticatedIssue = spawnSync('bash', ['ops/gateway/dcg.sh', 'submit'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...issueEnv, POLICY_SENDER_ID: undefined },
  });
  assert.equal(unauthenticatedIssue.status, 1);
  assert.equal(fs.existsSync(sentinel), false);

  const nativeIssue = spawnSync('bash', ['ops/gateway/dcg.sh', 'submit'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...issueEnv, NAIA_DCG_BACKEND: 'adk' },
  });
  assert.equal(nativeIssue.status, 1);
  assert.match(nativeIssue.stderr, /explicit project backend.*unsupported/);
  assert.equal(fs.existsSync(sentinel), false);

  const unsupportedRetry = spawnSync('bash', ['ops/gateway/dcg.sh', 'retry'], {
    cwd: root,
    encoding: 'utf8',
    env: issueEnv,
  });
  assert.equal(unsupportedRetry.status, 1);
  assert.match(unsupportedRetry.stderr, /native runtime has no retry command/);
  assert.equal(fs.existsSync(sentinel), false);

  const malformedAdapter = path.join(tempRoot, 'malformed.yaml');
  fs.writeFileSync(
    malformedAdapter,
    fs.readFileSync(adapterFile, 'utf8').replace('chat_grants_authority: false', 'chat_grants_authority: true'),
  );
  const rejectedResult = spawnSync('bash', ['ops/gateway/dcg.sh', 'status'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      GATEWAY_PROJECT_YAML: malformedAdapter,
      PROJECT_GATEWAY_CTL: fakeCtl,
      NAIA_DCG_BACKEND: 'project',
      DCG_TEST_SENTINEL: path.join(tempRoot, 'rejected-handoff.txt'),
    },
  });
  assert.equal(rejectedResult.status, 1);
  assert.equal(fs.existsSync(path.join(tempRoot, 'rejected-handoff.txt')), false);
});

test('dcg keeps native management and artifact mutation boundaries explicit', { skip: !nativeIntegrationAvailable }, () => {
  const nativeEnv = {
    NAIA_DCG_BACKEND: 'adk',
    DCG_TEST_ADK_ARGS: adkArgs,
    PROJECT_POLICY_OPERATION: undefined,
  };

  resetHandoffs();
  let result = runDcg(['cutover', 'prepare'], nativeEnv);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(adkArgs, 'utf8'), 'cutover prepare');
  assert.equal(fs.existsSync(sentinel), false);

  resetHandoffs();
  result = runDcg(['artifacts', 'list'], nativeEnv);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(adkArgs, 'utf8'), 'artifacts list');
  assert.equal(fs.existsSync(sentinel), false);

  resetHandoffs();
  result = runDcg(['artifacts', 'prune'], nativeEnv);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /artifacts prune.*mutating native operation/);
  assert.equal(fs.existsSync(adkArgs), false);
  assert.equal(fs.existsSync(sentinel), false);

  resetHandoffs();
  result = runDcg(['cutover', 'prepare', '--revision', revision], nativeEnv);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--revision is reserved/);
  assert.equal(fs.existsSync(adkArgs), false);
  assert.equal(fs.existsSync(sentinel), false);

  resetHandoffs();
  result = runDcg(['cancel', '--job', 'job-1'], nativeEnv);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(adkArgs, 'utf8'), 'cancel --job job-1');
  assert.equal(fs.existsSync(sentinel), false);

  resetHandoffs();
  result = runDcg(['cancel'], nativeEnv);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cancel requires exactly one --job/);
  assert.equal(fs.existsSync(adkArgs), false);
  assert.equal(fs.existsSync(sentinel), false);

  resetHandoffs();
  result = runDcg(['cancel', '--job', 'job-1', '--extra'], nativeEnv);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cancel accepts only --job/);
  assert.equal(fs.existsSync(adkArgs), false);
  assert.equal(fs.existsSync(sentinel), false);

  resetHandoffs();
  result = runDcg(['cancel', '--job', 'job-1', '--job', 'job-2'], nativeEnv);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cancel requires exactly one --job/);
  assert.equal(fs.existsSync(adkArgs), false);
  assert.equal(fs.existsSync(sentinel), false);
});

test('dcg routes only an explicit bounded attachment download to native runtime', { skip: !nativeIntegrationAvailable }, () => {
  const outputPath = path.join(contributorWorkspace, 'attachment.bin');
  const nativeEnv = {
    NAIA_DCG_BACKEND: 'adk',
    DCG_TEST_ADK_ARGS: adkArgs,
    PROJECT_POLICY_OPERATION: undefined,
  };

  resetHandoffs();
  let result = runDcg(
    ['attachment', '--channel', 'channel', '--message', 'message', '--attachment', 'attachment', '--output', outputPath],
    nativeEnv,
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /set PROJECT_POLICY_OPERATION=attachment-download/);
  assert.equal(fs.existsSync(adkArgs), false);
  assert.equal(fs.existsSync(sentinel), false);

  resetHandoffs();
  result = runDcg(
    ['attachment', '--channel', 'channel', '--message', 'message', '--attachment', 'attachment', '--output', outputPath],
    {
      ...nativeEnv,
      PROJECT_POLICY_OPERATION: 'attachment-download',
      GATEWAY_PARTICIPANT_REGISTRY: registryFile,
      POLICY_SENDER_ID: '1'.repeat(18),
      POLICY_ACTOR_ALIAS: 'contributor',
      PROJECT_GATEWAY_WORKSPACE: contributorWorkspace,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    fs.readFileSync(adkArgs, 'utf8'),
    `attachment --channel channel --message message --attachment attachment --output ${outputPath}`,
  );
  assert.equal(fs.existsSync(sentinel), false);

  const workspaceAlias = path.join(tempRoot, 'workspace-contributor-alias');
  fs.symlinkSync(contributorWorkspace, workspaceAlias, 'dir');
  const aliasedOutput = path.join(workspaceAlias, 'aliased-attachment.bin');
  resetHandoffs();
  result = runDcg(
    ['attachment', '--channel', 'channel', '--message', 'message', '--attachment', 'attachment', '--output', aliasedOutput],
    {
      ...nativeEnv,
      PROJECT_POLICY_OPERATION: 'attachment-download',
      GATEWAY_PARTICIPANT_REGISTRY: registryFile,
      POLICY_SENDER_ID: '1'.repeat(18),
      POLICY_ACTOR_ALIAS: 'contributor',
      PROJECT_GATEWAY_WORKSPACE: `${contributorWorkspace}/`,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(adkArgs, 'utf8'),
    `attachment --channel channel --message message --attachment attachment --output ${aliasedOutput}`);

  const outsideOutput = path.join(tempRoot, 'outside-attachment.bin');
  resetHandoffs();
  result = runDcg(
    ['attachment', '--channel', 'channel', '--message', 'message', '--attachment', 'attachment', '--output', outsideOutput],
    {
      ...nativeEnv,
      PROJECT_POLICY_OPERATION: 'attachment-download',
      GATEWAY_PARTICIPANT_REGISTRY: registryFile,
      POLICY_SENDER_ID: '1'.repeat(18),
      POLICY_ACTOR_ALIAS: 'contributor',
      PROJECT_GATEWAY_WORKSPACE: contributorWorkspace,
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /inside the authenticated workspace/);
  assert.equal(fs.existsSync(adkArgs), false);

  const existingOutput = path.join(contributorWorkspace, 'existing-attachment.bin');
  fs.writeFileSync(existingOutput, 'fixture');
  resetHandoffs();
  result = runDcg(
    ['attachment', '--channel', 'channel', '--message', 'message', '--attachment', 'attachment', '--output', existingOutput],
    {
      ...nativeEnv,
      PROJECT_POLICY_OPERATION: 'attachment-download',
      GATEWAY_PARTICIPANT_REGISTRY: registryFile,
      POLICY_SENDER_ID: '1'.repeat(18),
      POLICY_ACTOR_ALIAS: 'contributor',
      PROJECT_GATEWAY_WORKSPACE: contributorWorkspace,
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /already exists/);
  assert.equal(fs.existsSync(adkArgs), false);
  fs.rmSync(existingOutput, { force: true });
  fs.unlinkSync(workspaceAlias);
});

test('dcg preserves trusted diagnostics and owner-local recovery with a damaged registry', () => {
  const invalidRegistry = path.join(tempRoot, 'dcg-invalid-registry.json');
  fs.writeFileSync(invalidRegistry, JSON.stringify({ participants: [{ discordUserId: 123 }] }));

  resetHandoffs();
  let result = runDcg(['status'], { GATEWAY_PARTICIPANT_REGISTRY: invalidRegistry });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'handoff');

  resetHandoffs();
  result = runDcg(['service', 'restart'], {
    PROJECT_POLICY_OPERATION: 'launch',
    GATEWAY_PARTICIPANT_REGISTRY: invalidRegistry,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'handoff');

  resetHandoffs();
  result = runDcg(['submit'], {
    GATEWAY_PARTICIPANT_REGISTRY: invalidRegistry,
    PROJECT_POLICY_OPERATION: 'issue-work',
    POLICY_SENDER_ID: '1'.repeat(18),
    POLICY_ACTOR_ALIAS: 'contributor',
    POLICY_ISSUE_EVIDENCE: issueFile,
    POLICY_GUARD_TEST_CLOCK: '1',
    POLICY_DAY: '1',
    POLICY_HOUR: '9',
    PROJECT_GATEWAY_WORKSPACE: contributorWorkspace,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /runtime registry failed its schema/);
  assert.equal(fs.existsSync(sentinel), false);
});

test('dcg requires declared project capability and unambiguous high-impact revision syntax', () => {
  const productionIssue = path.join(tempRoot, 'dcg-production-issue.json');
  fs.writeFileSync(productionIssue, JSON.stringify({
    repository: adapter.project.repository,
    number: 11,
    state: 'OPEN',
    assignee: 'contributor',
    approval: {
      approved: true,
      approved_by: 'release-approver',
      approved_revision: revision,
    },
  }));
  const baseProductionEnv = {
    GATEWAY_PARTICIPANT_REGISTRY: registryFile,
    PROJECT_GATEWAY_CTL: productionCtlRelative,
    PROJECT_POLICY_OPERATION: 'production-deploy',
    POLICY_SENDER_ID: '3'.repeat(18),
    POLICY_ACTOR_ALIAS: 'release-owner',
    POLICY_ISSUE_EVIDENCE: productionIssue,
    POLICY_GUARD_TEST_CLOCK: '1',
    POLICY_DAY: '1',
    POLICY_HOUR: '9',
    PROJECT_GATEWAY_WORKSPACE: releaseOwnerWorkspace,
    DCG_TEST_ARGS: projectArgs,
    DCG_TEST_WORKSPACE: projectWorkspace,
    DCG_TEST_CWD: projectCwd,
  };
  const missingCapabilityAdapter = path.join(tempRoot, 'dcg-no-project-capability.yaml');
  fs.copyFileSync(adapterSource, missingCapabilityAdapter);

  resetHandoffs();
  let result = runDcg(['deploy-production', '--revision', revision], {
    ...baseProductionEnv,
    GATEWAY_PROJECT_YAML: missingCapabilityAdapter,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /capability for production-deploy is not declared/);
  assert.equal(fs.existsSync(sentinel), false);

  resetHandoffs();
  result = runDcg(['deploy-production', `--revision=${revision}`], baseProductionEnv);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /separate --revision/);
  assert.equal(fs.existsSync(sentinel), false);

  resetHandoffs();
  result = runDcg(['deploy-production', '--revision', revision, '--revision', revision], baseProductionEnv);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /exactly one full --revision SHA/);
  assert.equal(fs.existsSync(sentinel), false);

  resetHandoffs();
  result = runDcg(['deploy-production', '--revision', revision, '--'], baseProductionEnv);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /option terminator/);
  assert.equal(fs.existsSync(sentinel), false);

  resetHandoffs();
  result = runDcg(['--instance', 'worker', 'deploy-production', '--revision', revision], baseProductionEnv);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--instance is reserved/);
  assert.equal(fs.existsSync(sentinel), false);
});

test('dcg binds the approved production revision to the delegated command', () => {
  const productionIssue = path.join(tempRoot, 'production-issue.json');
  fs.writeFileSync(productionIssue, JSON.stringify({
    repository: adapter.project.repository,
    number: 11,
    state: 'OPEN',
    assignee: 'contributor',
    approval: {
      approved: true,
      approved_by: 'release-approver',
      approved_revision: revision,
    },
  }));
  const productionArgs = path.join(tempRoot, 'production-args.txt');
  const productionEnv = {
    ...process.env,
    GATEWAY_PROJECT_YAML: adapterFile,
    GATEWAY_PARTICIPANT_REGISTRY: registryFile,
    PROJECT_GATEWAY_CTL: productionCtlRelative,
    NAIA_DCG_BACKEND: 'project',
    PROJECT_POLICY_OPERATION: 'production-deploy',
    POLICY_SENDER_ID: '3'.repeat(18),
    POLICY_ACTOR_ALIAS: 'release-owner',
    POLICY_ISSUE_EVIDENCE: productionIssue,
    POLICY_GUARD_TEST_CLOCK: '1',
    POLICY_DAY: '1',
    POLICY_HOUR: '9',
    PROJECT_GATEWAY_WORKSPACE: releaseOwnerWorkspace,
    DCG_TEST_SENTINEL: sentinel,
    DCG_TEST_ARGS: productionArgs,
    DCG_TEST_WORKSPACE: projectWorkspace,
    DCG_TEST_CWD: projectCwd,
  };
  const delegated = spawnSync('bash', ['ops/gateway/dcg.sh', 'deploy-production', '--revision', revision], {
    cwd: root,
    encoding: 'utf8',
    env: productionEnv,
  });
  assert.equal(delegated.status, 0, delegated.stderr);
  assert.equal(fs.readFileSync(productionArgs, 'utf8'), `deploy-production --revision ${revision}`);
  assert.equal(fs.readFileSync(projectWorkspace, 'utf8'), releaseOwnerShellWorkspace);
  assert.equal(fs.readFileSync(projectCwd, 'utf8').trim(), releaseOwnerShellWorkspace);

  fs.rmSync(sentinel, { force: true });
  const mismatched = spawnSync('bash', ['ops/gateway/dcg.sh', 'deploy-production', '--revision', revision], {
    cwd: root,
    encoding: 'utf8',
    env: { ...productionEnv, POLICY_REVISION: previousRevision },
  });
  assert.equal(mismatched.status, 1);
  assert.equal(fs.existsSync(sentinel), false);

  const missingRevision = spawnSync('bash', ['ops/gateway/dcg.sh', 'deploy-production'], {
    cwd: root,
    encoding: 'utf8',
    env: productionEnv,
  });
  assert.equal(missingRevision.status, 1);
  assert.equal(fs.existsSync(sentinel), false);
});
