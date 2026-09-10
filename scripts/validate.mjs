import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseYaml, at } from './lib/yaml-lite.mjs';
import { assertAdapterContractShape, PROFILE_NAMES, PROFILE_RULES } from './lib/adapter-contract.mjs';
import { assertMessagingOwnership } from './lib/messaging-contract.mjs';
import { validateNativeCommandContract } from './native-command-validator.mjs';

// Structure validation reads the contracts as data.
//
// It used to grep the file text for `section:`. A contract could then be the
// wrong type, nested under the wrong parent, duplicated, or not valid YAML at
// all and still pass, because the marker was present. Renaming a section to
// `x_concurrency` also passed, since the substring survived. Parsing removes
// that whole family of false passes.

const root = path.resolve(import.meta.dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

// A gitlink is an opaque commit pointer: this repository cannot inspect the
// child tree or its reachable history in CI. Until a signed, pinned child-scan
// receipt is part of the contract, fail closed instead of silently exempting a
// submodule from adapter and public-release validation.
const gitlinks = execFileSync('git', ['ls-files', '--stage'], { cwd: root, encoding: 'utf8' })
  .trim().split('\n').filter((line) => line.startsWith('160000 '));
if (gitlinks.length || fs.existsSync(path.join(root, '.gitmodules'))) {
  throw new Error('git submodules are unsupported until a pinned child validation and public-safety receipt is implemented');
}

function contract(relative) {
  try {
    return parseYaml(read(relative));
  } catch (error) {
    throw new Error(`${relative} is not readable as a contract: ${error.message}`);
  }
}

function requireKeys(value, keys, label) {
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) throw new Error(`${label} is missing the top-level section: ${key}`);
  }
}

function requireType(value, type, label) {
  const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  if (actual !== type) throw new Error(`${label} must be ${type}, found ${actual}`);
}

const required = [
  'AGENTS.md', 'CLAUDE.md', 'GEMINI.md', 'CODEX.md', 'README.md', 'LICENSE',
  'NOTICE',
  '.agents/context/project-policy.yaml',
  '.agents/context/workflow.yaml',
  '.agents/context/execution.yaml',
  '.agents/context/messaging.yaml',
  '.agents/context/development-method.yaml',
  '.agents/context/discord.yaml',
  'profiles/README.ko.md',
  'profiles/server/profile.yaml',
  'profiles/server/README.ko.md',
  'profiles/server/context/execution.yaml',
  'profiles/local/profile.yaml',
  'profiles/local/README.ko.md',
  'profiles/local/context/qa-rounds.yaml',
  'profiles/local/scripts/qa-round.mjs',
  'profiles/local/scripts/qa-round.test.mjs',
  'profiles/local/scripts/workspace.mjs',
  'profiles/local/workspace/repos.json',
  'profiles/local/devices/README.ko.md',
  'profiles/local/handoffs/README.ko.md',
  'projects/_template/project.yaml',
  'projects/_template-local/project.yaml',
  'docs/WORKSPACE.ko.md',
  'data-branch/README.md',
  'data-branch/_template/AGENTS.md',
  'data-branch/_template/CLAUDE.md',
  'ops/gateway/dcg.sh',
  'ops/gateway/contact-window.sh',
  'scripts/lib/yaml-lite.mjs',
  'scripts/lib/participant-registry.mjs',
  'scripts/policy-guard.mjs',
  'scripts/native-command-validator.mjs',
  'ops/gateway/native-command-contract.json',
  'schemas/participants.schema.json',
  '.github/workflows/production-deploy.yml',
];
for (const file of required) {
  if (!fs.existsSync(path.join(root, file))) throw new Error(`missing required file: ${file}`);
}

try {
  validateNativeCommandContract(JSON.parse(read('ops/gateway/native-command-contract.json')));
} catch (error) {
  throw new Error(`native command contract is invalid: ${error.message}`);
}

// --- entrypoint mirrors -----------------------------------------------------

const canonical = read('AGENTS.md');
for (const mirror of ['CLAUDE.md', 'GEMINI.md']) {
  if (canonical !== read(mirror)) throw new Error(`AGENTS.md and ${mirror} must be byte-identical`);
}
const branchTemplate = read('data-branch/_template/AGENTS.md');
if (branchTemplate !== read('data-branch/_template/CLAUDE.md')) {
  throw new Error('data-branch/_template/AGENTS.md and CLAUDE.md must be byte-identical');
}

