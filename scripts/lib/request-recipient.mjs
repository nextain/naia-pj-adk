// Pure contract helper for a trusted messaging host. No network, notification,
// approval consumption or tracker mutation occurs here. The host authenticates
// identities and supplies a fresh, canonical issue/thread/request projection.
export const REQUEST_RECIPIENT_POLICIES = Object.freeze([
  'last_human_in_thread',
  'request_recipient_then_last_human',
]);

const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const repair = reason => ({ action: 'agent_repair', reason });

/** Select an alias, never an operational authority or a raw mention. */
export function selectRequestRecipient({
  policy, context, request, registeredHumans, lastHuman,
  now, workQueued = false, closed = false, held = false,
}) {
  if (!REQUEST_RECIPIENT_POLICIES.includes(policy)) return repair('unknown_policy');
  if (typeof workQueued !== 'boolean' || typeof closed !== 'boolean' || typeof held !== 'boolean') return repair('invalid_work_state');
  if (closed || held || workQueued) return { action: 'none', reason: closed ? 'closed' : held ? 'held' : 'work_queued' };
  if (!Array.isArray(registeredHumans) || !registeredHumans.every(nonempty)
      || new Set(registeredHumans).size !== registeredHumans.length) return repair('invalid_registry');

  // An explicit request is never silently redirected, even when a caller is
  // migrating from the legacy policy. Only absence permits speaker fallback.
  if (request !== undefined) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) return repair('invalid_request');
    for (const key of ['project', 'workItem', 'thread', 'requestId']) {
      if (!nonempty(context?.[key]) || request[key] !== context[key]) return repair('request_binding_mismatch');
    }
    if (request.state !== 'pending') return repair('request_not_pending');
    if (!nonempty(request.recipient) || !registeredHumans.includes(request.recipient)) return repair('invalid_recipient');
    for (const key of ['decision', 'planRef', 'replyTemplate']) {
      if (!nonempty(request[key])) return repair('incomplete_request');
    }
    // Require an explicit timezone so host-local clocks cannot extend a wait.
    const expiry = typeof request.expiresAt === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(request.expiresAt)
      ? Date.parse(request.expiresAt) : NaN;
    if (!Number.isFinite(now) || !Number.isFinite(expiry) || expiry <= now) return repair('expired_or_invalid_clock');
    return { action: 'ask', recipient: request.recipient, source: 'request' };
  }
  if (context?.requestId !== undefined) {
    return repair('missing_active_request');
  }
  if (!nonempty(lastHuman) || !registeredHumans.includes(lastHuman)) return repair('no_registered_speaker');
  return { action: 'ask', recipient: lastHuman, source: 'last_human' };
}
