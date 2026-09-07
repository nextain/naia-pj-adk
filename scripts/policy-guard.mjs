#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertAdapterContractShape,
  normalizeDay,
  requireSchedule,
  roleTokenResolves,
} from './lib/adapter-contract.mjs';
import {
  activeParticipantsForProject,
  validateParticipantRegistry,
} from './lib/participant-registry.mjs';
import { mutationWindowStatus } from './lib/mutation-window.mjs';
import {
  buildProjectBackendArgs,
  isObject,
  nonEmptyString,
  parseIssueEvidence,
  readYaml,
  requireProjectBackendCommand,
} from './project-backend-command.mjs';

// This guard is the common runtime boundary for project adapters. It checks
// the owner-managed projections that an adapter may use to route a request;
// it does not impersonate a GitHub client, sandbox a host, or activate a
// Discord connection. Credentials and the source of authentication stay
// outside the repository.

const OPERATIONS = new Set([
  'read-only',
  'launch',
  'runtime-management',
  'contact-window',
  'issue-work',
  'production-deploy',
  'database-write',
  'rollback',
  'attachment-download',
]);
const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const SENDER_ID_PATTERN = /^[0-9]{17,20}$/;

function rejected(reason) {
  const error = new Error(reason);
  error.policyGuard = true;
  return error;
}

function readJson(file, reason) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw rejected(reason);
  }
}

