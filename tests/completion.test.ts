import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireSuccessfulCompletion } from '../src/completion';

test('only explicitly successful terminal states with no pending actions pass', () => {
  requireSuccessfulCompletion({ status: 'done', requiredActions: [] });
  for (const status of ['error', 'failed', 'cancelled', 'incomplete', 'paused', 'running', '', undefined])
    assert.throws(() => requireSuccessfulCompletion({ status, requiredActions: [] }), /failed/);
  for (const state of [null, {}, { status: 'done' }, { status: 'done', requiredActions: [{}] }, { status: 'done', requiredActions: null }])
    assert.throws(() => requireSuccessfulCompletion(state));
  requireSuccessfulCompletion({ status: 'done', requiredActions: [], output: { finishReason: 'stop' } });
  for (const output of ['malformed', { finishReason: 'length' }, { finishReason: 'content_filter' }, { finishReason: 'tool_calls' }, { refusal: 'blocked' }])
    assert.throws(() => requireSuccessfulCompletion({ status: 'done', requiredActions: [], output }), /incomplete/);
});
