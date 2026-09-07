import fs from 'node:fs';
import path from 'node:path';
import { parseYaml } from './lib/yaml-lite.mjs';
import {
  assertAdapterContractShape,
  ISSUE_PROJECTION_MARKERS,
  ISSUE_WORK_COMMANDS,
} from './lib/adapter-contract.mjs';

const PROJECT_BACKEND_OPERATIONS = new Map([
  ['production-deploy', 'production_deploy'],
  ['database-write', 'database_write'],
  ['rollback', 'rollback'],
]);

function rejected(reason) {
  const error = new Error(reason);
  error.policyGuard = true;
  return error;
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function readJson(file, reason) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw rejected(reason);
  }
}

function readYaml(file) {
  try {
    return parseYaml(fs.readFileSync(file, 'utf8'));
  } catch {
    throw rejected('adapter could not be read');
  }
}

function parseIssueEvidence(file, adapter) {
  if (!nonEmptyString(file)) throw rejected('an issue evidence projection is required');
  const evidence = readJson(file, 'issue evidence could not be read');
  if (!isObject(evidence)
      || evidence.repository !== adapter.project.repository
      || !Number.isInteger(evidence.number)
      || evidence.number <= 0
      || !['OPEN', 'open'].includes(evidence.state)
      || !nonEmptyString(evidence.assignee)) {
    throw rejected('issue evidence must identify an open assigned issue in this repository');
  }
  return evidence;
}

function issueJobId(commandArgs) {
  let value;
  let count = 0;
  for (let index = 0; index < commandArgs.length; index += 1) {
    if (commandArgs[index] !== '--job') continue;
    count += 1;
    if (index + 1 >= commandArgs.length || !nonEmptyString(commandArgs[index + 1])
        || commandArgs[index + 1].startsWith('--')) {
      throw rejected('restart requires --job <id>');
    }
    value = commandArgs[index + 1];
    index += 1;
  }
  if (count !== 1) throw rejected('restart requires exactly one --job <id>');
  return value;
}

function expandIssueCapability(capability, command, commandArgs, evidence) {
  if (!isObject(capability.commands) || !ISSUE_WORK_COMMANDS.has(command)) {
    throw rejected('issue-work project backend capability is not declared for this command');
  }
  const commandCapability = capability.commands[command];
  if (!isObject(commandCapability) || !Array.isArray(commandCapability.argv)) {
    throw rejected('issue-work project backend capability is not declared for this command');
  }
  const values = {
    issue_repository: evidence.repository,
    issue_number: String(evidence.number),
    issue_assignee: evidence.assignee,
  };
  if (command === 'restart') values.job_id = issueJobId(commandArgs);

  const markerToPlaceholder = new Map(
    [...ISSUE_PROJECTION_MARKERS.entries()].map(([placeholder, marker]) => [marker, placeholder]),
  );
  const inputArgs = [];
  const delegatedArgs = [command];
  for (let index = 1; index < commandCapability.argv.length; index += 1) {
    const argvToken = commandCapability.argv[index];
    if (argvToken === '--job' && commandCapability.argv[index + 1] === '{{job_id}}') {
      delegatedArgs.push(argvToken, values.job_id);
      inputArgs.push(argvToken, values.job_id);
      index += 1;
      continue;
    }
    const markerPlaceholder = markerToPlaceholder.get(argvToken);
    if (markerPlaceholder && commandCapability.argv[index + 1] === `{{${markerPlaceholder}}}`) {
      delegatedArgs.push(argvToken, values[markerPlaceholder]);
      index += 1;
      continue;
    }
    const placeholder = argvToken.match(/^\{\{([a-z_]+)\}\}$/)?.[1];
    if (placeholder) throw rejected('issue-work argv contains an unbound placeholder');
    delegatedArgs.push(argvToken);
    inputArgs.push(argvToken);
  }
  if (inputArgs.length !== commandArgs.length
      || inputArgs.some((token, index) => token !== commandArgs[index])) {
    throw rejected('issue-work argv does not match its project backend capability');
  }
  return delegatedArgs;
}

function requireProjectBackendCommand(
  adapter,
  operation,
  command,
  commandArgs,
  revision,
  evidence,
) {
  const capabilities = adapter.gateway?.project_backend?.capabilities;
  if (!isObject(capabilities)) {
    throw rejected(`project backend capability for ${operation} is not declared`);
  }
  if (!nonEmptyString(command) || !Array.isArray(commandArgs)) {
    throw rejected(`${operation} requires an explicit project backend command binding`);
  }

  if (operation === 'issue-work') {
    const capability = capabilities.issue_work;
    if (!isObject(capability) || !isObject(capability.commands)) {
      throw rejected('project backend capability for issue-work is not declared');
    }
    if (!isObject(evidence)) throw rejected('issue-work requires trusted issue evidence');
    const commandCapability = capability.commands[command];
    if (!isObject(commandCapability) || !Array.isArray(commandCapability.argv)) {
      throw rejected('issue-work project backend capability is not declared for this command');
    }
    return expandIssueCapability(capability, command, commandArgs, evidence);
  }

  const capabilityName = PROJECT_BACKEND_OPERATIONS.get(operation);
  const capability = capabilities[capabilityName];
  if (!isObject(capability) || !Array.isArray(capability.argv)) {
    throw rejected(`project backend capability for ${operation} is not declared`);
  }
  const declared = capability.argv;
  if (declared[0] !== command) {
    throw rejected(`${operation} command does not match its project backend capability`);
  }
  const revisionMarker = capability.revision_arg || '--revision';
  const expectedArgs = [];
  for (const token of declared.slice(1)) {
    if (token === revisionMarker) {
      expectedArgs.push(token, revision);
    } else {
      expectedArgs.push(token);
    }
  }
  if (expectedArgs.length !== commandArgs.length
      || expectedArgs.some((token, index) => token !== commandArgs[index])) {
    throw rejected(`${operation} argv does not match its project backend capability`);
  }
  return [command, ...expectedArgs];
}

function buildProjectBackendArgs({
  adapterFile,
  operation,
  command,
  commandArgs = [],
  revision,
  issueEvidenceFile,
}) {
  if (!nonEmptyString(adapterFile)) throw rejected('an adapter path is required');
  const adapter = readYaml(path.resolve(adapterFile));
  try {
    assertAdapterContractShape(adapter, 'adapter');
  } catch {
    throw rejected('adapter contract is invalid');
  }
  const evidence = operation === 'issue-work'
    ? parseIssueEvidence(issueEvidenceFile, adapter)
    : undefined;
  return requireProjectBackendCommand(adapter, operation, command, commandArgs, revision, evidence);
}

export {
  buildProjectBackendArgs,
  expandIssueCapability,
  issueJobId,
  isObject,
  nonEmptyString,
  parseIssueEvidence,
  readYaml,
  requireProjectBackendCommand,
};