function findRepoRoot(adapterFile) {
  let current = path.dirname(adapterFile);
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

function resolveRegistry(adapter, adapterFile, explicitRegistry) {
  const root = findRepoRoot(adapterFile);
  const configured = explicitRegistry || adapter.discord.runtime_registry;
  if (!nonEmptyString(configured)) throw rejected('runtime registry path is missing');
  return path.isAbsolute(configured) ? configured : path.resolve(root, configured);
}

function knownRoleGroups(adapter) {
  return {
    contributors: new Set(adapter.roles.contributors),
    integrators: new Set(adapter.roles.integrators),
    release_owners: new Set(adapter.roles.release_owners),
  };
}

function allKnownRoles(adapter) {
  const groups = knownRoleGroups(adapter);
  return new Set([...groups.contributors, ...groups.integrators, ...groups.release_owners]);
}

function roleSetForToken(adapter, token) {
  if (!nonEmptyString(token)) return new Set();
  return new Set(roleTokenResolves(token, adapter.roles));
}

function roleSetForTokens(adapter, tokens) {
  const result = new Set();
  for (const token of tokens) {
    for (const role of roleSetForToken(adapter, token)) result.add(role);
  }
  return result;
}

function validateRoleProjection(adapter, participants) {
  const groups = knownRoleGroups(adapter);
  const known = allKnownRoles(adapter);
  if (roleSetForToken(adapter, adapter.team_policy.authorization.production_deploy_role).size === 0) {
    throw rejected('production deploy role is not declared');
  }
  for (const role of adapter.team_policy.authorization.issue_work_roles) {
    if (roleSetForToken(adapter, role).size === 0) {
      throw rejected('issue-work role is not declared');
    }
  }
  for (const tier of ['development', 'production']) {
    for (const deployer of adapter.tiers[tier].deployable_by) {
      if (roleSetForToken(adapter, deployer).size === 0) {
        throw rejected('tier deployer role or group is not declared');
      }
    }
  }
  for (const participant of participants) {
    if (participant.roles.some((role) => !known.has(role))) {
      throw rejected('participant role is not declared by the adapter');
    }
  }
  return groups;
}

function loadParticipants(adapter, adapterFile, explicitRegistry, required) {
  const registryFile = resolveRegistry(adapter, adapterFile, explicitRegistry);
  if (!fs.existsSync(registryFile)) {
    if (!required) {
      validateRoleProjection(adapter, []);
      return [];
    }
    throw rejected('runtime registry is required for this operation');
  }
  const registry = readJson(registryFile, 'runtime registry could not be read');
  const problems = validateParticipantRegistry(registry);
  if (problems.length) throw rejected('runtime registry failed its schema and identity checks');
  const participants = activeParticipantsForProject(registry, adapter.project.id);
  validateRoleProjection(adapter, participants);
  return participants;
}

function requireActor(participants, senderId, expectedAlias) {
  if (!nonEmptyString(senderId) || !SENDER_ID_PATTERN.test(senderId)) {
    throw rejected('an authenticated sender id is required');
  }
  const actor = participants.find((participant) => participant.discordUserId === senderId);
  if (!actor) throw rejected('sender is not an active participant for this project');
  if (expectedAlias !== undefined && expectedAlias !== actor.alias) {
    throw rejected('actor alias does not match the authenticated sender');
  }
  return actor;
}

function requireActiveAssignee(participants, evidence) {
  const assignee = participants.find((participant) => participant.alias === evidence.assignee);
  if (!assignee) throw rejected('issue assignee is not an active participant');
  return assignee;
}

function requireIssueAssignee(evidence, actor) {
  if (evidence.assignee !== actor.alias) {
    throw rejected('actor must match the issue assignee');
  }
}

function requireRevision(value) {
  if (!nonEmptyString(value) || !SHA_PATTERN.test(value)) {
    throw rejected('a full revision SHA is required');
  }
}

function requireWindow(schedule, day, hour, label) {
  let normalizedDay;
  try {
    normalizedDay = normalizeDay(day, 'requested day');
  } catch {
    throw rejected('requested day is invalid');
  }
  if (!Number.isInteger(Number(hour)) || Number(hour) < 0 || Number(hour) > 23) {
    throw rejected('requested hour is invalid');
  }
  const numericHour = Number(hour);
  if (!schedule.days.includes(normalizedDay)
      || numericHour < schedule.start_hour
      || numericHour >= schedule.end_hour) {
    throw rejected(`the requested time is outside the ${label} window`);
  }
}

function requireCurrentWindow(schedule, day, hour, now, label) {
  // day/hour are accepted only by direct tests or the explicitly marked test
  // clock in the CLI. A normal invocation derives both values from the host
  // clock in the adapter's timezone, so a caller cannot claim that a request
  // happened during work hours by setting an ordinary request field.
  if (day !== undefined || hour !== undefined) {
    requireWindow(schedule, day, hour, label);
    return;
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: schedule.timezone,
    weekday: 'short',
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(now ?? new Date());
  const part = (type) => parts.find((item) => item.type === type)?.value;
  requireWindow(schedule, part('weekday'), Number(part('hour')), label);
}

function requireParticipantWindow(actor, now) {
  if (!Object.hasOwn(actor, 'mutationWindow')) return;
  let status;
  try {
    status = mutationWindowStatus(actor.mutationWindow, now ?? Date.now());
  } catch {
    throw rejected('participant mutation window is invalid');
  }
  if (!status.allowed) throw rejected('participant mutation window is closed');
}

function requireRole(actor, roleSet, reason) {
  if (!actor.roles.some((role) => roleSet.has(role))) throw rejected(reason);
}

function canonicalWorkspace(value, label) {
  if (!nonEmptyString(value) || !path.isAbsolute(value)) {
    throw rejected(`${label} must be an absolute existing directory`);
  }
  let stats;
  try {
    stats = fs.statSync(value);
  } catch {
    throw rejected(`${label} must be an absolute existing directory`);
  }
  if (!stats.isDirectory()) throw rejected(`${label} must be an absolute existing directory`);
  try {
    return fs.realpathSync.native(value);
  } catch {
    throw rejected(`${label} could not be resolved`);
  }
}

function requireTargetWorkspace(actor, targetWorkspace, operation) {
  const actorWorkspace = canonicalWorkspace(actor.workspace, 'participant workspace');
  const requestedWorkspace = canonicalWorkspace(targetWorkspace, `${operation} target workspace`);
  if (requestedWorkspace !== actorWorkspace) {
    throw rejected('target workspace does not match the authenticated participant');
  }
  return requestedWorkspace;
}

function requireAttachmentOutput(actor, targetWorkspace, output) {
  const workspace = requireTargetWorkspace(actor, targetWorkspace, 'attachment-download');
  if (!nonEmptyString(output) || !path.isAbsolute(output)) {
    throw rejected('attachment output must be an absolute path inside the authenticated workspace');
  }
  let parent;
  try {
    parent = fs.realpathSync.native(path.dirname(output));
  } catch {
    throw rejected('attachment output parent must be an existing directory inside the authenticated workspace');
  }
  const relative = path.relative(workspace, parent);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw rejected('attachment output must stay inside the authenticated workspace');
  }
  try {
    if (fs.lstatSync(output)) {
      throw rejected('attachment output already exists; native downloads must not overwrite files');
    }
  } catch (error) {
    if (error?.policyGuard) throw error;
    if (error?.code !== 'ENOENT') throw rejected('attachment output could not be inspected safely');
  }
  return { workspace, output };
}

function evaluatePolicy({
  operation,
  adapterFile,
  registryFile,
  actorAlias,
  senderId,
  issueEvidenceFile,
  revision,
  command,
  commandArgs = [],
  targetWorkspace,
  output,
  day,
  hour,
  now,
}) {
  if (!OPERATIONS.has(operation)) throw rejected('unknown policy operation');
  if (!nonEmptyString(adapterFile)) throw rejected('an adapter path is required');
  const absoluteAdapter = path.resolve(adapterFile);
  const adapter = readYaml(absoluteAdapter);
  if (!Object.hasOwn(adapter, 'policy_contract_version')) {
    throw rejected('policy contract version is required; migrate the legacy adapter explicitly');
  }
  if (!Object.hasOwn(adapter, 'team_policy')) {
    throw rejected('team policy is required; migrate the legacy adapter explicitly');
  }
  try {
    assertAdapterContractShape(adapter, 'adapter');
  } catch (error) {
    if (error instanceof Error && /policy_contract_version|team_policy|issue_work_roles|contact_window/.test(error.message)) {
      throw rejected(`policy contract is incomplete: ${error.message.replace(/^adapter\.?/, '')}`);
    }
    throw rejected('adapter contract is invalid');
  }

  if (operation === 'contact-window') {
    try {
      const contactSchedule = requireSchedule(adapter.discord.contact_window, 'discord.contact_window');
      requireCurrentWindow(contactSchedule, day, hour, now, 'project contact');
    } catch (error) {
      if (error.policyGuard) throw error;
      throw rejected('work-hour policy is invalid');
    }
    return;
  }

  // Diagnostics and owner-local service recovery must remain available when a
  // participant projection is damaged. Remote mutation still requires the
  // complete registry and authenticated sender below.
  if (operation === 'read-only' || operation === 'launch' || operation === 'runtime-management') return;

  const requiresRegistry = adapter.discord.enabled
    || ['issue-work', 'production-deploy', 'database-write', 'rollback', 'attachment-download'].includes(operation);
  const participants = loadParticipants(
    adapter,
    absoluteAdapter,
    registryFile,
    requiresRegistry,
  );

  if (['issue-work', 'production-deploy', 'database-write', 'rollback'].includes(operation)) {
    try {
      const workSchedule = requireSchedule(adapter.team_policy.work_hours, 'team_policy.work_hours');
      requireCurrentWindow(workSchedule, day, hour, now, 'project work');
    } catch (error) {
      if (error.policyGuard) throw error;
      throw rejected('work-hour policy is invalid');
    }
  }

  const actor = requireActor(participants, senderId, actorAlias);
  if (['issue-work', 'production-deploy', 'database-write', 'rollback'].includes(operation)) {
    requireParticipantWindow(actor, now);
  }
  if (['issue-work', 'production-deploy', 'database-write', 'rollback', 'attachment-download'].includes(operation)) {
    requireTargetWorkspace(actor, targetWorkspace, operation);
  }
  if (operation === 'attachment-download') {
    requireAttachmentOutput(actor, targetWorkspace, output);
    return;
  }

  const evidence = parseIssueEvidence(issueEvidenceFile, adapter);
  const groups = knownRoleGroups(adapter);

  if (operation === 'issue-work') {
    requireIssueAssignee(evidence, actor);
    requireRole(actor, roleSetForTokens(adapter, adapter.team_policy.authorization.issue_work_roles), 'actor has no issue-work role');
    requireProjectBackendCommand(adapter, operation, command, commandArgs, undefined, evidence);
    return;
  }

  if (operation === 'production-deploy') {
    const releaseRole = roleSetForToken(adapter, adapter.team_policy.authorization.production_deploy_role);
    requireRole(actor, releaseRole, 'actor is not a production release owner');
    requireActiveAssignee(participants, evidence);
    requireRevision(revision);
    const approval = evidence.approval;
    if (!isObject(approval)
        || approval.approved !== true
        || !nonEmptyString(approval.approved_by)
        || approval.approved_revision !== revision) {
      throw rejected('production issue approval does not identify the revision and approver');
    }
    const approver = participants.find((participant) => participant.alias === approval.approved_by);
    if (!approver) throw rejected('production approver is not an active participant');
    requireRole(approver, releaseRole, 'production approver is not a release owner');
    if (approver.alias === evidence.assignee) throw rejected('production approval must be independent of the issue assignee');
    requireProjectBackendCommand(adapter, operation, command, commandArgs, revision);
    return;
  }

  if (operation === 'database-write') {
    requireIssueAssignee(evidence, actor);
    requireRole(actor, new Set([...groups.integrators, ...groups.release_owners]), 'actor has no database role');
    if (evidence.explicit_authority !== true) throw rejected('explicit database authority is required');
    requireRevision(revision);
    requireProjectBackendCommand(adapter, operation, command, commandArgs, revision);
    return;
  }

  if (operation === 'rollback') {
    requireRole(actor, roleSetForToken(adapter, adapter.team_policy.authorization.production_deploy_role), 'actor is not a rollback owner');
    requireActiveAssignee(participants, evidence);
    if (!SHA_PATTERN.test(String(evidence.previous_revision || ''))
        || !nonEmptyString(evidence.rollback_artifact)) {
      throw rejected('rollback requires a full previous revision and materialized artifact');
    }
    requireRevision(revision);
    if (revision !== evidence.previous_revision) {
      throw rejected('rollback revision must match the evidence previous revision');
    }
    requireProjectBackendCommand(adapter, operation, command, commandArgs, revision);
  }
}

function parseArgs(argv) {
  const options = {};
  const valueOptions = new Set([
    '--operation', '--adapter', '--registry', '--actor-alias',
      '--sender-id', '--issue-evidence', '--revision', '--command',
      '--target-workspace', '--output', '--day', '--hour', '--now',
  ]);
  const repeatableOptions = new Set(['--arg']);
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (repeatableOptions.has(key)) {
      if (index + 1 >= argv.length || argv[index + 1] === '--') {
        throw rejected('invalid policy guard arguments');
      }
      options.command_args ??= [];
      options.command_args.push(argv[++index]);
      continue;
    }
    if (!valueOptions.has(key) || index + 1 >= argv.length || argv[index + 1] === '--'
        || argv[index + 1].startsWith('--')) {
      throw rejected('invalid policy guard arguments');
    }
    const optionName = key.slice(2).replaceAll('-', '_');
    if (Object.hasOwn(options, optionName)) throw rejected('invalid policy guard arguments');
    options[optionName] = argv[++index];
  }
  if (!options.operation || !options.adapter) throw rejected('operation and adapter are required');
  return options;
}

