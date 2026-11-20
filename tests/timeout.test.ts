import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResilientBridge } from '../src/resilience';
import { RequestFailure } from '../src/failure';
import { PatchStore } from '../src/patch';
import { Workspace } from '../src/workspace';
import { resilienceFixture } from './resilience-fixture';

test('approval-wait deadline is a local timeout and never falls back or submits a delayed allow', async () => {
  const f = await resilienceFixture('valid');
  const bridge = new ResilientBridge({ ...f.options, turnTimeoutSeconds: 10 }, { enabled: true, agentName: 'secondary' });
  let release!: (allow: boolean) => void;
  try {
    const target = new PatchStore(await Workspace.create(f.root), { path: 'resilience.ts', content: f.content, version: 1, start: 0, end: f.content.length });
    await assert.rejects(bridge.propose(target, 'change', () => {}, async () => new Promise<boolean>(resolve => { release = resolve; })), error => {
      assert.ok(error instanceof RequestFailure); assert.equal(error.kind, 'timeout'); assert.equal(error.fallbackEligible, false); return true;
    });
    release(true); assert.equal(f.sessions.size, 1); assert.equal(f.connectors.size, 0); assert.equal(await f.unchanged(), true);
    assert.equal(f.requests.some(r => r.method === 'POST' && r.path.endsWith('/events')), false);
    assert.equal(target.current, undefined);
  } finally { await bridge.stop(); await f.close(); }
});
