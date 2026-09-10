import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { parseYaml } from './lib/yaml-lite.mjs';
import { assertAdapterContractShape, PROFILE_RULES } from './lib/adapter-contract.mjs';

const root = path.resolve(import.meta.dirname, '..');
const load = (relative) => parseYaml(fs.readFileSync(path.join(root, relative), 'utf8'));
const adapter = load('projects/example/project.yaml');
const localAdapter = load('projects/example-local/project.yaml');

test('both profiles accept explicit-request routing and retain legacy compatibility', () => {
  for (const source of [adapter, localAdapter]) {
    for (const policy of ['last_human_in_thread', 'request_recipient_then_last_human']) {
      const candidate = structuredClone(source);
      candidate.team_policy.assignment.unanswered_thread_recipient = policy;
      assert.doesNotThrow(() => assertAdapterContractShape(candidate));
    }
    const candidate = structuredClone(source);
    candidate.team_policy.assignment.unanswered_thread_recipient = 'default_owner';
    assert.throws(() => assertAdapterContractShape(candidate), /unanswered_thread_recipient must be one of/);
  }
});

test('accepts a complete activated adapter', () => {
  assert.doesNotThrow(() => assertAdapterContractShape(adapter, 'example'));
});

// --- deployment profiles ----------------------------------------------------

test('the server example still declares the shared-host workspace', () => {
  assert.equal(adapter.profile, 'server');
  assert.equal(typeof adapter.workspace.ssh_home_pattern, 'string');
});

test('accepts a local adapter that has no ssh home, tiers or deploy commands', () => {
  assert.equal(localAdapter.profile, 'local');
  assert.equal(localAdapter.workspace.ssh_home_pattern, undefined);
  assert.equal(localAdapter.tiers, undefined);
  assert.equal(localAdapter.execution, undefined);
  assert.equal(localAdapter.commands.deploy_production, undefined);
  assert.doesNotThrow(() => assertAdapterContractShape(localAdapter, 'example-local'));
});

test('rejects an adapter that declares no profile', () => {
  const unprofiled = structuredClone(adapter);
  delete unprofiled.profile;
  assert.throws(
    () => assertAdapterContractShape(unprofiled, 'unprofiled'),
    /unprofiled is missing the required field: profile/,
  );
});

test('rejects an unknown profile name', () => {
  const wrong = structuredClone(adapter);
  wrong.profile = 'staging';
  assert.throws(
    () => assertAdapterContractShape(wrong, 'wrong-profile'),
    /wrong-profile\.profile must be one of server, local, found staging/,
  );
});

// Carrying a server field into a local adapter is how a copied adapter keeps
// pointing at a home directory nobody has.
test('rejects a local adapter that kept the server workspace field', () => {
  const copied = structuredClone(localAdapter);
  copied.workspace.ssh_home_pattern = '~/example-local-project';
  assert.throws(
    () => assertAdapterContractShape(copied, 'copied-server-field'),
    /copied-server-field\.workspace\.ssh_home_pattern is not part of the local profile/,
  );
});

test('rejects a local adapter that kept deployment tiers', () => {
  const copied = structuredClone(localAdapter);
  copied.tiers = structuredClone(adapter.tiers);
  assert.throws(
    () => assertAdapterContractShape(copied, 'copied-tiers'),
    /copied-tiers\.tiers is not part of the local profile/,
  );
});

test('rejects a server adapter with no ssh home', () => {
  const homeless = structuredClone(adapter);
  delete homeless.workspace.ssh_home_pattern;
  assert.throws(
    () => assertAdapterContractShape(homeless, 'homeless'),
    /homeless\.workspace\.ssh_home_pattern is required by the server profile/,
  );
});

test('rejects a local adapter with no device registry', () => {
  const unregistered = structuredClone(localAdapter);
  delete unregistered.local_workspace.devices_dir;
  assert.throws(
    () => assertAdapterContractShape(unregistered, 'unregistered'),
    /unregistered\.local_workspace\.devices_dir is required by the local profile/,
  );
});