// CODEX.md is a pointer, not a byte mirror, so the check above cannot cover it.
// Without this it could quietly say something AGENTS.md does not.
const codex = read('CODEX.md');
if (!codex.includes('AGENTS.md')) throw new Error('CODEX.md must point at AGENTS.md as the canonical entrypoint');
if (codex.split('\n').filter((line) => line.trim()).length > 6) {
  throw new Error('CODEX.md must stay a pointer; put rules in AGENTS.md so all tools read one text');
}

// --- policy, workflow, execution, method ------------------------------------

const policy = contract('.agents/context/project-policy.yaml');
requireKeys(policy, ['identity', 'source_of_truth', 'roles', 'authority', 'data', 'public_release'], 'project policy');
requireType(at(policy, 'roles'), 'object', 'policy roles');

const workflow = contract('.agents/context/workflow.yaml');
requireKeys(workflow, ['states', 'transitions', 'rules'], 'workflow');
requireType(workflow.states, 'array', 'workflow states');
requireType(workflow.transitions, 'array', 'workflow transitions');

const declaredStates = new Set(workflow.states);
for (const [index, transition] of workflow.transitions.entries()) {
  requireType(transition, 'object', `workflow transition ${index}`);
  for (const end of ['from', 'to']) {
    if (!declaredStates.has(transition[end])) {
      throw new Error(`workflow transition ${index} references the undeclared state: ${transition[end]}`);
    }
  }
  if (transition.actor !== undefined && !Object.hasOwn(policy.roles, transition.actor)) {
    throw new Error(`workflow transition ${index} names a role the policy does not define: ${transition.actor}`);
  }
}

// The neutral core. Nothing here may assume a shared deployment target: a
// local-profile team answers this file and nothing else in execution.
const execution = contract('.agents/context/execution.yaml');
requireKeys(execution, [
  'ops_profile', 'confirmation_request', 'acknowledgement', 'watchdog',
  'completion',
], 'execution contract');
if (at(execution, 'ops_profile', 'stall_forbidden') !== true) {
  throw new Error('execution contract must forbid stalling a thread to wait for a safe read or a non-critical user-visible deploy');
}
if (at(execution, 'ops_profile', 'attention_routing', 'bot_work_must_not_land_on_owner') !== true) {
  throw new Error('execution contract must keep bot work off the owner inbox');
}
if (at(execution, 'ops_profile', 'attention_routing', 're_ask_fallback_to_owner') !== false) {
  throw new Error('execution contract must not default unanswered asks to the owner');
}
if (at(execution, 'ops_profile', 'attention_routing', 'collaborator_ok_on_non_owner_gated') !== true) {
  throw new Error('execution contract must not void a collaborator ok on work that does not need the owner');
}
// A request that names nobody notifies nobody, and one with no return address
// produces an answer the asker never reads.
for (const field of ['who', 'what', 'where_exactly', 'where_to_report_back']) {
  if (!(at(execution, 'confirmation_request', 'required_fields') ?? []).includes(field)) {
    throw new Error(`execution contract must make a confirmation request name ${field}`);
  }
}
if (at(execution, 'confirmation_request', 'quoted_text_mentions') !== 'neutralized') {
  throw new Error('execution contract must neutralize calls inside quoted text');
}
// Posting, receiving and starting are three events.
if (!Array.isArray(at(execution, 'acknowledgement', 'not_acknowledgement'))
    || at(execution, 'acknowledgement', 'not_acknowledgement').length === 0) {
  throw new Error('execution contract must name what does not count as an acknowledgement');
}
if (at(execution, 'watchdog', 'pending_human_response', 're_ask_fallback') !== 'none') {
  throw new Error('execution contract must not fall back a re-ask to a default owner');
}
if (at(execution, 'watchdog', 'pending_human_response', 'our_turn') !== 'dispatch_not_escalate_to_owner') {
  throw new Error('execution contract must dispatch owed bot work instead of paging the owner');
}
if (at(execution, 'completion', 'ai_may_not_declare_completion') !== true) {
  throw new Error('execution contract must keep completion a human decision');
}
if (at(execution, 'watchdog', 'one_item_may_not_stop_the_sweep') !== true) {
  throw new Error('execution contract must keep a single item from stopping a watchdog sweep');
}
if (at(execution, 'watchdog', 'own_failure_must_alarm') !== true) {
  throw new Error("execution contract must keep a watchdog's own failure alarming");
}
const reAsk = at(execution, 'watchdog', 'pending_human_response');
if (typeof at(reAsk, 're_ask_after_minutes') !== 'number') {
  throw new Error('execution contract must set how long a pending human response waits before it is asked again');
}
if (typeof at(reAsk, 'max_re_asks') !== 'number') {
  throw new Error('execution contract must bound how often a person is asked again');
}
// Asking a person at night is not the same event as reporting breakage. The
// contract has to say that only the ask is gated, or a project will gate both.
const contactWindow = at(reAsk, 'contact_window');
if (at(contactWindow, 'outside_window') !== 'defer_without_counting') {
  throw new Error('execution contract must defer an out-of-hours ask without spending a re-ask');
}
if (!Array.isArray(at(contactWindow, 'never_gated')) || at(contactWindow, 'never_gated').length === 0) {
  throw new Error('execution contract must name what a contact window never delays');
}
// A deployment rule in the neutral core is a rule a local team is asked to
// answer with a null, which reads as answered. Keep the halves apart.
for (const section of ['deploy_gate', 'artifact', 'propagation', 'rollback', 'concurrency', 'drift', 'environment_tiers']) {
  if (Object.hasOwn(execution, section)) {
    throw new Error(`execution contract must leave ${section} to profiles/server/context/execution.yaml`);
  }
}

