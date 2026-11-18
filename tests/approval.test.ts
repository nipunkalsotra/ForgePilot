import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Bridge } from '../src/bridge';
import { PatchStore, hash } from '../src/patch';
import { Workspace } from '../src/workspace';

/** Explicit SDK wire fixture. Live model evidence comes from verify-editing-live.ts. */
async function fixture(mode: 'valid' | 'malformed' | 'error' | 'delayed') {
  const root = await mkdtemp(path.join(tmpdir(), 'forgepilot-approval-'));
  const content = 'const value = 1;\n';
  await writeFile(path.join(root, 'file.ts'), content);
  const patch = { path: 'file.ts', baseHash: hash(content), edits: [{ oldText: '1', newText: '2' }] };
  const manifest: Record<string, unknown> = { model: { name: 'fixture/model' }, config: { sandbox: { enabled: false }, dynamic_sub_agents: { enabled: false }, web_search: { enabled: false }, memory: { enabled: false }, generative_ui: { enabled: false } } };
  const agent = { id: 'agent', name: 'forge-coder', manifest };
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  let held: ServerResponse | undefined;
  let toolExecuted = false;
  let executionReady!: () => void;
  const execution = new Promise<void>(resolve => { executionReady = resolve; });
  let connector = '';
  const send = (event: object) => held?.write(`data: ${JSON.stringify({ created_at: new Date().toISOString(), thread_id: 'main', id: crypto.randomUUID(), ...event })}\n\n`);
  const done = () => { send({ type: 'turn.done', state: { status: 'done', completed_at: new Date().toISOString(), output: null, required_actions: [] } }); held?.end(); };
  const source = () => ({ type: 'model.message', id: 'source', created_at: new Date().toISOString(), thread_id: 'main', content: null, tool_calls: [{ id: 'call', type: 'function', function: { name: 'propose_patch', arguments: JSON.stringify(mode === 'malformed' ? { bad: true } : patch) }, tool_info: { type: 'mcp', name: 'propose_patch', server_id: connector, server_name: connector } }] });
  const http = createServer((req, res) => { void (async () => {
    const buffers = []; for await (const b of req) buffers.push(b);
    const body = JSON.parse(Buffer.concat(buffers).toString() || '{}') as Record<string, unknown>;
    const pathname = new URL(req.url!, 'http://localhost').pathname; requests.push({ path: pathname, body });
    const json = (value: unknown) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (pathname === '/api/v1/agents') return json({ data: [agent], pagination: { limit: 50 } });
    if (pathname === '/api/v1/agents/agent') { if (req.method === 'PUT') Object.assign(manifest, body.manifest); return json({ data: agent }); }
    if (pathname === '/api/v1/settings/mcp-servers') { connector = (body.manifest as { name: string }).name; return json({ data: body }); }
    if (pathname.startsWith('/api/v1/settings/mcp-servers/')) return json({});
    if (pathname.endsWith('/tools')) return json({ data: ['list_files', 'read_file', 'search_workspace', 'propose_patch'].map(name => ({ name })) });
    if (pathname === '/api/v1/sessions') return json({ data: { id: 'session', agent: { type: 'reference', name: 'forge-coder', id: 'agent' }, metadata: {}, metrics: {}, source: null } });
    if (pathname.endsWith('/cancel')) { held?.end(); return json({ data: {} }); }
    if (pathname.endsWith('/events') && req.method === 'GET') return json({ data: [{ turn_id: 'turn', event: source() }], pagination: { limit: 50 } });
    if (pathname.endsWith('/events') && req.method === 'POST') {
      json({ data: [] });
      const events = body.events as { approval: { status: string } }[];
      if (events[0]?.approval.status === 'allow') {
        toolExecuted = true; executionReady();
        if (mode === 'delayed') return;
        send({ type: 'tool.response', tool_call_id: 'call', content: JSON.stringify({ kind: 'forgepilot.patch', patch }) }); done();
      }
      return;
    }
    if (pathname.endsWith('/turns')) {
      held = res; res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      send({ type: 'turn.created', turn_id: 'turn', previous_turn_id: null, state: { status: 'running' } });
      if (mode === 'error') { send({ type: 'turn.done', state: { status: 'error' } }); res.end(); return; }
      // Deliberately omit model.message on SSE: exercise real 0.185.1 source-event lookup.
      send({ type: 'tool.approval_required', tool_calls: [{ id: 'call', source_event_id: 'source' }] }); return;
    }
    res.writeHead(404).end();
  })().catch(() => res.writeHead(500).end()); });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const address = http.address(); assert.ok(address && typeof address === 'object');
  const bridge = new Bridge({ baseUrl: `http://127.0.0.1:${address.port}`, agentName: 'forge-coder', root, proposals: true, childPath: path.resolve('dist/mcp-child.cjs'), log: () => {} });
  const store = new PatchStore(await Workspace.create(root), { path: 'file.ts', content, version: 1, start: 0, end: content.length });
  return { bridge, store, requests, execution, executed: () => toolExecuted, unchanged: async () => assert.equal(await readFile(path.join(root, 'file.ts'), 'utf8'), content),
    late: () => { send({ type: 'tool.response', tool_call_id: 'call', content: JSON.stringify({ kind: 'forgepilot.patch', patch }) }); done(); },
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
