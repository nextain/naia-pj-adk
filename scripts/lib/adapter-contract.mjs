import { REQUEST_RECIPIENT_POLICIES } from './request-recipient.mjs';

// The project registry is consumed as data by the structure validator. Keep
// the minimum adapter shape in one small, pure function so it can be tested
// with both a real adapter and a deliberately incomplete one.

// Sections every adapter answers, whichever deployment profile it declares.
const CORE_SECTIONS = [
  'project', 'workspace', 'roles', 'discord', 'commands', 'team_policy',
  'ops_profile',
];

// Deployment profile rules. A profile is a directory in profiles/, not a
// branch, and an adapter names exactly one of them.
//
// This table is the machine source: profiles/<name>/profile.yaml is checked
// against it by scripts/validate.mjs, so the document a person reads and the
// rule a machine applies cannot drift apart.
//
// `required` is a dotted path that must be present. `forbidden` is a dotted
// path whose presence is an error, because carrying it means the adapter was
// copied from the other profile and still points at something that does not
// exist here. `optional` is neither: it is the list a reviewer may expect to
// see and the validator will not demand.
const PROFILE_RULES = {
  server: {
    sections: [...CORE_SECTIONS, 'guards', 'execution', 'tiers'],
    required: [
      'workspace.ssh_home_pattern', 'workspace.branch_pattern',
      'commands.validate', 'commands.deploy_dev', 'commands.deploy_production',
      'guards', 'execution', 'tiers',
    ],
    optional: ['gateway'],
    forbidden: ['local_workspace'],
  },
  local: {
    sections: [...CORE_SECTIONS, 'local_workspace'],
    required: [
      'workspace.branch_pattern', 'commands.validate', 'local_workspace.devices_dir',
    ],
    optional: [
      'gateway', 'guards',
      'local_workspace.qa_rounds_dir', 'local_workspace.handoffs_dir',
      'local_workspace.workspace_catalog',
    ],
    forbidden: [
      'workspace.ssh_home_pattern', 'tiers', 'execution',
      'commands.deploy_dev', 'commands.deploy_production',
    ],
  },
};
const PROFILE_NAMES = Object.keys(PROFILE_RULES);
const POLICY_CONTRACT_VERSION = 1;

/** Is a dotted path present in the adapter? Presence, not truth. */
function hasPath(value, dotted) {
  let current = value;
  for (const key of dotted.split('.')) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, key)) return false;
    current = current[key];
  }
  return true;
}

function actualType(value) {
  return Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
}

function requireKeys(value, keys, label) {
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) throw new Error(`${label} is missing the required field: ${key}`);
  }
}

function requireType(value, type, label) {
  const actual = actualType(value);
  if (actual !== type) throw new Error(`${label} must be ${type}, found ${actual}`);
}

function requireString(value, label) {
  requireType(value, 'string', label);
  if (value.trim() === '') throw new Error(`${label} must not be empty`);
}

function requireNumber(value, label) {
  requireType(value, 'number', label);
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
}

const ROLE_GROUP_ALIASES = new Map([
  ['contributors', 'contributors'],
  ['contributor', 'contributors'],
  ['integrators', 'integrators'],
  ['integrator', 'integrators'],
  ['release_owners', 'release_owners'],
  ['release_owner', 'release_owners'],
]);

function roleTokenResolves(token, roles) {
  if (typeof token !== 'string') return [];
  const group = ROLE_GROUP_ALIASES.get(token);
  if (group) return roles[group] ?? [];
  return Object.values(roles).some((members) => members.includes(token)) ? [token] : [];
}

const DAY_NAMES = new Map([
  ['mon', 1], ['tue', 2], ['wed', 3], ['thu', 4],
  ['fri', 5], ['sat', 6], ['sun', 7],
]);

function normalizeDay(value, label) {
  if (typeof value === 'number') {
    if (Number.isInteger(value) && value >= 1 && value <= 7) return value;
    throw new Error(`${label} must be an integer day from 1 to 7 or a three-letter day name`);
  }
  requireString(value, label);
  const lower = value.toLowerCase();
  if (DAY_NAMES.has(lower)) return DAY_NAMES.get(lower);
  if (/^[1-7]$/.test(lower)) return Number(lower);
  throw new Error(`${label} must be an integer day from 1 to 7 or a three-letter day name`);
}

