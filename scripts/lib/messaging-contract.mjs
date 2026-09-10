// Shared transport implementation and host work policy have separate owners.
// Exact sets keep malformed declarations and accidental engine copies visible.
const ownership = Object.freeze({
  instance_holds: ['pinned_package_configuration', 'host_work_and_authority_adapters'],
  instance_must_not_hold: ['copied_shared_engine', 'copied_connection_watchdog'],
  shared_engine_concerns: ['gateway_loop', 'backend_execution', 'scope', 'redaction', 'delivery', 'connection_monitoring'],
  host_adapter_concerns: ['work_item_ledger', 'authorization', 'effect_reconciliation', 'work_health'],
});

export function assertMessagingOwnership(value) {
  if (!value || value.provider?.package !== 'naia-messaging') {
    throw new Error('messaging contract must name naia-messaging as the provider package');
  }
  for (const [key, expected] of Object.entries(ownership)) {
    const actual = value[key];
    if (!Array.isArray(actual) || actual.length !== expected.length
        || new Set(actual).size !== actual.length
        || actual.some(item => typeof item !== 'string' || !expected.includes(item))) {
      throw new Error(`messaging contract has invalid ${key}`);
    }
  }
}
