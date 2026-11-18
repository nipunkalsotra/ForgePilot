import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BatchStore } from '../src/batch';
import { AUTONOMOUS_TOOLS } from '../src/mcp/autonomous';
import { Bridge } from '../src/bridge';
import { PatchStore, hash } from '../src/patch';
import { Workspace } from '../src/workspace';

/** Explicit SDK wire fixture. Live model evidence comes from verify-editing-live.ts. */
async function fixture(mode: 'valid' | 'malformed' | 'error' | 'delayed' | 'after-error' | 'incomplete' | 'missing-terminal' | 'late-terminal' | 'approval-error' | 'output-error' | 'question-only' | 'wrong-source-cache' | 'truncated-output' | 'changed-proposal', autonomous = false, retained = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'forgepilot-approval-'));
  const content = 'const value = 1;\n';
  await writeFile(path.join(root, 'file.ts'), content);
  const patch = { path: 'file.ts', baseHash: hash(content), edits: [{ oldText: '1', newText: '2' }] };
  const batchPatch = { plan: 'Update discovered code', files: [{ operation: 'modify', ...patch }] };
  const manifest: Record<string, unknown> = { model: { name: 'fixture/model' }, config: { sandbox: { enabled: false }, dynamic_sub_agents: { enabled: false }, web_search: { enabled: false }, memory: { enabled: false }, generative_ui: { enabled: false } } };
  const agent = { id: 'agent', name: 'forge-coder', manifest };
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  let held: ServerResponse | undefined;
  let toolExecuted = false;
  let executionReady!: () => void;
  const execution = new Promise<void>(resolve => { executionReady = resolve; });
  let connector = '';
  let requestId = ''; const draftId = crypto.randomUUID();
  const send = (event: object) => held?.write(`data: ${JSON.stringify({ created_at: new Date().toISOString(), thread_id: 'main', id: crypto.randomUUID(), ...event })}\n\n`);
  const done = () => {
    if (mode === 'missing-terminal') { held?.end(); return; }
    send({ type: 'turn.done', state: mode === 'after-error' ? { status: 'error', completed_at: new Date().toISOString(), message: 'fixture provider failure' } : { status: 'done', completed_at: new Date().toISOString(), output: mode === 'truncated-output' ? { type: 'model.message', id: 'final-output', created_at: new Date().toISOString(), thread_id: 'main', content: 'partial', finish_reason: 'length' } : null, required_actions: mode === 'incomplete' ? [{ type: 'tool.approval_required', id: 'pending', thread_id: 'main', created_at: '', tool_calls: [] }] : [] } });
    if (mode === 'late-terminal') send({ type: 'model.message.delta', content: 'late output' });
    held?.end();
  };
  const source = () => mode === 'question-only' ? { type: 'model.message', id: 'source', created_at: new Date().toISOString(), thread_id: 'main', tool_calls: [{ id: 'call', type: 'function', function: { name: 'ask_user_question', arguments: JSON.stringify({ question: 'Proceed with discovery?', options: ['Proceed'] }) }, tool_info: { type: 'truefoundry-system', name: 'ask_user_question' } }] } : ({ type: 'model.message', id: 'source', created_at: new Date().toISOString(), thread_id: 'main', content: null, tool_calls: [{ id: 'call', type: 'function', function: { name: autonomous ? 'call_tool' : 'propose_patch', arguments: JSON.stringify(mode === 'malformed' ? { bad: true } : autonomous ? { mcp_server: connector, tool_name: retained ? 'propose_drafts' : 'propose_batch', input: retained ? { plan: batchPatch.plan, draftIds: [draftId] } : batchPatch } : patch) }, tool_info: autonomous ? { type: 'truefoundry-system', name: 'call_tool' } : { type: 'mcp', name: 'propose_patch', server_id: connector, server_name: connector } }] });
  const http = createServer((req, res) => { void (async () => {
    const buffers = []; for await (const b of req) buffers.push(b);
    const body = JSON.parse(Buffer.concat(buffers).toString() || '{}') as Record<string, unknown>;
    const pathname = new URL(req.url!, 'http://localhost').pathname; requests.push({ path: pathname, body });
    const json = (value: unknown) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (pathname === '/api/v1/agents') return json({ data: [agent], pagination: { limit: 50 } });
    if (pathname === '/api/v1/agents/agent') { if (req.method === 'PUT') Object.assign(manifest, body.manifest); return json({ data: agent }); }
    if (pathname === '/api/v1/settings/mcp-servers') { connector = (body.manifest as { name: string }).name; return json({ data: body }); }
    if (pathname.startsWith('/api/v1/settings/mcp-servers/')) return json({});
    if (pathname.endsWith('/tools')) return json({ data: ['list_files', 'read_file', 'search_workspace', ...(autonomous ? AUTONOMOUS_TOOLS : ['propose_patch'])].map(name => ({ name })) });
    if (pathname === '/api/v1/sessions') return json({ data: { id: 'session', agent: { type: 'reference', name: 'forge-coder', id: 'agent' }, metadata: {}, metrics: {}, source: null } });
    if (pathname.endsWith('/cancel')) { held?.end(); return json({ data: {} }); }
    if (pathname.endsWith('/events') && req.method === 'GET') return json({ data: [{ turn_id: 'turn', event: source() }], pagination: { limit: 50 } });
    if (pathname.endsWith('/events') && req.method === 'POST') {
      json({ data: [] });
      const events = body.events as { type: string; approval?: { status: string } }[];
      if (events[0]?.type === 'user.tool_response') { done(); return; }
      if (events[0]?.approval?.status === 'allow') {
        toolExecuted = true; executionReady();
        if (mode === 'delayed') return;
        send({ type: 'tool.response', tool_call_id: 'call', content: JSON.stringify(autonomous ? { kind: 'forgepilot.batch', patch: mode === 'changed-proposal' ? { ...batchPatch, plan: 'tampered after permission' } : batchPatch } : { kind: 'forgepilot.patch', patch }) }); done();
      }
      return;
    }
    if (pathname.endsWith('/turns')) {
      held = res; res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      requestId = JSON.stringify(body).match(/requestId=([a-f0-9-]{36})/)?.[1] ?? '';
      if (retained) {
        send({ type: 'model.message', id: 'draft-source', tool_calls: [{ id: 'draft', type: 'function', function: { name: 'draft_file', arguments: JSON.stringify({ requestId, ...batchPatch.files[0] }) }, tool_info: { type: 'mcp', name: 'draft_file', server_id: connector, server_name: connector } }] });
        send({ type: 'tool.response', tool_call_id: 'draft', content: JSON.stringify({ kind: 'forgepilot.draft', valid: true, requestId, draftId, path: 'file.ts' }) });
      }
      send({ type: 'turn.created', turn_id: 'turn', previous_turn_id: null, state: { status: 'running' } });
      if (mode === 'output-error') send({ type: 'model.message.delta', content: 'apparently successful response' });
      if (mode === 'error' || mode === 'output-error') { send({ type: 'turn.done', state: { status: 'error', completed_at: new Date().toISOString(), message: 'fixture provider error' } }); res.end(); return; }
      if (mode === 'wrong-source-cache') send({ ...source(), id: 'wrong-cached-source' });
      // Deliberately omit model.message on SSE: exercise real 0.185.1 source-event lookup.
      send({ type: mode === 'question-only' ? 'tool.response_required' : 'tool.approval_required', tool_calls: [{ id: 'call', source_event_id: 'source' }] });
      if (mode === 'approval-error') send({ type: 'turn.done', state: { status: 'error', completed_at: '', message: 'failed during approval' } });
      return;
    }
    res.writeHead(404).end();
  })().catch(() => res.writeHead(500).end()); });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const address = http.address(); assert.ok(address && typeof address === 'object');
  const bridge = new Bridge({ baseUrl: `http://127.0.0.1:${address.port}`, agentName: 'forge-coder', root, proposals: !autonomous, autonomous, childPath: path.resolve('dist/mcp-child.cjs'), log: () => {} });
  const store = new PatchStore(await Workspace.create(root), { path: 'file.ts', content, version: 1, start: 0, end: content.length });
  return { bridge, store, batchStore: new BatchStore(store.workspace), requests, execution, executed: () => toolExecuted, unchanged: async () => assert.equal(await readFile(path.join(root, 'file.ts'), 'utf8'), content),
    late: () => { send({ type: 'tool.response', tool_call_id: 'call', content: JSON.stringify(autonomous ? { kind: 'forgepilot.batch', patch: mode === 'changed-proposal' ? { ...batchPatch, plan: 'tampered after permission' } : batchPatch } : { kind: 'forgepilot.patch', patch }) }); done(); },
    async close() { await bridge.stop(); await new Promise<void>(resolve => { http.close(() => resolve()); http.closeAllConnections(); }); await rm(root, { recursive: true, force: true }); } };
}
test('SDK approval: exact persisted source, genuine approval input then staging; hunk review is separate', async () => {
  const f = await fixture('valid'); try {
    await f.bridge.start();
    let approved = false;
    await f.bridge.propose(f.store, 'change', () => {}, async () => { assert.equal(f.executed(), false); await f.unchanged(); approved = true; return true; });
    assert.equal(approved, true); assert.equal(f.executed(), true); assert.equal(f.store.current!.status, 'staged');
    assert.equal(f.store.current!.hunks[0]!.decision, 'pending'); await f.unchanged();
    assert.ok(f.requests.some(r => r.path.endsWith('/events') && Array.isArray(r.body.events)));
  } finally { await f.close(); }
});
test('retained draft SDK protocol requires exact approval, terminal success and an unchanged final payload', async () => {
  for (const mode of ['valid', 'after-error', 'changed-proposal'] as const) {
    const f = await fixture(mode, true, true); try {
      await f.bridge.start(); let approved = 0;
      const turn = f.bridge.autonomous(f.batchStore, 'generic change', () => {}, async batch => { approved++; assert.equal(batch.files.length, 1); await f.unchanged(); return true; });
      if (mode === 'valid') { await turn; assert.equal(f.batchStore.current?.generationSucceeded, true); assert.equal(f.batchStore.current?.files[0]?.hunks[0]?.decision, 'pending'); }
      else { await assert.rejects(turn); assert.notEqual(f.batchStore.current?.status, 'staged'); }
      assert.equal(approved, 1); await f.unchanged();
    } finally { await f.close(); }
  }
  const f = await fixture('valid', true, true); try {
    await f.bridge.start(); await assert.rejects(f.bridge.autonomous(f.batchStore, 'change', () => {}, async () => false), /rejected/);
    assert.equal(f.executed(), false); assert.equal(f.batchStore.current, undefined); await f.unchanged();
  } finally { await f.close(); }
});
test('cancellation during draft IPC setup prevents inference and rejects overlapping turns', async () => {
  const f = await fixture('valid', true, true); try {
    await f.bridge.start();
    const control = f.bridge.companion.setDraftRequest.bind(f.bridge.companion);
    let arrived!: () => void, release!: () => void;
    const waiting = new Promise<void>(resolve => { arrived = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    f.bridge.companion.setDraftRequest = async id => { if (id) { arrived(); await held; } await control(id); };
    const turn = f.bridge.autonomous(f.batchStore, 'change', () => {}, async () => assert.fail('No approval before generation'));
    const rejected = assert.rejects(turn, /cancelled before generation/);
    await waiting;
    await assert.rejects(f.bridge.autonomous(f.batchStore, 'overlap', () => {}, async () => true), /already running/);
    await assert.rejects(f.bridge.ask('overlap', () => {}), /already running/);
    await f.bridge.cancel(); release(); await rejected;
    assert.equal(f.requests.some(r => r.path.endsWith('/turns')), false);
    assert.equal(f.batchStore.current, undefined); await f.unchanged();
  } finally { await f.close(); }
});
test('SDK approval: rejection submits deny and never executes tool or stages', async () => {
  const f = await fixture('valid'); try {
    await f.bridge.start(); await assert.rejects(f.bridge.propose(f.store, 'change', () => {}, async () => false), /rejected/);
    assert.equal(f.executed(), false); assert.equal(f.store.current, undefined); await f.unchanged();
    assert.ok(f.requests.some(r => JSON.stringify(r.body).includes('"status":"deny"')));
  } finally { await f.close(); }
});
test('SDK approval: malformed model tool arguments and model errors preserve original', async () => {
  for (const mode of ['malformed', 'error'] as const) {
    const f = await fixture(mode); try {
      await f.bridge.start(); await assert.rejects(f.bridge.propose(f.store, 'change', () => {}, async () => { assert.fail('approval must not be requested'); }));
      assert.equal(f.store.current, undefined); assert.equal(f.executed(), false); await f.unchanged();
    } finally { await f.close(); }
  }
});
test('SDK approval: cancel waiting for human approval ignores delayed human answer', async () => {
  const f = await fixture('valid'); try {
    await f.bridge.start(); let answer!: (value: boolean) => void; let waiting!: () => void;
    const arrived = new Promise<void>(resolve => { waiting = resolve; });
    const turn = f.bridge.propose(f.store, 'change', () => {}, async () => { waiting(); return new Promise(resolve => { answer = resolve; }); });
    const rejected = assert.rejects(turn, /cancelled/); await arrived; await f.bridge.cancel(); answer(true); await rejected;
    assert.equal(f.executed(), false); assert.equal(f.store.current, undefined); await f.unchanged();
  } finally { await f.close(); }
});
test('SDK approval: cancel after allow ignores delayed tool result', async () => {
  const f = await fixture('delayed'); try {
    await f.bridge.start(); let waiting!: () => void;
    const arrived = new Promise<void>(resolve => { waiting = resolve; });
    const turn = f.bridge.propose(f.store, 'change', () => {}, async () => { waiting(); return true; });
    const rejected = assert.rejects(turn, /cancelled/); await arrived; await f.execution; assert.equal(f.executed(), true); await f.bridge.cancel(); f.late(); await rejected;
    assert.equal(f.store.current, undefined); await f.unchanged();
  } finally { await f.close(); }
});

test('unsuccessful completion after staged patch always invalidates proposal', async () => {
  for (const mode of ['after-error', 'incomplete', 'missing-terminal', 'late-terminal', 'truncated-output'] as const) {
    const f = await fixture(mode); try {
      await f.bridge.start();
      await assert.rejects(f.bridge.propose(f.store, 'change', () => {}, async () => true), /failed|complet|terminal/);
      assert.equal(f.store.current?.status, 'cancelled');
      assert.throws(() => f.store.accepted(f.store.current!.id));
      await f.unchanged(); f.late(); assert.equal(f.store.current?.status, 'cancelled');
      assert.ok(f.requests.some(r => r.path.endsWith('/cancel')));
    } finally { await f.close(); }
  }
});

test('failure during approval or after model output cannot become a proposal', async () => {
  for (const mode of ['approval-error', 'output-error'] as const) {
    const f = await fixture(mode); try {
      await f.bridge.start(); await assert.rejects(f.bridge.propose(f.store, 'change', () => {}, async () => true), /failed/);
      assert.equal(f.store.current, undefined); await f.unchanged();
    } finally { await f.close(); }
  }
});

test('autonomous SDK contract correlates deferred batch approval and terminal success', async () => {
  const f = await fixture('valid', true); try {
    await f.bridge.start(); const responseBytes: number[] = [];
    await f.bridge.autonomous(f.batchStore, 'Update the implementation', () => {}, async () => true, event => responseBytes.push(event.responseBytes));
    assert.ok(responseBytes.length === 1 && responseBytes[0]! > 0);
    assert.equal(f.batchStore.current!.generationSucceeded, true); assert.equal(f.batchStore.current!.files.length, 1);
    assert.equal(f.batchStore.current!.files[0]!.hunks[0]!.decision, 'pending'); await f.unchanged();
  } finally { await f.close(); }
});
test('autonomous generation failure and rejected approval cannot leave an applicable batch', async () => {
  for (const mode of ['after-error', 'valid'] as const) {
    const f = await fixture(mode, true); try {
      await f.bridge.start(); await assert.rejects(f.bridge.autonomous(f.batchStore, 'change', () => {}, async () => mode !== 'valid'));
      assert.throws(() => f.batchStore.accepted()); await f.unchanged();
    } finally { await f.close(); }
  }
});
test('autonomous cancellation after allow ignores delayed batch tool results', async () => {
  const f = await fixture('delayed', true); try {
    await f.bridge.start();
    const turn = f.bridge.autonomous(f.batchStore, 'change', () => {}, async () => true);
    const rejected = assert.rejects(turn, /cancelled/); await f.execution; await f.bridge.cancel(); f.late(); await rejected;
    assert.throws(() => f.batchStore.complete()); assert.equal(f.batchStore.current, undefined); await f.unchanged();
  } finally { await f.close(); }
});

test('answering a genuine SDK question never grants batch staging or hunk approval', async () => {
  const f = await fixture('question-only', true); try {
    await f.bridge.start();
    await assert.rejects(f.bridge.autonomous(f.batchStore, 'change', () => {}, async () => { assert.fail('No staging approval should occur'); }, () => {}, async () => 'Proceed'), /No successful batch/);
    assert.equal(f.batchStore.current, undefined); await f.unchanged();
    assert.ok(f.requests.some(r => JSON.stringify(r.body).includes('user.tool_response')));
    assert.ok(!f.requests.some(r => JSON.stringify(r.body).includes('"status":"allow"')));
  } finally { await f.close(); }
});

test('approval source-event mismatch is rejected before any human approval or staging', async () => {
  for (const autonomous of [false, true]) {
    const f = await fixture('wrong-source-cache', autonomous); try {
      await f.bridge.start();
      const approve = async () => { assert.fail('Mismatched source must not reach human approval'); };
      await assert.rejects(autonomous ? f.bridge.autonomous(f.batchStore, 'change', () => {}, approve) : f.bridge.propose(f.store, 'change', () => {}, approve), /source event does not match/);
      assert.equal(f.executed(), false); assert.equal(f.store.current, undefined); assert.equal(f.batchStore.current, undefined); await f.unchanged();
    } finally { await f.close(); }
  }
});

test('autonomous cancellation while human approval is pending ignores a delayed allow', async () => {
  const f = await fixture('valid', true); try {
    await f.bridge.start(); let arrived!: () => void, release!: (allow: boolean) => void;
    const waiting = new Promise<void>(resolve => { arrived = resolve; });
    const turn = f.bridge.autonomous(f.batchStore, 'change', () => {}, async () => { arrived(); return new Promise<boolean>(resolve => { release = resolve; }); });
    const rejected = assert.rejects(turn, /cancelled/); await waiting; await f.bridge.cancel(); release(true); await rejected;
    assert.equal(f.executed(), false); assert.equal(f.batchStore.current, undefined); await f.unchanged();
    assert.ok(!f.requests.some(r => JSON.stringify(r.body).includes('"status":"allow"')));
  } finally { await f.close(); }
});