function requireTimezone(value, label) {
  requireString(value, label);
  // UTC is the sole non-region spelling allowed in an adapter. Other values
  // must be IANA region names so a host's local timezone cannot silently
  // replace the project's schedule.
  if (value !== 'UTC' && !/^[A-Za-z]+\/[A-Za-z0-9_+\-]+(?:\/[A-Za-z0-9_+\-]+)*$/.test(value)) {
    throw new Error(`${label} must be UTC or an IANA region timezone`);
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
  } catch {
    throw new Error(`${label} is not a supported timezone`);
  }
}

function requireSchedule(schedule, label) {
  requireType(schedule, 'object', label);
  requireKeys(schedule, ['timezone', 'days', 'start_hour', 'end_hour'], label);
  requireTimezone(schedule.timezone, `${label}.timezone`);
  requireType(schedule.days, 'array', `${label}.days`);
  if (schedule.days.length === 0) throw new Error(`${label}.days must not be empty`);
  const days = schedule.days.map((day, index) => normalizeDay(day, `${label}.days[${index}]`));
  if (new Set(days).size !== days.length) throw new Error(`${label}.days must not repeat a day`);
  for (const key of ['start_hour', 'end_hour']) {
    requireNumber(schedule[key], `${label}.${key}`);
    if (!Number.isInteger(schedule[key]) || schedule[key] < 0 || schedule[key] > 24) {
      throw new Error(`${label}.${key} must be an integer between 0 and 24`);
    }
  }
  if (schedule.end_hour <= schedule.start_hour) {
    throw new Error(`${label}.end_hour must be after start_hour`);
  }
  return { timezone: schedule.timezone, days, start_hour: schedule.start_hour, end_hour: schedule.end_hour };
}

// High-impact commands are project-owned integrations.  Keeping their argv
// contract in the adapter lets the common gateway bind the approved revision
// to the exact command that receives it, while leaving the native naia-adk
// runtime commands on their own contract.
const REVISION_BOUND_CAPABILITIES = new Set([
  'production_deploy', 'database_write', 'rollback',
]);

const ISSUE_WORK_COMMANDS = new Set(['submit', 'restart', 'amend']);
const ISSUE_PROJECTION_MARKERS = new Map([
  ['issue_repository', '--issue-repository'],
  ['issue_number', '--issue-number'],
  ['issue_assignee', '--issue-assignee'],
]);
const ISSUE_ALLOWED_PLACEHOLDERS = new Set([
  ...ISSUE_PROJECTION_MARKERS.keys(),
  'job_id',
]);

function requireIssueWorkCapability(capability, label) {
  requireType(capability, 'object', label);
  requireKeys(capability, ['commands'], label);
  requireType(capability.commands, 'object', `${label}.commands`);
  const names = Object.keys(capability.commands);
  if (names.length === 0) throw new Error(`${label}.commands must not be empty`);
  for (const name of names) {
    if (!ISSUE_WORK_COMMANDS.has(name)) {
      throw new Error(`${label}.commands.${name} is not a supported issue-work command`);
    }
    const command = capability.commands[name];
    const commandLabel = `${label}.commands.${name}`;
    requireType(command, 'object', commandLabel);
    requireKeys(command, ['argv'], commandLabel);
    requireType(command.argv, 'array', `${commandLabel}.argv`);
    if (command.argv.length === 0) throw new Error(`${commandLabel}.argv must not be empty`);
    for (const [index, token] of command.argv.entries()) {
      requireString(token, `${commandLabel}.argv[${index}]`);
      const match = token.match(/^\{\{([a-z_]+)\}\}$/);
      if (match && !ISSUE_ALLOWED_PLACEHOLDERS.has(match[1])) {
        throw new Error(`${commandLabel}.argv[${index}] uses an unknown issue placeholder`);
      }
    }
    if (command.argv[0] !== name) {
      throw new Error(`${commandLabel}.argv must begin with the command name`);
    }
    for (const [placeholder, marker] of ISSUE_PROJECTION_MARKERS) {
      const index = command.argv.indexOf(marker);
      if (index < 0 || command.argv[index + 1] !== `{{${placeholder}}}`) {
        throw new Error(`${commandLabel}.argv must bind ${marker} to the ${placeholder} evidence placeholder`);
      }
    }
    if (name === 'restart') {
      const jobIndex = command.argv.indexOf('--job');
      if (jobIndex < 0 || command.argv[jobIndex + 1] !== '{{job_id}}') {
        throw new Error(`${commandLabel}.argv must bind --job to the job_id placeholder`);
      }
    } else if (command.argv.includes('{{job_id}}')) {
      throw new Error(`${commandLabel}.argv may use job_id only for restart`);
    }
  }
}

