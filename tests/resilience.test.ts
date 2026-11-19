import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResilientBridge } from '../src/resilience';
import { PatchStore } from '../src/patch';
import { Workspace } from '../src/workspace';
import { resilienceFixture } from './resilience-fixture';

async function store(f: Awaited<ReturnType<typeof resilienceFixture>>) { return new PatchStore(await Workspace.create(f.root), { path: 'resilience.ts', content: f.content, version: 1, start: 0, end: f.content.length }); }

test('SDK fallback uses fresh inline sessions, owned connectors and fresh approvals after staged failure', async () => {
  const f = await resilienceFixture('staged-error'); try {
    let approvals = 0; const target = await store(f);
    await f.bridge.propose(target, 'change value', () => {}, async () => { approvals++; assert.equal(await f.unchanged(), true); return true; });
    assert.equal(approvals, 2); assert.equal(f.sessions.size, 2); assert.equal(f.notifications.length, 1);
    assert.equal(target.current?.hunks[0]?.decision, 'pending'); assert.equal(target.current?.status, 'staged'); assert.equal(await f.unchanged(), true);
    const traces = f.bridge.evidence; assert.equal(traces[0]?.failure, 'provider_unavailable'); assert.equal(traces[1]?.outcome, 'succeeded');
    const creates = f.requests.filter(r => r.path === '/api/v1/sessions');
    const [a, b] = creates.map(r => (r.body.agent as { spec: { mcp_servers: { name: string }[] } }).spec.mcp_servers[0]!.name);
    assert.notEqual(a, b); assert.ok(!f.connectors.has(a!)); assert.ok(f.connectors.has(b!));
    assert.equal(f.requests.some(r => r.method === 'PUT' && r.path.startsWith('/api/v1/agents')), false);
    await f.bridge.stop(); assert.equal(f.connectors.size, 0);
  } finally { await f.close(); }
});
test('both providers fail once, then the next manual command succeeds without restart', async () => {
  const f = await resilienceFixture('401', '503'); try {
    const target = await store(f); await assert.rejects(f.bridge.propose(target, 'change', () => {}, async () => true), /unavailable/);
    assert.equal(f.sessions.size, 2); assert.equal(f.bridge.evidence.length, 2); assert.equal(f.connectors.size, 0); assert.equal(target.current, undefined); assert.equal(await f.unchanged(), true);
    f.setMode('valid');
    await f.bridge.ask('inspect again', () => {}); assert.equal(f.bridge.evidence.length, 1); assert.equal(f.bridge.evidence[0]?.outcome, 'succeeded');
  } finally { await f.close(); }
  const good = await resilienceFixture('malformed'); try {
    await assert.rejects(good.bridge.propose(await store(good), 'change', () => {}, async () => assert.fail('invalid proposal')));
    assert.equal(good.sessions.size, 1); good.setMode('valid');
    await good.bridge.ask('inspect', () => {}); assert.equal(good.bridge.evidence.at(-1)?.outcome, 'succeeded');
  } finally { await good.close(); }
});
test('approval denial and malformed model patches never fallback', async () => {
  for (const mode of ['valid', 'malformed'] as const) {
    const f = await resilienceFixture(mode); try {
      await assert.rejects(f.bridge.propose(await store(f), 'change', () => {}, async () => false));
      assert.equal(f.sessions.size, 1); assert.equal(f.notifications.length, 0); assert.equal(f.connectors.size, 0); assert.equal(await f.unchanged(), true);
    } finally { await f.close(); }
  }
});
test('cancel during primary stream, fallback preparation and approval prevents delayed activation', async () => {
  const f = await resilienceFixture('hold'); try {
    const turn = f.bridge.ask('wait', () => {}); const rejected = assert.rejects(turn, /cancelled/);
    await f.started; await f.bridge.cancel(); await rejected; assert.equal(f.sessions.size, 1); assert.equal(f.connectors.size, 0);
  } finally { await f.close(); }
  const g = await resilienceFixture('401'); try {
    const bridge = new ResilientBridge(g.options, { enabled: true, agentName: 'secondary', notify: () => { void bridge.cancel(); } });
    await assert.rejects(bridge.ask('change', () => {}), /cancelled/); assert.equal(g.sessions.size, 1); await bridge.stop();
  } finally { await g.close(); }
  const h = await resilienceFixture('valid'); try {
    let release!: (allow: boolean) => void; let arrived!: () => void;
    const waiting = new Promise<void>(resolve => { arrived = resolve; });
    const target = await store(h); const turn = h.bridge.propose(target, 'change', () => {}, async () => { arrived(); return new Promise<boolean>(resolve => { release = resolve; }); });
    const rejected = assert.rejects(turn, /cancelled/); await waiting; await h.bridge.cancel(); release(true); await rejected;
    assert.equal(h.sessions.size, 1); assert.equal(h.connectors.size, 0); assert.equal(target.current, undefined); assert.equal(await h.unchanged(), true);
  } finally { await h.close(); }
});
test('fallback must be explicitly configured, distinct and existing', async () => {
  const f = await resilienceFixture('401'); try {
    for (const name of ['', 'primary']) assert.throws(() => new ResilientBridge(f.options, { enabled: true, agentName: name }), /distinct/);
    const disabled = new ResilientBridge(f.options, { enabled: false, agentName: '' });
    await assert.rejects(disabled.ask('inspect', () => {}), /401/); assert.equal(disabled.evidence.length, 1); await disabled.stop();
    const missing = new ResilientBridge(f.options, { enabled: true, agentName: 'absent' });
    await assert.rejects(missing.ask('inspect', () => {}), /configuration/); assert.equal(missing.evidence.length, 2); await missing.stop();
  } finally { await f.close(); }
});

