import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { parseYaml } from './lib/yaml-lite.mjs';
import { assertAdapterContractShape } from './lib/adapter-contract.mjs';

const root = path.resolve(import.meta.dirname, '..');
const adapter = parseYaml(fs.readFileSync(path.join(root, 'projects/example/project.yaml'), 'utf8'));

test('accepts a complete activated adapter', () => {
  assert.doesNotThrow(() => assertAdapterContractShape(adapter, 'example'));
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
