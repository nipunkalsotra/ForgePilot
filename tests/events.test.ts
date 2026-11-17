import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventRenderer } from '../src/events';

test('streams deltas immediately and avoids duplicate final content', () => {
  let text = '';
  const renderer = new EventRenderer(chunk => { text += chunk; }, () => {});
  renderer.accept({ type: 'model.message.delta', id: '1', threadId: 'main', content: 'Hel' });
  assert.equal(text, 'Hel');
  renderer.accept({ type: 'model.message.delta', id: '2', threadId: 'main', content: 'lo' });
  renderer.accept({ type: 'model.message', id: '3', threadId: 'main', createdAt: '', content: 'Hello' });
  assert.equal(text, 'Hello');
  renderer.accept({ type: 'model.message', id: '4', threadId: 'main', createdAt: '', content: 'Next message' });
  assert.equal(text, 'HelloNext message');
  renderer.accept({ type: 'turn.done', id: '5', createdAt: '', threadId: null, state: { status: 'done', completedAt: '', output: null, requiredActions: [] } });
  assert.equal(renderer.terminal, true);
});

test('model failures and pauses surface actionable errors', () => {
  const renderer = new EventRenderer(() => {}, () => {});
  assert.throws(() => renderer.accept({ type: 'turn.done', id: '1', createdAt: '', threadId: null,
    state: { status: 'error', completedAt: '', message: 'provider credentials secret' } }), /TrueForge turn failed/);
  assert.throws(() => renderer.accept({ type: 'tool.approval_required', id: '2', threadId: 'main', createdAt: '', toolCalls: [] }), /paused/);
});
