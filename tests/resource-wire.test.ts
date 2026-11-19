import { test } from 'node:test';
import assert from 'node:assert/strict';
import { terminalWireFixture } from './terminal-wire-fixture';
import { ResilientBridge } from '../src/resilience';
import { BatchStore } from '../src/batch';
import { Workspace } from '../src/workspace';

test('real SDK/companion over-budget request never starts inference, revokes authority and never selects fallback', async () => {
  const f = await terminalWireFixture();
  const bridge = new ResilientBridge({ ...f.options, budgetConfig: { mode: 'strict', taskTokens: 2000 } }, { enabled: true, agentName: 'secondary' });
  const workspace = await Workspace.create(f.root), store = new BatchStore(workspace);
  const usage: { estimatedTokens: number; providerQuota: string }[] = [];
  try {
    await assert.rejects(bridge.autonomous(store, 'Inspect the task. '.repeat(600), () => {}, async () => true, undefined, undefined,
      { approveCommand: async () => true, usage: value => usage.push(value) }), error => !!error && typeof error === 'object' && 'kind' in error && error.kind === 'budget');
    assert.equal(bridge.evidence.length, 1); assert.equal(bridge.evidence[0]?.failure, 'budget');
    assert.ok(usage.some(v => v.estimatedTokens >= 2000)); assert.ok(usage.every(v => v.providerQuota === 'UNKNOWN'));
    assert.equal(f.results.length, 0); assert.equal(f.approvals.length, 0); assert.equal(store.current, undefined); assert.ok(f.approvals.every(a => a.callId.startsWith('command-')));
  } finally { await bridge.stop(); workspace.dispose(); await f.close(); }
});

test('real SDK snapshots apply only matching enabled profile limits without mutating saved manifests', async () => {
  const f = await terminalWireFixture();
  try {
    for (const [mode, model, expectedOutput, expectedCompaction] of [
      ['conservative', 'fixture/model', 512, 4000], ['off', 'fixture/model', undefined, 64000], ['conservative', 'other/model', undefined, 64000],
    ] as const) {
      const bridge = new ResilientBridge({ ...f.options, budgetConfig: { mode, provider: { model, contextWindow: 8000, maxOutputTokens: 512 } } }, { enabled: false, agentName: '' });
      try {
        const id = await bridge.start(); const spec = f.sessions.get(id)!.spec;
        const actualModel = spec.model as { params?: { max_tokens?: number } };
        const config = spec.config as { context_management?: { compaction?: { trigger?: { value?: number } } } };
        assert.equal(actualModel.params?.max_tokens, expectedOutput);
        assert.equal(config.context_management?.compaction?.trigger?.value, expectedCompaction);
        const client = new (await import('@truefoundry/trueforge-sdk')).TrueForge({ baseUrl: f.options.baseUrl });
        const saved = (await client.agents.get('primary')).data.manifest;
        assert.equal(saved.model.params?.maxTokens, undefined);
      } finally { await bridge.stop(); }
    }
  } finally { await f.close(); }
});
