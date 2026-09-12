// The project registry is consumed as data by the structure validator. Keep
// the minimum adapter shape in one small, pure function so it can be tested
// with both a real adapter and a deliberately incomplete one.

const REQUIRED_SECTIONS = [
  'project', 'workspace', 'roles', 'discord', 'commands', 'guards',
  'execution', 'tiers', 'ops_profile',
];

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

/**
 * Assert the fields every activated project adapter must expose.
 *
 * Null command values are allowed here: they describe an unimplemented guard
 * and are rejected separately when a tier is declared reachable. Omitting the
 * containing section is always an invalid adapter because it makes the
 * validator silently skip policy checks.
 */
export function assertAdapterContractShape(adapter, label = 'adapter') {
  requireType(adapter, 'object', label);
  requireKeys(adapter, REQUIRED_SECTIONS, label);

  const project = adapter.project;
  requireType(project, 'object', `${label}.project`);
  requireKeys(project, ['id', 'repository', 'issue_tracker', 'default_branch', 'integration_branch'], `${label}.project`);
  for (const key of ['id', 'repository', 'issue_tracker', 'default_branch', 'integration_branch']) {
    requireString(project[key], `${label}.project.${key}`);
  }

  const workspace = adapter.workspace;
  requireType(workspace, 'object', `${label}.workspace`);
  requireKeys(workspace, ['ssh_home_pattern', 'branch_pattern'], `${label}.workspace`);
  for (const key of ['ssh_home_pattern', 'branch_pattern']) {
    requireString(workspace[key], `${label}.workspace.${key}`);
  }

  const roles = adapter.roles;
  requireType(roles, 'object', `${label}.roles`);
  requireKeys(roles, ['contributors', 'integrators', 'release_owners'], `${label}.roles`);
  for (const key of ['contributors', 'integrators', 'release_owners']) {
    requireType(roles[key], 'array', `${label}.roles.${key}`);
  }

  const discord = adapter.discord;
  requireType(discord, 'object', `${label}.discord`);
  requireKeys(discord, ['enabled', 'project_alias', 'bot_token_env', 'runtime_registry'], `${label}.discord`);
  requireType(discord.enabled, 'boolean', `${label}.discord.enabled`);
  for (const key of ['project_alias', 'bot_token_env', 'runtime_registry']) {
    requireString(discord[key], `${label}.discord.${key}`);
  }

  const commands = adapter.commands;
  requireType(commands, 'object', `${label}.commands`);
  requireKeys(commands, ['validate', 'deploy_dev', 'deploy_production'], `${label}.commands`);
  requireString(commands.validate, `${label}.commands.validate`);

  const guards = adapter.guards;
  requireType(guards, 'object', `${label}.guards`);
  requireKeys(guards, ['production_requires_issue_approval', 'database_write_requires_explicit_authority'], `${label}.guards`);
  for (const key of ['production_requires_issue_approval', 'database_write_requires_explicit_authority']) {
    requireType(guards[key], 'boolean', `${label}.guards.${key}`);
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

export { REQUIRED_SECTIONS };