function requireGatewayContract(gateway, label) {
  if (gateway === undefined) return;
  if (gateway === null) return;
  requireType(gateway, 'object', `${label}.gateway`);
  if (!Object.hasOwn(gateway, 'project_backend')) {
    throw new Error(`${label}.gateway is missing the required field: project_backend`);
  }
  const projectBackend = gateway.project_backend;
  if (projectBackend === null) return;
  requireType(projectBackend, 'object', `${label}.gateway.project_backend`);
  requireKeys(projectBackend, ['capabilities'], `${label}.gateway.project_backend`);
  requireType(projectBackend.capabilities, 'object', `${label}.gateway.project_backend.capabilities`);
  for (const [name, capability] of Object.entries(projectBackend.capabilities)) {
    const capabilityLabel = `${label}.gateway.project_backend.capabilities.${name}`;
    if (name === 'issue_work') {
      requireIssueWorkCapability(capability, capabilityLabel);
      continue;
    }
    requireType(capability, 'object', capabilityLabel);
    requireKeys(capability, ['argv'], capabilityLabel);
    requireType(capability.argv, 'array', `${capabilityLabel}.argv`);
    if (capability.argv.length === 0) {
      throw new Error(`${capabilityLabel}.argv must not be empty`);
    }
    for (const [index, token] of capability.argv.entries()) {
      requireString(token, `${capabilityLabel}.argv[${index}]`);
    }
    for (const key of ['revision_arg']) {
      if (Object.hasOwn(capability, key)) requireString(capability[key], `${capabilityLabel}.${key}`);
    }
    if (REVISION_BOUND_CAPABILITIES.has(name)) {
      const revisionMarkers = capability.argv.filter((token) => token === '--revision');
      if (revisionMarkers.length !== 1 || capability.revision_arg !== '--revision') {
        throw new Error(`${capabilityLabel} must declare exactly one --revision argv marker and revision_arg: --revision`);
      }
    }
  }
}

/**
 * Assert the fields every activated project adapter must expose.
 *
 * Null command values are allowed here: they describe an unimplemented guard
 * and are rejected separately when a tier is declared reachable. Omitting the
 * containing section is always an invalid adapter because it makes the
 * validator silently skip policy checks.
 */
export function assertAdapterContractShape(adapter, label = 'adapter') {
  return assertContract(adapter, label, false);
}

/** Validate reusable host policy without claiming deployment readiness. */
export function assertAdapterPolicyContract(adapter, label = 'policy adapter') {
  return assertContract(adapter, label, true);
}

