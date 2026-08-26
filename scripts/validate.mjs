import fs from 'node:fs';
import path from 'node:path';
import { parseYaml, at } from './lib/yaml-lite.mjs';

// Structure validation reads the contracts as data.
//
// It used to grep the file text for `section:`. A contract could then be the
// wrong type, nested under the wrong parent, duplicated, or not valid YAML at
// all and still pass, because the marker was present. Renaming a section to
// `x_concurrency` also passed, since the substring survived. Parsing removes
// that whole family of false passes.

const root = path.resolve(import.meta.dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

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
  '.agents/context/project-policy.yaml',
  '.agents/context/workflow.yaml',
  '.agents/context/execution.yaml',
  '.agents/context/development-method.yaml',
  '.agents/context/discord.yaml',
  'projects/_template/project.yaml',
  'scripts/lib/yaml-lite.mjs',
];
for (const file of required) {
  if (!fs.existsSync(path.join(root, file))) throw new Error(`missing required file: ${file}`);
}

// --- entrypoint mirrors -----------------------------------------------------

const canonical = read('AGENTS.md');
for (const mirror of ['CLAUDE.md', 'GEMINI.md']) {
  if (canonical !== read(mirror)) throw new Error(`AGENTS.md and ${mirror} must be byte-identical`);
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

const execution = contract('.agents/context/execution.yaml');
requireKeys(execution, [
  'deploy_gate', 'artifact', 'propagation', 'verification', 'rollback',
  'concurrency', 'drift', 'watchdog', 'environment_tiers', 'completion',
], 'execution contract');
if (at(execution, 'completion', 'ai_may_not_declare_completion') !== true) {
  throw new Error('execution contract must keep completion a human decision');
}
if (at(execution, 'watchdog', 'one_item_may_not_stop_the_sweep') !== true) {
  throw new Error('execution contract must keep a single item from stopping a watchdog sweep');
}
if (at(execution, 'watchdog', 'own_failure_must_alarm') !== true) {
  throw new Error("execution contract must keep a watchdog's own failure alarming");
}
if (at(execution, 'artifact', 'server_source_mount') !== 'forbidden') {
  throw new Error('execution contract must keep server source mounts forbidden');
}
if (at(execution, 'rollback', 'must_be_materialized_before_change') !== true) {
  throw new Error('execution contract must keep rollback materialized before the change');
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

// --- project template and activated adapters --------------------------------

const template = contract('projects/_template/project.yaml');
requireKeys(template, ['project', 'workspace', 'roles', 'discord', 'commands', 'guards', 'execution', 'tiers'], 'project template');
if (at(template, 'guards', 'production_requires_issue_approval') !== true) {
  throw new Error('project template must require issue approval for production');
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
  if (!entry.isDirectory() || entry.name === '_template') continue;
  const relative = path.join('projects', entry.name, 'project.yaml');
  if (!fs.existsSync(path.join(root, relative))) throw new Error(`adapter ${entry.name} has no project.yaml`);
  const adapter = contract(relative);
  const text = read(relative);
  for (const placeholder of ['replace-me', 'replace.example', 'replace-with-']) {
    if (text.includes(placeholder)) throw new Error(`adapter ${entry.name} still carries the placeholder ${placeholder}`);
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

const ignore = read('.gitignore');
for (const rule of ['.agents/session-contracts/', '.agents/harness/']) {
  if (!ignore.includes(rule)) throw new Error(`.gitignore must exclude tool state: ${rule}`);
}

console.log('structure validation passed (contracts parsed, not grepped)');
