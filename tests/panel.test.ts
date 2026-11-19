import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { PanelState, panelMessageSchema } from '../src/panel-state';
import type { BatchProposal } from '../src/batch';

const stream = (state: PanelState, event: object, sessionId = 'real-sdk-session') => state.stream({ id: randomUUID(), threadId: 'main', createdAt: '', ...event } as TrueForgeApi.TurnStreamingEvent, { sessionId, modelName: 'fixture/model' });
test('panel manifest uses its own activity bar, preserves all existing commands and contributes a supported webview', async () => {
  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal(manifest.contributes.views.forgepilot[0].type, 'webview'); assert.equal(manifest.contributes.viewsContainers.activitybar[0].id, 'forgepilot');
  assert.equal(manifest.contributes.commands.length, 26); const ids = manifest.contributes.commands.map((c: {command: string}) => c.command);
  for (const id of ['autonomous', 'contextInspector', 'verificationTerminal', 'inlineEdit', 'batchApply', 'batchUndo', 'newSession']) assert.ok(ids.includes(`forgepilot.${id}`));
});
test('panel message schema rejects malformed data, authority fields, oversized input and arbitrary commands', () => {
  const sessionId = randomUUID(), requestId = null;
  for (const input of [null, {}, { type: 'command', command: 'rm -rf' }, { type: 'submit', sessionId, requestId, text: '' }, { type: 'submit', sessionId, requestId, text: 'a'.repeat(16001) },
    { type: 'apply', sessionId, requestId, approved: true }, { type: 'submit', sessionId: 'stale', requestId, text: 'hi' }, { type: 'diff', sessionId, requestId, fileId: '../etc/passwd' }])
    assert.equal(panelMessageSchema.safeParse(input).success, false);
  assert.equal(panelMessageSchema.safeParse({ type: 'submit', sessionId, requestId, text: '<script>untrusted</script>' }).success, true, 'Treat text as data rather than accepting authority');
});
test('panel maps genuine SDK delta events incrementally without printing the final content twice', () => {
  const state = new PanelState(), events: object[] = []; state.subscribe(event => events.push(event)); state.begin('Inspect this repository');
  stream(state, { type: 'model.message.delta', content: 'First ' }); stream(state, { type: 'model.message.delta', content: 'second' });
  stream(state, { type: 'model.message', content: 'First second' });
  assert.equal(state.messages[1]?.text, 'First second'); assert.equal(state.model, 'fixture/model'); assert.equal(state.backendSession, 'real-sdk-session');
  assert.equal(events.filter(e => 'type' in e && e.type === 'append').length, 2);
  assert.equal(events.filter(e => 'type' in e && e.type === 'snapshot').length, 1, 'No full rerender for individual deltas');
  stream(state, { type: 'model.message', content: 'A final-only message' }); assert.equal(state.messages[2]?.text, 'A final-only message');
});
test('panel shows tool activity and exact approval/running/error state without treating it as source-edit permission', () => {
  const state = new PanelState(); state.begin('Run verification');
  stream(state, { type: 'model.message', content: null, toolCalls: [{ id: 'call', function: { name: 'call_tool', arguments: JSON.stringify({ tool_name: 'run_command' }) }, toolInfo: { type: 'truefoundry-system', name: 'call_tool' } }] });
  assert.equal(state.tools[0]?.name, 'run_command');
  stream(state, { type: 'tool.approval_required', toolCalls: [{ id: 'call', sourceEventId: 'source' }] }); assert.equal(state.state, 'awaiting approval');
  state.tool('call', 'run_command', 'approved', 'git status'); state.tool('call', 'run_command', 'running', 'git status');
  stream(state, { type: 'tool.response', toolCallId: 'call', content: '{}' }); assert.equal(state.state, 'running');
  state.tool('call', 'run_command', 'failed', 'Exit 7\nTOKEN=redact-me'); assert.equal(state.proposal, null); assert.doesNotMatch(state.tools[0]!.detail, /redact-me/);
  state.status('failed', 'The saved model is unavailable.'); assert.equal(state.error, 'The saved model is unavailable.');
});
test('panel cancellation and reset invalidate prior request/session identities and stale proposal exposure', () => {
  const state = new PanelState(), session = state.sessionId, request = state.begin('work'); state.tool('call', 'run_command', 'running');
  state.cancel(); assert.equal(state.state, 'cancelled'); assert.equal(state.current(request), false); assert.equal(state.tools[0]?.phase, 'cancelled'); assert.equal(state.proposal, null);
  state.reset(); assert.notEqual(state.sessionId, session); assert.equal(state.messages.length, 0); assert.equal(state.requestId, null); assert.equal(state.state, 'idle');
});
test('real-runtime non-JSON terminal denial stays rejected and cannot become a completed command', () => {
  const state = new PanelState(); state.begin('verify'); state.tool('denied', 'run_command', 'rejected');
  state.observation({ tool: 'run_command', callId: 'denied', result: { error: 'Non-JSON tool response' }, responseBytes: 42 });
  assert.equal(state.tools[0]?.phase, 'rejected'); assert.match(state.tools[0]!.detail, /No execution/);
  state.observation({ tool: 'run_command', callId: 'missing', result: { error: 'Non-JSON tool response' }, responseBytes: 42 });
  assert.equal(state.tools[1]?.phase, 'failed');
  state.observation({ tool: 'run_command', callId: 'denied-json', result: { kind: 'forgepilot.command', termination: 'denied' }, responseBytes: 42 });
  assert.equal(state.tools[2]?.phase, 'rejected');
});
test('panel proposal distinguishes staged, mixed decisions and partial application; incomplete proposals never surface', () => {
  const state = new PanelState(); state.begin('change');
  const proposal = { id: randomUUID(), plan: 'test', status: 'staged', generationSucceeded: false, toolApproved: true,
    files: [{ id: randomUUID(), path: 'file.ts', operation: 'modify', hunks: [{ decision: 'pending' }, { decision: 'pending' }] }] } as BatchProposal;
  state.proposalChanged(proposal); assert.equal(state.proposal, null); proposal.generationSucceeded = true; state.proposalChanged(proposal);
  assert.equal(state.proposal!.status, 'staged'); assert.equal(state.proposal!.files[0]!.pending, 2);
  proposal.files[0]!.hunks[0]!.decision = 'accepted'; proposal.files[0]!.hunks[1]!.decision = 'rejected'; state.proposalChanged(proposal); assert.equal(state.proposal!.status, 'staged');
  proposal.status = 'applied'; state.proposalChanged(proposal); assert.equal(state.proposal!.status, 'partially applied');
  state.status('failed', 'Generation failed'); assert.equal(state.proposal, null);
});
test('webview uses local nonce scripts, restrictive CSP, text-only rendering and bounded accessible controls', async () => {
  const contents = await Promise.all(['src/panel.ts', 'media/agent.js', 'media/agent.css'].map(p => readFile(p, 'utf8')));
  const provider = contents[0]!, script = contents[1]!, css = contents[2]!;
  assert.match(provider, /default-src 'none'/); assert.match(provider, /script-src 'nonce-/); assert.match(provider, /localResourceRoots/); assert.doesNotMatch(provider, /https?:\/\//);
  assert.doesNotMatch(script, /innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function|fetch\(/);
  assert.match(script, /textContent/); assert.match(script, /createTextNode/); assert.match(script, /event\.sessionId !== sessionId/);
  assert.match(provider, /onDidDispose/); assert.match(provider, /aria-label/); assert.match(script, /ctrlKey \|\| event.metaKey/); assert.match(css, /--vscode-/);
  const state = new PanelState(); state.begin('<img src=x onerror="alert(1)">'); stream(state, { type: 'model.message.delta', content: '<script>alert(2)</script>' });
  assert.equal(state.messages[1]?.text, '<script>alert(2)</script>', 'Untrusted content remains literal text');
});