// Both profiles owe replies to people, so neither may route bot work at the
// release owner.
test('both profiles keep the neutral attention routing', () => {
  for (const [label, candidate] of [['example', adapter], ['example-local', localAdapter]]) {
    const routed = structuredClone(candidate);
    routed.ops_profile.attention_routing.bot_work_must_not_land_on_owner = 'yes';
    assert.throws(
      () => assertAdapterContractShape(routed, label),
      /bot_work_must_not_land_on_owner must be boolean/,
    );
  }
});

test('no dotted path is both required and forbidden in a profile', () => {
  for (const [name, rules] of Object.entries(PROFILE_RULES)) {
    for (const dotted of rules.forbidden) {
      assert.ok(!rules.required.includes(dotted), `${name} cannot require and forbid ${dotted}`);
    }
  }
});

test('accepts a reachable tier with a named deployer', () => {
  const complete = structuredClone(adapter);
  complete.tiers.development.reachable = true;
  complete.tiers.development.deployable_by = ['integrator'];
  assert.doesNotThrow(() => assertAdapterContractShape(complete, 'reachable'));
});

test('accepts independent contact and mutation schedules', () => {
  const splitWindows = structuredClone(adapter);
  splitWindows.team_policy.work_hours.start_hour = 9;
  splitWindows.team_policy.work_hours.end_hour = 12;
  splitWindows.discord.contact_window.start_hour = 13;
  splitWindows.discord.contact_window.end_hour = 17;
  assert.doesNotThrow(() => assertAdapterContractShape(splitWindows, 'independent-windows'));
});

test('rejects a production deploy group that includes non-release roles', () => {
  const mixed = structuredClone(adapter);
  mixed.roles.integrators = ['developer', 'owner'];
  mixed.roles.release_owners = ['owner'];
  mixed.team_policy.authorization.production_deploy_role = 'integrators';
  assert.throws(
    () => assertAdapterContractShape(mixed, 'mixed-production-role'),
    /mixed-production-role\.team_policy\.authorization\.production_deploy_role must resolve only to release owner roles/,
  );
});

test('rejects an empty production deploy role', () => {
  const incomplete = structuredClone(adapter);
  incomplete.team_policy.authorization.production_deploy_role = '';
  assert.throws(
    () => assertAdapterContractShape(incomplete, 'empty-production-role'),
    /empty-production-role\.team_policy\.authorization\.production_deploy_role must not be empty/,
  );
});

test('rejects a reachable tier with no deployers', () => {
  const incomplete = structuredClone(adapter);
  incomplete.tiers.development.reachable = true;
  incomplete.tiers.development.deployable_by = [];
  assert.throws(
    () => assertAdapterContractShape(incomplete, 'empty-deployers'),
    /empty-deployers\.tiers\.development\.deployable_by must contain a non-empty deployer when reachable/,
  );
});

test('rejects a reachable tier with an empty deployer name', () => {
  const incomplete = structuredClone(adapter);
  incomplete.tiers.development.reachable = true;
  incomplete.tiers.development.deployable_by = [''];
  assert.throws(
    () => assertAdapterContractShape(incomplete, 'empty-deployer-name'),
    /empty-deployer-name\.tiers\.development\.deployable_by must contain a non-empty deployer when reachable/,
  );
});

test('rejects an adapter with a missing policy section', () => {
  const incomplete = structuredClone(adapter);
  delete incomplete.tiers;
  assert.throws(
    () => assertAdapterContractShape(incomplete, 'incomplete'),
    /incomplete is missing the required field: tiers/,
  );
});

test('rejects an adapter with a malformed policy section', () => {
  const malformed = structuredClone(adapter);
  malformed.roles = [];
  assert.throws(
    () => assertAdapterContractShape(malformed, 'malformed'),
    /malformed\.roles must be object, found array/,
  );
});