function assertContract(adapter, label, policyOnly) {
  requireType(adapter, 'object', label);
  requireKeys(adapter, ['profile'], label);
  requireString(adapter.profile, `${label}.profile`);
  if (!Object.hasOwn(PROFILE_RULES, adapter.profile)) {
    throw new Error(`${label}.profile must be one of ${PROFILE_NAMES.join(', ')}, found ${adapter.profile}`);
  }
  const rules = PROFILE_RULES[adapter.profile];
  requireKeys(adapter, policyOnly ? CORE_SECTIONS : rules.sections, label);
  requireKeys(adapter, ['policy_contract_version'], label);
  requireNumber(adapter.policy_contract_version, `${label}.policy_contract_version`);
  if (adapter.policy_contract_version !== POLICY_CONTRACT_VERSION) {
    throw new Error(`${label}.policy_contract_version must be ${POLICY_CONTRACT_VERSION}`);
  }
  for (const dotted of rules.required) {
    if (policyOnly && !['workspace.ssh_home_pattern', 'workspace.branch_pattern', 'commands.validate'].includes(dotted)) continue;
    if (!hasPath(adapter, dotted)) {
      throw new Error(`${label}.${dotted} is required by the ${adapter.profile} profile`);
    }
  }
  for (const dotted of rules.forbidden) {
    if (hasPath(adapter, dotted)) {
      throw new Error(`${label}.${dotted} is not part of the ${adapter.profile} profile; remove it or declare the other profile`);
    }
  }

  const project = adapter.project;
  requireType(project, 'object', `${label}.project`);
  requireKeys(project, ['id', 'repository', 'issue_tracker', 'default_branch', 'integration_branch'], `${label}.project`);
  for (const key of ['id', 'repository', 'issue_tracker', 'default_branch', 'integration_branch']) {
    requireString(project[key], `${label}.project.${key}`);
  }

  // A server-profile team shares one host, so every participant has a home on
  // it and the adapter has to say how those homes are named. A local-profile
  // team has no such home: the same field there would name a path nobody has.
  const workspace = adapter.workspace;
  requireType(workspace, 'object', `${label}.workspace`);
  const workspaceKeys = adapter.profile === 'server'
    ? ['ssh_home_pattern', 'branch_pattern']
    : ['branch_pattern'];
  requireKeys(workspace, workspaceKeys, `${label}.workspace`);
  for (const key of workspaceKeys) {
    requireString(workspace[key], `${label}.workspace.${key}`);
  }

  const roles = adapter.roles;
  requireType(roles, 'object', `${label}.roles`);
  requireKeys(roles, ['contributors', 'integrators', 'release_owners'], `${label}.roles`);
  for (const key of ['contributors', 'integrators', 'release_owners']) {
    requireType(roles[key], 'array', `${label}.roles.${key}`);
    for (const [index, role] of roles[key].entries()) {
      requireString(role, `${label}.roles.${key}[${index}]`);
    }
  }

  const discord = adapter.discord;
  requireType(discord, 'object', `${label}.discord`);
  requireKeys(discord, [
    'enabled', 'project_alias', 'bot_token_env', 'runtime_registry',
    'contact_window', 'default_responder_alias',
  ], `${label}.discord`);
  requireType(discord.enabled, 'boolean', `${label}.discord.enabled`);
  for (const key of ['project_alias', 'bot_token_env', 'runtime_registry']) {
    requireString(discord[key], `${label}.discord.${key}`);
  }
  requireSchedule(discord.contact_window, `${label}.discord.contact_window`);
  if (discord.default_responder_alias !== null) {
    requireString(discord.default_responder_alias, `${label}.discord.default_responder_alias`);
  }

  requireGatewayContract(adapter.gateway, label);

  const teamPolicy = adapter.team_policy;
  requireType(teamPolicy, 'object', `${label}.team_policy`);
  requireKeys(teamPolicy, ['authorization', 'work_hours', 'approval', 'assignment'], `${label}.team_policy`);

  const authorization = teamPolicy.authorization;
  requireType(authorization, 'object', `${label}.team_policy.authorization`);
  requireKeys(authorization, [
    'issue_required', 'chat_grants_authority', 'production_deploy_role',
    'database_write_requires_explicit_authority', 'issue_work_roles',
  ], `${label}.team_policy.authorization`);
  requireType(authorization.issue_required, 'boolean', `${label}.team_policy.authorization.issue_required`);
  requireType(authorization.chat_grants_authority, 'boolean', `${label}.team_policy.authorization.chat_grants_authority`);
  requireString(authorization.production_deploy_role, `${label}.team_policy.authorization.production_deploy_role`);
  requireType(
    authorization.database_write_requires_explicit_authority,
    'boolean',
    `${label}.team_policy.authorization.database_write_requires_explicit_authority`,
  );
  requireType(authorization.issue_work_roles, 'array', `${label}.team_policy.authorization.issue_work_roles`);
  for (const [index, role] of authorization.issue_work_roles.entries()) {
    requireString(role, `${label}.team_policy.authorization.issue_work_roles[${index}]`);
  }
  if (authorization.issue_required !== true) {
    throw new Error(`${label}.team_policy.authorization.issue_required must be true`);
  }
  if (authorization.chat_grants_authority !== false) {
    throw new Error(`${label}.team_policy.authorization.chat_grants_authority must be false`);
  }
  const productionDeployRoles = roleTokenResolves(authorization.production_deploy_role, roles);
  if (productionDeployRoles.length === 0
      || productionDeployRoles.some((role) => !roles.release_owners.includes(role))) {
    throw new Error(`${label}.team_policy.authorization.production_deploy_role must resolve only to release owner roles`);
  }
  for (const [index, role] of authorization.issue_work_roles.entries()) {
    if (roleTokenResolves(role, roles).length === 0) {
      throw new Error(`${label}.team_policy.authorization.issue_work_roles[${index}] must name a declared role or role group`);
    }
  }
  if (authorization.database_write_requires_explicit_authority !== true) {
    throw new Error(`${label}.team_policy.authorization.database_write_requires_explicit_authority must be true`);
  }

  requireSchedule(teamPolicy.work_hours, `${label}.team_policy.work_hours`);

  const approval = teamPolicy.approval;
  requireType(approval, 'object', `${label}.team_policy.approval`);
  requireKeys(approval, ['production_deploy', 'high_system_risk', 'incident_rollback'], `${label}.team_policy.approval`);
  for (const key of ['production_deploy', 'high_system_risk', 'incident_rollback']) {
    requireString(approval[key], `${label}.team_policy.approval.${key}`);
  }
  if (!['required', 'high_risk_only'].includes(approval.production_deploy)) {
    throw new Error(`${label}.team_policy.approval.production_deploy must be required or high_risk_only`);
  }
  if (approval.high_system_risk !== 'required') {
    throw new Error(`${label}.team_policy.approval.high_system_risk must be required`);
  }
  if (approval.incident_rollback !== 'without_approval') {
    throw new Error(`${label}.team_policy.approval.incident_rollback must be without_approval`);
  }

  const assignment = teamPolicy.assignment;
  requireType(assignment, 'object', `${label}.team_policy.assignment`);
  requireKeys(assignment, [
    'issue_assignee_required', 'unanswered_thread_recipient', 'default_responder_alias',
  ], `${label}.team_policy.assignment`);
  requireType(assignment.issue_assignee_required, 'boolean', `${label}.team_policy.assignment.issue_assignee_required`);
  requireString(assignment.unanswered_thread_recipient, `${label}.team_policy.assignment.unanswered_thread_recipient`);
  if (assignment.issue_assignee_required !== true) {
    throw new Error(`${label}.team_policy.assignment.issue_assignee_required must be true`);
  }
  if (!REQUEST_RECIPIENT_POLICIES.includes(assignment.unanswered_thread_recipient)) {
    throw new Error(`${label}.team_policy.assignment.unanswered_thread_recipient must be one of ${REQUEST_RECIPIENT_POLICIES.join(', ')}`);
  }
  if (assignment.default_responder_alias !== null) {
    requireString(assignment.default_responder_alias, `${label}.team_policy.assignment.default_responder_alias`);
  }
  if (assignment.default_responder_alias !== discord.default_responder_alias) {
    throw new Error(`${label}.discord.default_responder_alias must match team_policy.assignment.default_responder_alias`);
  }

  const commands = adapter.commands;
  requireType(commands, 'object', `${label}.commands`);
  requireKeys(commands, !policyOnly && adapter.profile === 'server'
    ? ['validate', 'deploy_dev', 'deploy_production']
    : ['validate'], `${label}.commands`);
  requireString(commands.validate, `${label}.commands.validate`);

  if (policyOnly) {
    assertOpsProfile(adapter, label);
    return;
  }

  // A local-profile team registers the devices that run its work, because a
  // round is claimed by a device and a claim by an unregistered device names
  // an executor nobody can find.
  if (adapter.profile === 'local') {
    const layout = adapter.local_workspace;
    requireType(layout, 'object', `${label}.local_workspace`);
    requireString(layout.devices_dir, `${label}.local_workspace.devices_dir`);
    for (const key of ['qa_rounds_dir', 'handoffs_dir', 'workspace_catalog']) {
      if (Object.hasOwn(layout, key) && layout[key] !== null) {
        requireString(layout[key], `${label}.local_workspace.${key}`);
      }
    }
    assertOpsProfile(adapter, label);
    return;
  }

  const guards = adapter.guards;
  requireType(guards, 'object', `${label}.guards`);
  requireKeys(guards, ['production_requires_issue_approval', 'database_write_requires_explicit_authority'], `${label}.guards`);
  for (const key of ['production_requires_issue_approval', 'database_write_requires_explicit_authority']) {
    requireType(guards[key], 'boolean', `${label}.guards.${key}`);
  }
  if (guards.production_requires_issue_approval !== (approval.production_deploy === 'required')) {
    throw new Error(`${label}.guards.production_requires_issue_approval must match team_policy.approval.production_deploy`);
  }
  if (guards.database_write_requires_explicit_authority !== authorization.database_write_requires_explicit_authority) {
    throw new Error(`${label}.guards.database_write_requires_explicit_authority must match team_policy.authorization`);
  }

  const execution = adapter.execution;
  requireType(execution, 'object', `${label}.execution`);
  requireKeys(execution, [
    'deploy_gate_command', 'artifact', 'propagation', 'verification',
    'rollback', 'concurrency', 'drift_check_command',
  ], `${label}.execution`);
  requireType(execution.artifact, 'object', `${label}.execution.artifact`);
  requireKeys(execution.artifact, ['build_from', 'intake_scan_command'], `${label}.execution.artifact`);
  requireType(execution.propagation, 'object', `${label}.execution.propagation`);
  for (const tier of ['development', 'production']) {
    requireType(execution.propagation[tier], 'object', `${label}.execution.propagation.${tier}`);
    requireKeys(execution.propagation[tier], [
      'reload_command', 'cache_invalidation_command', 'serving_revision_proof_command',
    ], `${label}.execution.propagation.${tier}`);
  }
  requireType(execution.verification, 'object', `${label}.execution.verification`);
  requireKeys(execution.verification, ['command', 'required_strings', 'consecutive_passes'], `${label}.execution.verification`);
  requireType(execution.verification.required_strings, 'array', `${label}.execution.verification.required_strings`);
  requireType(execution.verification.consecutive_passes, 'number', `${label}.execution.verification.consecutive_passes`);
  requireType(execution.rollback, 'object', `${label}.execution.rollback`);
  requireKeys(execution.rollback, ['development', 'production'], `${label}.execution.rollback`);
  requireType(execution.concurrency, 'object', `${label}.execution.concurrency`);
  requireKeys(execution.concurrency, ['lease_file', 'shared_targets'], `${label}.execution.concurrency`);
  requireString(execution.concurrency.lease_file, `${label}.execution.concurrency.lease_file`);
  requireType(execution.concurrency.shared_targets, 'array', `${label}.execution.concurrency.shared_targets`);

  const tiers = adapter.tiers;
  requireType(tiers, 'object', `${label}.tiers`);
  for (const tier of ['development', 'production']) {
    requireType(tiers[tier], 'object', `${label}.tiers.${tier}`);
    requireKeys(tiers[tier], [
      'url', 'source_revision_origin', 'database', 'deployable_by', 'reachable',
    ], `${label}.tiers.${tier}`);
    for (const key of ['url', 'source_revision_origin', 'database']) {
      requireString(tiers[tier][key], `${label}.tiers.${tier}.${key}`);
    }
    requireType(tiers[tier].deployable_by, 'array', `${label}.tiers.${tier}.deployable_by`);
    requireType(tiers[tier].reachable, 'boolean', `${label}.tiers.${tier}.reachable`);
    if (
      tiers[tier].reachable === true
      && (
        tiers[tier].deployable_by.length === 0
        || tiers[tier].deployable_by.some((deployer) => typeof deployer !== 'string' || deployer.trim() === '')
      )
    ) {
      throw new Error(`${label}.tiers.${tier}.deployable_by must contain a non-empty deployer when reachable`);
    }
  }

  assertOpsProfile(adapter, label);
}