// --- messaging ownership ----------------------------------------------------

// One gateway implementation, or the same defect is fixed once per instance and
// left in place everywhere else.
const messaging = contract('.agents/context/messaging.yaml');
requireKeys(messaging, ['provider', 'transports', 'instance_holds', 'instance_must_not_hold'], 'messaging contract');
assertMessagingOwnership(messaging);

// --- deployment profiles ----------------------------------------------------

// A profile is a directory here, never a branch: a branch would take a common
// contract improvement into one side and leave the other behind.
//
// profile.yaml is what a person reads and PROFILE_RULES is what the validator
// applies. Comparing them is the only thing that keeps the document from
// quietly describing a rule that is no longer enforced.
for (const name of PROFILE_NAMES) {
  const manifest = contract(`profiles/${name}/profile.yaml`);
  requireKeys(manifest, ['profile', 'meaning', 'contracts', 'adapter_fields'], `profile ${name}`);
  if (manifest.profile !== name) {
    throw new Error(`profiles/${name}/profile.yaml declares profile ${manifest.profile}`);
  }
  const declared = manifest.adapter_fields;
  requireType(declared, 'object', `profile ${name} adapter_fields`);
  for (const key of ['sections', 'required', 'optional', 'forbidden']) {
    requireType(declared[key], 'array', `profile ${name} adapter_fields.${key}`);
    const expected = PROFILE_RULES[name][key];
    if (declared[key].length !== expected.length || declared[key].some((item, index) => item !== expected[index])) {
      throw new Error(`profiles/${name}/profile.yaml adapter_fields.${key} disagrees with the adapter contract`);
    }
  }
  if (at(manifest, 'contracts', 'core') !== '.agents/context/execution.yaml') {
    throw new Error(`profiles/${name}/profile.yaml must inherit the neutral core contract`);
  }
}

const serverExecution = contract('profiles/server/context/execution.yaml');
requireKeys(serverExecution, [
  'deploy_gate', 'artifact', 'propagation', 'verification', 'rollback',
  'concurrency', 'drift', 'environment_tiers', 'ops_profile', 'server_workspace',
], 'server profile execution contract');
if (!Array.isArray(at(serverExecution, 'ops_profile', 'proceed_without_approval'))
    || at(serverExecution, 'ops_profile', 'proceed_without_approval').length === 0) {
  throw new Error('server profile contract must name what may proceed without approval');
}
if (!Array.isArray(at(serverExecution, 'ops_profile', 'requires_approval'))
    || at(serverExecution, 'ops_profile', 'requires_approval').length === 0) {
  throw new Error('server profile contract must name what still requires approval');
}
if (at(serverExecution, 'artifact', 'server_source_mount') !== 'forbidden') {
  throw new Error('server profile contract must keep server source mounts forbidden');
}
if (at(serverExecution, 'rollback', 'must_be_materialized_before_change') !== true) {
  throw new Error('server profile contract must keep rollback materialized before the change');
}
if (at(serverExecution, 'server_workspace', 'adapter_field') !== 'workspace.ssh_home_pattern') {
  throw new Error('server profile contract must bind the shared-host home to workspace.ssh_home_pattern');
}

