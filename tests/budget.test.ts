import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TokenBudgetManager, BudgetStop } from '../src/budget';

test('actual SDK turn aggregates replace snapshots; cache and reasoning never inflate total', () => {
  const m = new TokenBudgetManager();
  m.metrics('session', 'turn', { totalInputTokens: 100, totalOutputTokens: 30, totalTokens: 130, totalCacheReadTokens: 80, totalReasoningTokens: 10 });
  m.metrics('session', 'turn', { totalInputTokens: 150, totalOutputTokens: 50, totalTokens: 200, totalCacheReadTokens: 90, totalReasoningTokens: 15 });
  m.metrics('session', 'turn', { totalInputTokens: 150, totalOutputTokens: 50, totalTokens: 200 });
  assert.deepEqual(m.actual(), { input: 150, output: 50, cachedInput: 90, reasoning: 15, total: 200 });
  m.metrics('session', 'next', { totalTokens: 20, totalCacheWriteTokens: 5 });
  assert.equal(m.actual().total, 220); assert.equal(m.actual().cacheWrite, 5);
});
test('missing metrics remain unknown; reported zero stays actual zero', () => {
  const m = new TokenBudgetManager(); m.metrics('s', 't', undefined); assert.deepEqual(m.actual(), {});
  m.metrics('s', 't', { totalInputTokens: 0, totalOutputTokens: 0, totalTokens: 0 });
  assert.deepEqual(m.actual(), { input: 0, output: 0, total: 0 });
  assert.equal(m.snapshot().providerQuota, 'UNKNOWN');
});
test('malformed, fractional, negative, overflowing and decreasing cumulative counts are rejected', () => {
  for (const value of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const m = new TokenBudgetManager(); m.metrics('s', 't', { totalTokens: value });
    assert.deepEqual(m.actual(), {}); assert.equal(m.snapshot().malformedMetrics, true);
  }
  const m = new TokenBudgetManager(); m.metrics('s', 't', { totalTokens: 50 }); m.metrics('s', 't', { totalTokens: 10 });
  assert.equal(m.actual().total, 50); assert.equal(m.snapshot().malformedMetrics, true);
});
test('estimates include repeated input, deduplicate tool events and remain distinct from actual', () => {
  const m = new TokenBudgetManager(); m.beginAttempt('abc'); m.output('abc'); m.tool('1', 'read_range', 6);
  assert.equal(m.snapshot().estimatedTokens, 5); assert.equal(m.snapshot().toolResponseBytes, 6);
  m.tool('1', 'read_range', 6); assert.equal(m.snapshot().estimatedTokens, 5); assert.equal(m.snapshot().toolCalls, 1);
  m.metrics('s', 't', { totalTokens: 40 }); assert.equal(m.snapshot().estimatedTokens, 5); assert.equal(m.actual().total, 40);
});
test('strict task threshold blocks new discovery but allows safety validation, commands and staging', () => {
  const m = new TokenBudgetManager({ mode: 'strict', taskTokens: 2000 }); m.beginAttempt('');
  m.metrics('s', 't', { totalTokens: 1999 }); assert.doesNotThrow(() => m.beforeTool('read_range'));
  m.metrics('s', 't', { totalTokens: 2000 }); assert.throws(() => m.beforeTool('read_range'), BudgetStop);
  for (const tool of ['check_drafts', 'propose_drafts', 'list_drafts', 'run_command']) assert.doesNotThrow(() => m.beforeTool(tool));
  assert.match(m.snapshot().warning, /exhausted/);
});
test('off and advisory preserve operations even beyond task target', () => {
  for (const mode of ['off', 'advisory']) {
    const m = new TokenBudgetManager({ mode, taskTokens: 2000 }); m.beginAttempt('x'.repeat(9000));
    for (let i = 0; i < 10; i++) assert.doesNotThrow(() => m.beforeTool('context_query', 'same'));
    assert.equal(m.retrievalBudget(12000), 12000);
  }
});
test('configuration is strict and bounded; mismatched model metadata cannot activate provider limits', () => {
  for (const config of [{ taskTokens: 1999 }, { mode: 'invented' }, { providerQuota: 10 }, { maxToolCalls: 0 }, { provider: { model: 'm', safetyMargin: 0 } }, { provider: { model: 'm', contextWindow: -1 } }, { provider: { model: 'm', contextWindow: 2000, maxOutputTokens: 2000 } }]) assert.throws(() => new TokenBudgetManager(config));
  const m = new TokenBudgetManager({ mode: 'conservative', provider: { model: 'a', requestsPerMinute: 1 } });
  m.identify({ model: 'b' }); m.tool('1', 'read_range', 10);
  assert.equal(m.pacingMs(), 0); assert.match(m.snapshot().warning, /does not match/);
});
test('conservative retrieval preserves a minimum useful package and warns about validation reserve', () => {
  const m = new TokenBudgetManager({ mode: 'conservative', taskTokens: 10000 }); m.beginAttempt('x'.repeat(24000));
  assert.equal(m.retrievalBudget(12000), 2000); assert.match(m.snapshot().warning, /reserve/);
  assert.doesNotThrow(() => m.beforeTool('read_range'));
});
test('tool count, repeated identical discovery and repeated failed validation stop bounded nonessential work', () => {
  const m = new TokenBudgetManager({ mode: 'conservative', maxToolCalls: 10, maxRepeatedSearches: 2, maxValidationFailures: 2 });
  m.beforeTool('search_code', 'a'); m.beforeTool('search_code', 'b'); m.beforeTool('search_code', 'a');
  assert.throws(() => m.beforeTool('search_code', 'a'), /identical/);
  m.tool('f1', 'check_drafts', 10, { valid: false }); m.tool('f2', 'check_drafts', 10, { valid: false });
  assert.throws(() => m.beforeTool('draft_file'), /validation/);
  m.tool('ok', 'check_drafts', 10, { valid: true }); assert.doesNotThrow(() => m.beforeTool('draft_file'));
  for (let i = 0; i < 10; i++) m.tool(String(i), 'read_range', 1);
  assert.throws(() => m.beforeTool('read_range'), /tool calls/);
});
test('provider profiles use separate rolling TPM/RPM estimates and expire without fixed delay', () => {
  let now = 0;
  for (const provider of [{ model: 'm', requestsPerMinute: 2 }, { model: 'm', inputTokensPerMinute: 1 }]) {
    const m = new TokenBudgetManager({ mode: 'conservative', provider }, () => now); m.identify({ model: 'm' });
    assert.equal(m.pacingMs(), 0); m.tool('1', 'read_range', 100); assert.equal(m.pacingMs(), 60000);
    now += 60000; assert.equal(m.pacingMs(), 0);
  }
});
test('cancellation interrupts pacing and clears active state without a stuck permission', async () => {
  const m = new TokenBudgetManager({ mode: 'conservative', provider: { model: 'm', requestsPerMinute: 1 } }); m.identify({ model: 'm' }); m.tool('1', 'read_range', 10);
  const controller = new AbortController(); const promise = m.pace(controller.signal);
  assert.ok(m.snapshot().pacingMs > 0); controller.abort(); await assert.rejects(promise, { name: 'AbortError' });
  assert.equal(m.snapshot().pacingMs, 0);
});
test('fallback attempts carry spend and compaction never resets the task budget', () => {
  const m = new TokenBudgetManager({ mode: 'strict', taskTokens: 2000 }); m.beginAttempt('x'.repeat(9000));
  const before = m.snapshot().estimatedTokens; m.compact(); assert.equal(m.snapshot().estimatedTokens, before);
  m.beginAttempt('new request scope'); assert.ok(m.snapshot().estimatedTokens > before);
  assert.throws(() => m.beforeTool('read_range'), BudgetStop);
});
test('post-turn actual input participates in pacing without adding estimated and actual representations', () => {
  let now = 100;
  const m = new TokenBudgetManager({ mode: 'conservative', provider: { model: 'm', inputTokensPerMinute: 100 } }, () => now);
  m.identify({ model: 'm' }); m.metrics('s', 't', { totalInputTokens: 90 });
  assert.equal(m.pacingMs(), 60000); m.metrics('s', 't', { totalInputTokens: 90 }); assert.equal(m.pacingMs(), 60000);
  now += 60000; assert.equal(m.pacingMs(), 0); assert.equal(m.snapshot().actualComplete, false);
});
test('aggregated metrics overflow remains unknown instead of publishing a fabricated saturated count', () => {
  const m = new TokenBudgetManager(); m.metrics('s', 'a', { totalTokens: Number.MAX_SAFE_INTEGER }); m.metrics('s', 'b', { totalTokens: 1 });
  assert.equal(m.actual().total, undefined); assert.equal(m.snapshot().malformedMetrics, true);
});