/**
 * The attention-routing half of the ops profile. Both profiles answer it:
 * a team with no deployment target still owes replies to people.
 */
function assertOpsProfile(adapter, label) {
  const opsProfile = adapter.ops_profile;
  requireType(opsProfile, 'object', `${label}.ops_profile`);
  requireKeys(opsProfile, ['stall_forbidden', 'inherit', 'attention_routing'], `${label}.ops_profile`);
  requireType(opsProfile.stall_forbidden, 'boolean', `${label}.ops_profile.stall_forbidden`);
  requireString(opsProfile.inherit, `${label}.ops_profile.inherit`);
  requireType(opsProfile.attention_routing, 'object', `${label}.ops_profile.attention_routing`);
  requireKeys(opsProfile.attention_routing, [
    'bot_work_must_not_land_on_owner', 'our_turn', 're_ask_fallback_to_owner',
  ], `${label}.ops_profile.attention_routing`);
  requireType(
    opsProfile.attention_routing.bot_work_must_not_land_on_owner,
    'boolean',
    `${label}.ops_profile.attention_routing.bot_work_must_not_land_on_owner`,
  );
  requireType(opsProfile.attention_routing.our_turn, 'string', `${label}.ops_profile.attention_routing.our_turn`);
  requireType(opsProfile.attention_routing.re_ask_fallback_to_owner, 'boolean', `${label}.ops_profile.attention_routing.re_ask_fallback_to_owner`);
}

export {
  CORE_SECTIONS,
  PROFILE_NAMES,
  PROFILE_RULES,
  DAY_NAMES,
  ISSUE_ALLOWED_PLACEHOLDERS,
  ISSUE_PROJECTION_MARKERS,
  ISSUE_WORK_COMMANDS,
  roleTokenResolves,
  normalizeDay,
  requireSchedule,
  requireTimezone,
};
