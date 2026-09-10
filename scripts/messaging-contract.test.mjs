import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { parseYaml } from './lib/yaml-lite.mjs';
import { assertMessagingOwnership } from './lib/messaging-contract.mjs';

const contract = parseYaml(fs.readFileSync(new URL('../.agents/context/messaging.yaml', import.meta.url), 'utf8'));
test('the checked-in ownership contract keeps shared engines and host policy separate', () => {
  assert.doesNotThrow(() => assertMessagingOwnership(contract));
});
for (const mutate of [
  value => { value.instance_holds = value.instance_holds.join(','); },
  value => { value.instance_holds.push('copied_shared_engine'); },
  value => { value.host_adapter_concerns.push('gateway_loop'); },
  value => { delete value.shared_engine_concerns; delete value.host_adapter_concerns; },
  value => { value.instance_must_not_hold = []; },
  value => { value.shared_engine_concerns[0] = null; },
  value => { value.host_adapter_concerns[0] = value.host_adapter_concerns[1]; },
]) {
  test(`reject malformed or crossed ownership: ${mutate.toString()}`, () => {
    const candidate = structuredClone(contract); mutate(candidate);
    assert.throws(() => assertMessagingOwnership(candidate), /invalid/);
  });
}
