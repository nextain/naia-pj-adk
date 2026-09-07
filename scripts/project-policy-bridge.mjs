#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertAdapterContractShape } from './lib/adapter-contract.mjs';
import { evaluatePolicy, readYaml } from './policy-guard.mjs';

const ROUTE_VERSION = 1;
const PHASES = new Set(['accept', 'enqueue', 'pre_spawn', 'retry', 'recovery']);
const MUTATION_OPERATIONS = new Set(['issue-work', 'production-deploy', 'database-write', 'rollback']);
const ACCESS_LEVELS = new Set(['read-only', 'workspace-write', 'danger-full-access']);
const BACKENDS = new Set(['claude', 'codex', 'grok', 'opencode']);
const PUBLIC_REASONS = new Set([
  'project_policy_route_unavailable',
  'project_policy_window_closed',
  'project_policy_participant_rejected',
  'project_policy_workspace_mismatch',
  'project_policy_authority_changed',
  'project_policy_contract_invalid',
  'project_policy_rejected',
]);

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(reason = 'invalid') {
  const error = new Error(reason);
  error.projectPolicy = true;
  error.projectPolicyReason = reason;
  return error;
}

function boundedString(value, maximum = 256) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && value.trim() === value;
}

function canonicalDirectory(value) {
  if (!boundedString(value, 4_096) || !path.isAbsolute(value)) throw invalid('directory');
  try {
    if (!fs.statSync(value).isDirectory()) throw invalid('directory');
    return fs.realpathSync.native(value);
  } catch (error) {
    if (error?.projectPolicy) throw error;
    throw invalid('directory');
  }
}

function canonicalFile(value) {
  if (!boundedString(value, 4_096) || !path.isAbsolute(value)) throw invalid('file');
  try {
    if (!fs.statSync(value).isFile()) throw invalid('file');
    return fs.realpathSync.native(value);
  } catch (error) {
    if (error?.projectPolicy) throw error;
    throw invalid('file');
  }
}

function safeReason(value) {
  return PUBLIC_REASONS.has(value) ? value : 'project_policy_rejected';
}

function routeErrorReason(error) {
  const message = String(error?.message ?? '').toLowerCase();
  if (/window|work-hour|mutation window/.test(message)) return 'project_policy_window_closed';
  if (/workspace|target workspace/.test(message)) return 'project_policy_workspace_mismatch';
  if (/sender|participant|actor|role|assignee|approval|authority|revision|registry/.test(message)) return 'project_policy_authority_changed';
  if (/adapter|contract|command|capability|registry|evidence|issue-work/.test(message)) return 'project_policy_contract_invalid';
  return 'project_policy_participant_rejected';
}

function validateRoute(route) {
  if (!isObject(route) || route.schemaVersion !== ROUTE_VERSION || route.enabled !== true) throw invalid('route');
  if (!boundedString(route.project, 128)) throw invalid('route');
  if (!MUTATION_OPERATIONS.has(route.operation)) throw invalid('route');
  if (!boundedString(route.actorAlias, 128)) throw invalid('route');
  if (!/^\d{17,20}$/.test(route.participantUserId ?? '')) throw invalid('route');
  if (!boundedString(route.bindingIdentity, 512)) throw invalid('route');
  if (!BACKENDS.has(route.backendId)) throw invalid('route');
  if (!Array.isArray(route.commandArgs) || route.commandArgs.some((item) => typeof item !== 'string' || item.length > 512)) throw invalid('route');
  if (!boundedString(route.command, 128)) throw invalid('route');
  if (!boundedString(route.adapterFile, 4_096) || !path.isAbsolute(route.adapterFile)) throw invalid('route');
  if (!boundedString(route.registryFile, 4_096) || !path.isAbsolute(route.registryFile)) throw invalid('route');
  if (!boundedString(route.issueEvidenceFile, 4_096) || !path.isAbsolute(route.issueEvidenceFile)) throw invalid('route');
  if (!boundedString(route.workspace, 4_096) || !path.isAbsolute(route.workspace)) throw invalid('route');
  const workspace = canonicalDirectory(route.workspace);
  const adapterFile = canonicalFile(route.adapterFile);
  const registryFile = canonicalFile(route.registryFile);
  const issueEvidenceFile = canonicalFile(route.issueEvidenceFile);
  const revision = route.revision === undefined || route.revision === null ? undefined : route.revision;
  if (revision !== undefined && (!boundedString(revision, 128) || !/^[0-9a-f]{40}$/i.test(revision))) throw invalid('route');
  return { ...route, workspace, adapterFile, registryFile, issueEvidenceFile, ...(revision === undefined ? {} : { revision }) };
}