const qaRounds = contract('profiles/local/context/qa-rounds.yaml');
requireKeys(qaRounds, ['round', 'bundle', 'claim', 'receipts', 'verdicts', 'ledger', 'close'], 'local profile qa-round contract');
if (at(qaRounds, 'claim', 'is') !== '수신 확인') {
  throw new Error('local profile contract must make a claim the acknowledgement');
}
if (!(at(qaRounds, 'receipts', 'start', 'required') ?? []).includes('pid')) {
  throw new Error('local profile contract must make a start receipt carry the runner PID');
}
for (const verdict of ['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN']) {
  if (!(at(qaRounds, 'verdicts', 'allowed') ?? []).includes(verdict)) {
    throw new Error(`local profile contract must allow the verdict ${verdict}`);
  }
}

const method = contract('.agents/context/development-method.yaml');
requireKeys(method, [
  'vocabulary', 'change_classification', 'use_case', 'feature_spec',
  'tests', 'independent_review', 'shared_data', 'completion',
], 'development method');
if (at(method, 'vocabulary', 'undefined_term_behavior') !== 'ask, never infer') {
  throw new Error('development method must keep an undefined term a question, not a guess');
}
if (at(method, 'completion', 'ai_may_not_declare_completion') !== true) {
  throw new Error('development method must keep completion a human decision');
}

// --- visibility coherence ---------------------------------------------------

// The license, the package metadata and the declared visibility are three
// statements about the same fact. A repository described as ready to open while
// its license forbids copying is not ready; it is inconsistent.
// Identity is three statements: what the repository is called, where it lives,
// and whether it is open. A declared visibility that disagrees with GitHub is
// worse than no declaration, because the index gets believed instead of the
// repository.
for (const field of ['name', 'repository', 'visibility']) {
  if (typeof at(policy, 'identity', field) !== 'string' || at(policy, 'identity', field).trim() === '') {
    throw new Error(`project policy identity must declare ${field}`);
  }
}
if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/.test(at(policy, 'identity', 'repository'))) {
  throw new Error('project policy identity.repository must be owner/name');
}
const visibility = at(policy, 'identity', 'visibility');
const packageJson = JSON.parse(read('package.json'));
const license = read('LICENSE');
const licenseIsProprietary = /All rights reserved|No permission is granted/i.test(license);
if (visibility === 'private') {
  if (packageJson.private !== true) throw new Error('a private project must keep package.json private: true');
  if (!licenseIsProprietary) throw new Error('a private project must keep a license that does not grant redistribution');
} else if (visibility === 'public') {
  if (packageJson.private === true) throw new Error('a public project must not keep package.json private: true');
  if (licenseIsProprietary) throw new Error('a public project must not keep an all-rights-reserved license');
} else {
  throw new Error(`identity.visibility must be private or public, found: ${visibility}`);
}

// Production is an owner-gated action. The public adapter deliberately has no
// deployment command, so its workflow must be manually dispatched, protected
// by the named environment, and fail closed. A push or pull-request trigger
// would make a public contribution look like an approved production release.
const productionWorkflow = read('.github/workflows/production-deploy.yml');
if (!/^\s*workflow_dispatch\s*:/m.test(productionWorkflow)) {
  throw new Error('production workflow must be manual-only (workflow_dispatch)');
}
if (/^\s*(push|pull_request)\s*:/m.test(productionWorkflow)) {
  throw new Error('production workflow must not trigger from push or pull_request');
}
if (!/^\s*environment:\s*production\s*$/m.test(productionWorkflow)) {
  throw new Error('production workflow must name the production environment');
}
if (!/\bexit\s+1\b/.test(productionWorkflow)) {
  throw new Error('unconfigured production workflow must fail closed');
}

const gatewayEntrypoint = read('ops/gateway/dcg.sh');
if (!gatewayEntrypoint.includes('scripts/policy-guard.mjs')
    || !gatewayEntrypoint.includes('--operation')
    || !gatewayEntrypoint.includes('GATEWAY_PROJECT_YAML')) {
  throw new Error('dcg.sh must run the common policy guard before handing off to a runtime');
}
const contactWindowEntrypoint = read('ops/gateway/contact-window.sh');
if (!contactWindowEntrypoint.includes('policy-guard.mjs')
    || !contactWindowEntrypoint.includes('--operation contact-window')) {
  throw new Error('contact-window.sh must consume the common work-hour policy guard');
}

