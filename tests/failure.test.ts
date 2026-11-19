import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure, httpStatus, RequestFailure } from '../src/failure';
import { ForgePilotError, publicError, jsonLogger } from '../src/log';
import { requireSuccessfulCompletion } from '../src/completion';

test('failure taxonomy uses bounded status and SDK/provider metadata', () => {
  const cases = [
    [401, 'bad', 'credentials'], [403, 'bad', 'forbidden'], [429, 'limit', 'rate_limit'],
    [429, 'Rate limit exceeded: free-models-per-day', 'daily_quota'], [502, 'bad', 'provider_unavailable'],
    [503, 'bad', 'provider_unavailable'], [504, 'bad', 'provider_unavailable'], [404, 'unknown model', 'model_configuration'],
    [0, 'getaddrinfo ENOTFOUND', 'network'], [0, 'ECONNREFUSED', 'network'], [0, 'EAI_AGAIN', 'network'], [0, '[Model Error] Cannot connect to API:', 'network'],
    [0, 'Connection timed out', 'timeout'], [0, 'ETIMEDOUT', 'timeout'], [0, 'provider stream error', 'sdk_stream'],
  ] as const;
  for (const [status, message, expected] of cases) {
    const cause = Object.assign(new Error(message + ' sk-secret'), { statusCode: status });
    const failure = classifyFailure(cause, 'provider');
    assert.equal(failure.kind, expected); assert.equal(failure.cause, cause); assert.ok(!failure.message.includes('sk-secret'));
    assert.equal(failure.fallbackEligible, expected !== 'sdk_stream');
  }
  for (const item of [{ statusCode: 401 }, { status: '401' }, { response: { status: 401 } }, { cause: { statusCode: 401 } }]) assert.equal(httpStatus(item), 401);
  assert.equal(httpStatus({ body: { status: 401 } }), undefined);
  assert.equal(httpStatus({ status: 200 }), undefined);
  assert.equal(classifyFailure(new Error('random secret')).kind, 'unknown');
});
test('local conflicts, invalid patches, denied approvals and cancellation never select fallback', () => {
  for (const [message, kind] of [['Malformed patch HTTP 503', 'invalid_proposal'], ['Stale document conflict', 'conflict'], ['Patch tool approval rejected', 'approval_denied'], ['Turn cancelled HTTP 503', 'cancelled']] as const) {
    const failure = classifyFailure(new ForgePilotError(message)); assert.equal(failure.kind, kind); assert.equal(failure.fallbackEligible, false);
  }
});
test('terminal provider errors preserve typed causes while public logs contain no raw body or credentials', () => {
  for (const [message, kind] of [['Model invocation failed: AuthenticationError: 401 secret-token', 'credentials'], ['HTTP 503 secret-token', 'provider_unavailable'], ['[Model Error] Cannot connect to API:', 'network'], ['Rate limit exceeded: free-models-per-day secret-token', 'daily_quota']] as const) {
    assert.throws(() => requireSuccessfulCompletion({ status: 'error', message }), (error: unknown) => {
      assert.ok(error instanceof RequestFailure); assert.equal(error.kind, kind); assert.ok(!publicError(error).includes('secret-token')); return true;
    });
  }
  const error = Object.assign(new Error('Authorization: Bearer secret-token'), { statusCode: 401, body: { error: { message: 'secret-token' } }, headers: { Authorization: 'secret-token' } });
  assert.ok(!publicError(error).includes('secret-token'));
  let log = ''; jsonLogger(line => { log += line; })('failure', { kind: classifyFailure(error).kind });
  assert.ok(!log.includes('secret-token'));
});