function validateInput(input) {
  if (!isObject(input) || input.schemaVersion !== ROUTE_VERSION) throw invalid('input');
  if (!/^\d{17,20}$/.test(input.participantUserId ?? '')) throw invalid('input');
  if (!boundedString(input.bindingIdentity, 512)) throw invalid('input');
  if (!BACKENDS.has(input.backendId)) throw invalid('input');
  if (!ACCESS_LEVELS.has(input.access)) throw invalid('input');
  if (!PHASES.has(input.phase)) throw invalid('input');
  if (input.jobId !== null && input.jobId !== undefined && !boundedString(input.jobId, 128)) throw invalid('input');
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0) throw invalid('input');
  if (!isObject(input.participantProfile)) throw invalid('input');
  if (input.participantProfile.discordUserId !== input.participantUserId) throw invalid('input');
  if (!boundedString(input.participantProfile.alias, 128) || !boundedString(input.participantProfile.project, 128)) throw invalid('input');
  const cwd = canonicalDirectory(input.cwd);
  if (!Array.isArray(input.allowedPaths) || input.allowedPaths.length === 0 || input.allowedPaths.length > 32) throw invalid('input');
  const allowedPaths = input.allowedPaths.map((value) => canonicalDirectory(value));
  if (!allowedPaths.includes(cwd)) throw invalid('input');
  const requestedAccess = input.access;
  if (requestedAccess === 'read-only') throw invalid('input');
  return { ...input, cwd, allowedPaths: [...new Set(allowedPaths)], access: requestedAccess };
}

function ensureSameIdentity(route, input, adapter) {
  if (route.workspace !== input.cwd) {
    throw invalid('workspace-identity');
  }
  if (route.project !== adapter.project.id
      || route.project !== input.participantProfile.project
      || route.participantUserId !== input.participantUserId
      || route.bindingIdentity !== input.bindingIdentity
      || route.backendId !== input.backendId) {
    throw invalid('identity');
  }
  if (route.actorAlias !== input.participantProfile.alias) throw invalid('identity');
}

function authorizeProjectPolicy({ route, input }) {
  let checkedRoute;
  let checkedInput;
  try {
    checkedRoute = validateRoute(route);
    checkedInput = validateInput(input);
    const adapter = readYaml(checkedRoute.adapterFile);
    try {
      assertAdapterContractShape(adapter, 'adapter');
    } catch {
      throw invalid('adapter-contract');
    }
    ensureSameIdentity(checkedRoute, checkedInput, adapter);
    evaluatePolicy({
      operation: checkedRoute.operation,
      adapterFile: checkedRoute.adapterFile,
      registryFile: checkedRoute.registryFile,
      actorAlias: checkedRoute.actorAlias,
      senderId: checkedInput.participantUserId,
      issueEvidenceFile: checkedRoute.issueEvidenceFile,
      revision: checkedRoute.revision,
      command: checkedRoute.command,
      commandArgs: checkedRoute.commandArgs,
      targetWorkspace: checkedInput.cwd,
      now: new Date(checkedInput.nowMs),
    });
    return {
      allowed: true,
      schemaVersion: ROUTE_VERSION,
      access: checkedInput.access,
      cwd: checkedInput.cwd,
      allowedPaths: checkedInput.allowedPaths,
      participantUserId: checkedInput.participantUserId,
      bindingIdentity: checkedInput.bindingIdentity,
      reasonCode: null,
    };
  } catch (error) {
    let reasonCode;
    if (error?.policyGuard) {
      reasonCode = routeErrorReason(error);
    } else if (error?.projectPolicy) {
      if (error.projectPolicyReason === 'identity') {
        reasonCode = 'project_policy_authority_changed';
      } else if (error.projectPolicyReason === 'workspace-identity') {
        reasonCode = 'project_policy_workspace_mismatch';
      } else if (error.projectPolicyReason === 'adapter-contract') {
        reasonCode = 'project_policy_contract_invalid';
      } else if (error.projectPolicyReason === 'input'
          || error.projectPolicyReason === 'directory'
          || error.projectPolicyReason === 'file') {
        reasonCode = 'project_policy_participant_rejected';
      } else {
        reasonCode = 'project_policy_route_unavailable';
      }
    } else {
      reasonCode = routeErrorReason(error);
    }
    return { allowed: false, schemaVersion: ROUTE_VERSION, reasonCode: safeReason(reasonCode) };
  }
}

function readRoute(routeFile) {
  if (!boundedString(routeFile, 4_096) || !path.isAbsolute(routeFile)) throw invalid('route');
  let value;
  try {
    value = JSON.parse(fs.readFileSync(routeFile, 'utf8'));
  } catch {
    throw invalid('route');
  }
  return validateRoute(value);
}

function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== '--route' || !boundedString(argv[1], 4_096) || !path.isAbsolute(argv[1])) throw invalid('arguments');
  return { routeFile: argv[1] };
}

export {
  ACCESS_LEVELS,
  MUTATION_OPERATIONS,
  PHASES,
  PUBLIC_REASONS,
  ROUTE_VERSION,
  authorizeProjectPolicy,
  canonicalDirectory,
  readRoute,
  routeErrorReason,
  validateInput,
  validateRoute,
};

const entrypoint = path.resolve(process.argv[1] || '');
const modulePath = path.resolve(fileURLToPath(import.meta.url));
if (entrypoint === modulePath) {
  let result;
  try {
    const { routeFile } = parseArgs(process.argv.slice(2));
    const route = readRoute(routeFile);
    let source = '';
    try { source = fs.readFileSync(0, 'utf8'); } catch { throw invalid('input'); }
    let input;
    try { input = JSON.parse(source); } catch { throw invalid('input'); }
    result = authorizeProjectPolicy({ route, input });
  } catch (error) {
    result = { allowed: false, schemaVersion: ROUTE_VERSION, reasonCode: error?.projectPolicy ? 'project_policy_route_unavailable' : 'project_policy_rejected' };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
