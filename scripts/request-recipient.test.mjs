import assert from 'node:assert/strict';
import test from 'node:test';
import { selectRequestRecipient } from './lib/request-recipient.mjs';

const context = { project: 'example', workItem: 'example/project#7', thread: 'thread-a', requestId: 'plan-a' };
const fixture = () => ({
  policy: 'request_recipient_then_last_human', context: { ...context },
  request: { ...context, state: 'pending', recipient: 'reviewer', decision: 'Approve the reviewed plan?',
    planRef: 'plan-a', replyTemplate: 'approve plan-a / hold reason', expiresAt: '2030-01-02T00:00:00Z' },
  registeredHumans: ['author', 'reviewer'], lastHuman: 'author', now: Date.parse('2030-01-01T00:00:00Z'),
});

test('follow-up stays with the reviewer when another human spoke later', () => {
  const input = fixture(); const before = structuredClone(input);
  assert.deepEqual(selectRequestRecipient(input), { action: 'ask', recipient: 'reviewer', source: 'request' });
  assert.deepEqual(input, before);
});

for (const policy of ['last_human_in_thread', 'request_recipient_then_last_human']) {
  test(`${policy}: only an absent request permits speaker fallback`, () => {
    const input = fixture(); input.policy = policy; delete input.request; delete input.context.requestId;
    assert.equal(selectRequestRecipient(input).recipient, 'author');
    input.request = null;
    assert.equal(selectRequestRecipient(input).action, 'agent_repair');
  });
  test(`${policy}: invalid explicit recipient never falls back`, () => {
    const input = fixture(); input.policy = policy; input.request.recipient = 'unknown';
    assert.equal(selectRequestRecipient(input).action, 'agent_repair');
  });
}

for (const key of ['project', 'workItem', 'thread', 'requestId']) {
  test(`stale or cross-bound ${key} is returned to the agent`, () => {
    const input = fixture(); input.request[key] = 'different';
    assert.equal(selectRequestRecipient(input).reason, 'request_binding_mismatch');
  });
}
for (const key of ['decision', 'planRef', 'replyTemplate']) {
  test(`missing ${key} is preparation work, not a human nudge`, () => {
    const input = fixture(); delete input.request[key];
    assert.equal(selectRequestRecipient(input).reason, 'incomplete_request');
  });
}
for (const expiresAt of ['2029-01-01T00:00:00Z', '2030-01-01T00:00:00Z', '2031-01-01T00:00:00', 'invalid']) {
  test(`invalid or expired request clock: ${expiresAt}`, () => {
    const input = fixture(); input.request.expiresAt = expiresAt;
    assert.equal(selectRequestRecipient(input).action, 'agent_repair');
  });
}
for (const policy of ['last_human_in_thread', 'request_recipient_then_last_human']) {
  test(`${policy}: missing active request is not a generic unanswered thread`, () => {
    const input = fixture(); input.policy = policy; delete input.request;
    assert.equal(selectRequestRecipient(input).reason, 'missing_active_request');
  });
}
test('unavailable registry, clock and non-pending request fail closed', () => {
  for (const change of [ { registeredHumans: [] }, { registeredHumans: ['reviewer', 'reviewer'] }, { now: NaN },
    { request: { ...fixture().request, state: 'cancelled' } } ]) {
    assert.equal(selectRequestRecipient({ ...fixture(), ...change }).action, 'agent_repair');
  }
});
test('queued bot work and closed items suppress asks', () => {
  for (const change of [{ workQueued: true }, { closed: true }]) {
    assert.equal(selectRequestRecipient({ ...fixture(), ...change }).action, 'none');
  }
});
test('unknown policy or malformed state never sends', () => {
  for (const change of [{ policy: 'owner' }, { workQueued: 'false' }, { closed: null }]) {
    assert.equal(selectRequestRecipient({ ...fixture(), ...change }).action, 'agent_repair');
  }
});
test('no implicit owner or bot fallback exists', () => {
  const input = fixture(); delete input.request; delete input.context.requestId; input.lastHuman = 'bot';
  assert.equal(selectRequestRecipient(input).reason, 'no_registered_speaker');
});

test('an explicit host hold suppresses reminders without interpreting reply words', () => {
  const input = fixture(); input.held = true;
  assert.deepEqual(selectRequestRecipient(input), { action: 'none', reason: 'held' });
  delete input.held;
  input.request.replyTemplate = 'approve plan-a / hold reason';
  assert.equal(selectRequestRecipient(input).action, 'ask');
  input.held = 'false';
  assert.equal(selectRequestRecipient(input).reason, 'invalid_work_state');
});