test('autonomous fallback never adopts failed generation files or approvals', async () => {
  const { BatchStore } = await import('../src/batch');
  const f = await resilienceFixture('staged-error', 'valid', undefined, true); try {
    const target = new BatchStore(await Workspace.create(f.root)); let approvals = 0;
    await f.bridge.autonomous(target, 'update discovered value', () => {}, async () => { approvals++; return true; });
    assert.equal(approvals, 2); assert.equal(target.current?.generationSucceeded, true);
    assert.equal(target.current?.files[0]?.hunks[0]?.decision, 'pending'); assert.equal(f.sessions.size, 2); assert.equal(await f.unchanged(), true);
    target.review('rejected'); assert.throws(() => target.accepted());
  } finally { await f.close(); }
});

test('cancellation during fallback initialization and secondary streaming cleans both sessions', async () => {
  const { Bridge } = await import('../src/bridge');
  const f = await resilienceFixture('401', 'hold'); try {
    let reached!: () => void; const ready = new Promise<void>(resolve => { reached = resolve; });
    const bridge = new ResilientBridge(f.options, { enabled: true, agentName: 'secondary' }, options => {
      const candidate = new Bridge(options);
      if (options.agentName === 'secondary') {
        const start = candidate.start.bind(candidate);
        candidate.start = async () => { const promise = start(); reached(); return promise; };
      }
      return candidate;
    });
    const turn = bridge.ask('inspect', () => {}); const rejected = assert.rejects(turn, /cancelled/);
    await ready; await bridge.cancel(); await rejected; await bridge.stop(); assert.equal(f.connectors.size, 0); assert.equal(await f.unchanged(), true);
  } finally { await f.close(); }
  const g = await resilienceFixture('401', 'hold'); try {
    let received!: () => void; const ready = new Promise<void>(resolve => { received = resolve; });
    const turn = g.bridge.ask('inspect', () => { received(); }); const rejected = assert.rejects(turn, /cancelled/);
    await ready; await g.bridge.cancel(); await rejected; assert.equal(g.sessions.size, 2); assert.equal(g.connectors.size, 0); assert.equal(await g.unchanged(), true);
  } finally { await g.close(); }
});

test('external edits during fallback approval remain intact and cannot become a proposal', async () => {
  const { writeFile, readFile } = await import('node:fs/promises');
  const f = await resilienceFixture('401', 'valid'); try {
    const target = await store(f), changed = '// unrelated developer change\n' + f.content;
    await assert.rejects(f.bridge.propose(target, 'change', () => {}, async () => {
      await writeFile(`${f.root}/resilience.ts`, changed); return true;
    }), /changed|conflict/);
    assert.equal(target.current, undefined); assert.equal(f.bridge.evidence.length, 2);
    assert.equal(await readFile(`${f.root}/resilience.ts`, 'utf8'), changed); assert.equal(f.connectors.size, 0);
  } finally { await f.close(); }
});

test('a failed SDK denial submission never changes user rejection into fallback', async () => {
  const { RequestFailure } = await import('../src/failure');
  const f = await resilienceFixture('denial-503'); try {
    const target = await store(f);
    await assert.rejects(f.bridge.propose(target, 'change', () => {}, async () => false), error => {
      assert.ok(error instanceof RequestFailure); assert.equal(error.kind, 'approval_denied'); assert.equal(error.fallbackEligible, false); return true;
    });
    assert.equal(f.sessions.size, 1); assert.equal(f.notifications.length, 0); assert.equal(target.current, undefined); assert.equal(f.connectors.size, 0); assert.equal(await f.unchanged(), true);
  } finally { await f.close(); }
});