// --- project template and activated adapters --------------------------------

// A new project copies a template, so a template that declares no profile
// hands every copy the same missing declaration.
const TEMPLATES = { server: 'projects/_template/project.yaml', local: 'projects/_template-local/project.yaml' };
const templates = {};
for (const [name, relative] of Object.entries(TEMPLATES)) {
  const parsed = contract(relative);
  templates[name] = parsed;
  if (parsed.profile !== name) {
    throw new Error(`${relative} must declare profile: ${name}`);
  }
  requireKeys(parsed, PROFILE_RULES[name].sections, `${name} project template`);
  if (parsed.policy_contract_version !== 1) {
    throw new Error(`${name} project template must opt into policy_contract_version 1`);
  }
  if (at(parsed, 'ops_profile', 'stall_forbidden') !== true) {
    throw new Error(`${name} project template must forbid stalling a thread on a bounded production read`);
  }
  for (const dotted of PROFILE_RULES[name].forbidden) {
    let current = parsed;
    let present = true;
    for (const key of dotted.split('.')) {
      if (current === null || typeof current !== 'object' || !Object.hasOwn(current, key)) { present = false; break; }
      current = current[key];
    }
    if (present) throw new Error(`${relative} carries ${dotted}, which the ${name} profile forbids`);
  }
}

const { server: template, local: localTemplate } = templates;
if (at(template, 'guards', 'production_requires_issue_approval') !== true) {
  throw new Error('project template must require issue approval for production');
}
if (at(localTemplate, 'local_workspace', 'devices_dir') === undefined) {
  throw new Error('the local project template is missing local_workspace.devices_dir');
}

// Every execution command an adapter must answer. Checking only three of them
// let an adapter claim a reachable tier while propagation, rollback, the intake
// scan and the serving-revision proof were all still null.
const TIER_COMMANDS = [
  ['execution', 'deploy_gate_command'],
  ['execution', 'drift_check_command'],
  ['execution', 'verification', 'command'],
  ['execution', 'artifact', 'intake_scan_command'],
];
const PER_TIER_COMMANDS = ['reload_command', 'cache_invalidation_command', 'serving_revision_proof_command'];

// A new project copies this template, so anything an onboarding step must answer
// has to exist here as an unfilled field rather than be remembered by a person.
const CONTACT_WINDOW_KEYS = ['timezone', 'days', 'start_hour', 'end_hour'];
for (const [name, parsed] of Object.entries(templates)) {
  for (const key of CONTACT_WINDOW_KEYS) {
    if (at(parsed, 'discord', 'contact_window', key) === undefined) {
      throw new Error(`${name} project template is missing discord.contact_window.${key}`);
    }
  }
  if (at(parsed, 'discord', 'default_responder_alias') === undefined) {
    throw new Error(`${name} project template is missing discord.default_responder_alias`);
  }
}

const TEAM_POLICY_KEYS = {
  authorization: [
    'issue_required', 'chat_grants_authority', 'production_deploy_role',
    'database_write_requires_explicit_authority', 'issue_work_roles',
  ],
  work_hours: CONTACT_WINDOW_KEYS,
  approval: ['production_deploy', 'high_system_risk', 'incident_rollback'],
  assignment: ['issue_assignee_required', 'unanswered_thread_recipient', 'default_responder_alias'],
};
for (const [name, parsed] of Object.entries(templates)) {
  for (const [section, keys] of Object.entries(TEAM_POLICY_KEYS)) {
    if (at(parsed, 'team_policy', section) === undefined) {
      throw new Error(`${name} project template is missing team_policy.${section}`);
    }
    for (const key of keys) {
      if (at(parsed, 'team_policy', section, key) === undefined) {
        throw new Error(`${name} project template is missing team_policy.${section}.${key}`);
      }
    }
  }
  for (const roleGroup of ['contributors', 'integrators', 'release_owners']) {
    if (!Array.isArray(at(parsed, 'roles', roleGroup))) {
      throw new Error(`${name} project template must declare roles.${roleGroup} as an array`);
    }
  }
}

