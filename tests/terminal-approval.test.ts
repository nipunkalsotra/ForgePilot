import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { terminalWireFixture } from './terminal-wire-fixture';
import { BatchStore } from '../src/batch';
import { Workspace } from '../src/workspace';

test('SDK + real MCP: approved failed command returns exit 7, retained correction gets separate staging and pending hunks', async () => {
  const f = await terminalWireFixture(); const workspace = await Workspace.create(f.root), store = new BatchStore(workspace);
  let terminalApprovals = 0, stagingApprovals = 0;
  try {
    await f.bridge.autonomous(store, 'correct using test feedback', () => {}, async patch => { stagingApprovals++; assert.match(patch.plan, /actual verification failure/); assert.equal(await readFile(path.join(f.root, 'wire.ts'), 'utf8'), f.content); return true; }, undefined, undefined,
      { approveCommand: async plan => { terminalApprovals++; assert.equal(plan.request.operation, 'npm_test'); return true; } });
    assert.equal(terminalApprovals, 1); assert.equal(stagingApprovals, 1);
    assert.ok(f.results.some(r => r.kind === 'forgepilot.command' && r.exitCode === 7 && r.stderr?.includes('expected assertion failure')));
    assert.equal(store.current?.generationSucceeded, true); assert.equal(store.current?.files[0]?.hunks[0]?.decision, 'pending');
    assert.throws(() => store.accepted(), /every hunk/); store.review('accepted'); assert.equal(store.accepted()[0]?.content, 'const value = 2;\n');
    assert.equal(await readFile(path.join(f.root, 'wire.ts'), 'utf8'), f.content, 'Terminal and staging do not apply edits');
    assert.equal(f.approvals.length, 2); assert.notEqual(f.approvals[0]?.callId, f.approvals[1]?.callId);
  } finally { workspace.dispose(); await f.close(); }
});
test('SDK terminal denial returns safe feedback and executes no MCP tools', async () => {
  const f = await terminalWireFixture('deny'); const workspace = await Workspace.create(f.root), store = new BatchStore(workspace);
  try {
    await f.bridge.autonomous(store, 'verification only', () => {}, async () => assert.fail('No staging'), undefined, undefined, { allowNoProposal: true, approveCommand: async () => false });
    assert.equal(f.approvals[0]?.status, 'deny'); assert.equal(f.results.length, 0); assert.equal(store.current, undefined); assert.equal(f.bridge.evidence.length, 1);
  } finally { workspace.dispose(); await f.close(); }
});
test('SDK provider failure after terminal refusal never triggers model fallback or execution', async () => {
  const f = await terminalWireFixture('deny-error'); const workspace = await Workspace.create(f.root), store = new BatchStore(workspace);
  try {
    await assert.rejects(f.bridge.autonomous(store, 'verify', () => {}, async () => true, undefined, undefined, { allowNoProposal: true, approveCommand: async () => false }), /rejected/);
    assert.equal(f.results.length, 0); assert.equal(f.bridge.evidence.length, 1); assert.equal(store.current, undefined);
  } finally { workspace.dispose(); await f.close(); }
});
test('SDK cancel while terminal approval pending ignores a delayed affirmative reply and stops without fallback', async () => {
  const f = await terminalWireFixture('hold'); const workspace = await Workspace.create(f.root), store = new BatchStore(workspace);
  let release!: (value: boolean) => void, waiting!: () => void; const arrived = new Promise<void>(resolve => { waiting = resolve; });
  try {
    const turn = f.bridge.autonomous(store, 'verify', () => {}, async () => true, undefined, undefined, { approveCommand: async () => { waiting(); return new Promise(resolve => { release = resolve; }); } });
    const rejected = assert.rejects(turn, /cancelled/); await arrived; await f.bridge.cancel(); release(true); await rejected;
    assert.equal(f.results.length, 0); assert.equal(f.approvals.length, 0); assert.equal(f.bridge.evidence.length, 1); assert.equal(store.current, undefined);
  } finally { workspace.dispose(); await f.close(); }
});
test('SDK fallback after terminal permission revokes the old grant and requires a fresh correlated approval', async () => {
  const f = await terminalWireFixture('fallback'); const workspace = await Workspace.create(f.root), store = new BatchStore(workspace);
  const callIds: string[] = [];
  try {
    await f.bridge.autonomous(store, 'verify then correct', () => {}, async () => true, undefined, undefined, { approveCommand: async (_, correlation) => { callIds.push(correlation.callId); return true; } });
    assert.equal(callIds.length, 2); assert.notEqual(callIds[0], callIds[1]); assert.equal(f.bridge.evidence.length, 2);
    assert.equal(f.results.filter(r => r.kind === 'forgepilot.command').length, 1); assert.equal(store.current?.files[0]?.hunks[0]?.decision, 'pending');
  } finally { workspace.dispose(); await f.close(); }
});
test('SDK terminal approval with the wrong source event is refused before developer approval or execution', async () => {
  const f = await terminalWireFixture('wrong-source'); const workspace = await Workspace.create(f.root), store = new BatchStore(workspace);
  try {
    await assert.rejects(f.bridge.autonomous(store, 'verify', () => {}, async () => true, undefined, undefined, { approveCommand: async () => assert.fail('Wrong source must not prompt') }), (error: unknown) => error instanceof Error && error.cause instanceof Error && /source event/.test(error.cause.message));
    assert.equal(f.results.length, 0); assert.equal(f.approvals.length, 0); assert.equal(store.current, undefined);
  } finally { workspace.dispose(); await f.close(); }
});