export {
  buildProjectBackendArgs,
  evaluatePolicy,
  parseArgs,
  parseIssueEvidence,
  readYaml,
  requireProjectBackendCommand,
};

const entrypoint = path.resolve(process.argv[1] || '');
const modulePath = path.resolve(fileURLToPath(import.meta.url));
if (entrypoint === modulePath) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if ((options.day !== undefined || options.hour !== undefined || options.now !== undefined)
        && process.env.POLICY_GUARD_TEST_CLOCK !== '1') {
      throw rejected('test clock is disabled');
    }
    evaluatePolicy({
      operation: options.operation,
      adapterFile: options.adapter,
      registryFile: options.registry,
      actorAlias: options.actor_alias,
      issueEvidenceFile: options.issue_evidence,
      revision: options.revision,
      command: options.command,
      commandArgs: options.command_args,
      targetWorkspace: options.target_workspace,
      output: options.output,
      day: options.day,
      hour: options.hour,
      senderId: options.sender_id,
      now: options.now === undefined ? undefined : new Date(options.now),
    });
    console.log(`policy guard accepted: ${options.operation}`);
  } catch (error) {
    console.error(`policy guard rejected: ${error?.policyGuard ? error.message : 'policy evaluation failed'}`);
    process.exitCode = 1;
  }
}