for (const target of TIER_COMMANDS) {
  if (at(template, ...target) === undefined) {
    throw new Error(`project template is missing ${target.join('.')}`);
  }
}
for (const tier of ['development', 'production']) {
  for (const key of PER_TIER_COMMANDS) {
    if (at(template, 'execution', 'propagation', tier, key) === undefined) {
      throw new Error(`project template is missing execution.propagation.${tier}.${key}`);
    }
  }
  if (at(template, 'execution', 'rollback', tier) === undefined) {
    throw new Error(`project template is missing execution.rollback.${tier}`);
  }
  for (const key of ['source_revision_origin', 'database', 'deployable_by', 'reachable']) {
    if (at(template, 'tiers', tier, key) === undefined) {
      throw new Error(`project template is missing tiers.${tier}.${key}`);
    }
  }
}

const projectsDir = path.join(root, 'projects');
for (const entry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
  // Every underscore-prefixed directory is scaffolding to copy, not an
  // activated adapter; the templates are checked above with their own rules.
  if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
  const relative = path.join('projects', entry.name, 'project.yaml');
  if (!fs.existsSync(path.join(root, relative))) throw new Error(`adapter ${entry.name} has no project.yaml`);
  const adapter = contract(relative);
  assertAdapterContractShape(adapter, `adapter ${entry.name}`);
  const text = read(relative);
  for (const placeholder of ['replace-me', 'replace.example', 'replace-with-']) {
    if (text.includes(placeholder)) throw new Error(`adapter ${entry.name} still carries the placeholder ${placeholder}`);
  }

  // Turning Discord on means the bot will ask people things. When it may ask has
  // to be a decided value, not a default buried in whichever script runs it.
  if (at(adapter, 'discord', 'enabled') === true) {
    for (const key of CONTACT_WINDOW_KEYS) {
      if (at(adapter, 'discord', 'contact_window', key) == null) {
        throw new Error(`adapter ${entry.name} enables Discord but leaves discord.contact_window.${key} unset`);
      }
    }
    if (at(adapter, 'discord', 'default_responder_alias') === undefined) {
      throw new Error(`adapter ${entry.name} enables Discord but omits discord.default_responder_alias (null means no default)`);
    }
    if (at(adapter, 'ops_profile', 'stall_forbidden') !== true) {
      throw new Error(`adapter ${entry.name} enables Discord but does not forbid stalling on a bounded production read`);
    }
    if (at(adapter, 'ops_profile', 'attention_routing', 'bot_work_must_not_land_on_owner') !== true) {
      throw new Error(`adapter ${entry.name} enables Discord but still dumps bot work on the owner`);
    }
  }

  for (const [tier, definition] of Object.entries(at(adapter, 'tiers') ?? {})) {
    if (at(definition, 'reachable') !== true) continue;
    // A reachable tier is a tier people will deploy to, so every guard the
    // contract names has to exist for it.
    for (const target of TIER_COMMANDS) {
      if (!at(adapter, ...target)) {
        throw new Error(`adapter ${entry.name} declares tier ${tier} reachable but leaves ${target.join('.')} empty`);
      }
    }
    for (const key of PER_TIER_COMMANDS) {
      if (!at(adapter, 'execution', 'propagation', tier, key)) {
        throw new Error(`adapter ${entry.name} declares tier ${tier} reachable but leaves execution.propagation.${tier}.${key} empty`);
      }
    }
    if (!at(adapter, 'execution', 'rollback', tier)) {
      throw new Error(`adapter ${entry.name} declares tier ${tier} reachable but has no rollback for it`);
    }
    if (!at(definition, 'deployable_by')) {
      throw new Error(`adapter ${entry.name} declares tier ${tier} reachable without naming who may deploy it`);
    }
  }
}

// --- participant schema and ignored tool state ------------------------------

const participantSchema = JSON.parse(read('schemas/participants.schema.json'));
if (participantSchema.additionalProperties !== false || !participantSchema.required.includes('participants')) {
  throw new Error('participant schema must reject unknown root fields and require participants');
}
const participantItem = participantSchema.properties?.participants?.items;
if (participantItem?.additionalProperties !== false
    || !participantItem?.required?.includes('roles')
    || participantItem?.properties?.enabled?.type !== 'boolean') {
  throw new Error('participant schema must require typed role and enabled fields');
}

const ignore = read('.gitignore');
for (const rule of ['.agents/session-contracts/', '.agents/harness/']) {
  if (!ignore.includes(rule)) throw new Error(`.gitignore must exclude tool state: ${rule}`);
}

console.log('structure validation passed (contracts parsed, not grepped)');
