import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import path from 'node:path';
import { Bridge } from '../src/bridge';

/** SDK wire-contract fixture, deliberately not evidence of model or TrueForge execution. */
async function fixture(mode: 'stream' | 'register-failure' | 'hold' | 'unsafe') {
  const manifest: Record<string, unknown> = { model: { name: 'fixture/model' }, config: {
    sandbox: { enabled: mode === 'unsafe' }, dynamic_sub_agents: { enabled: false }, web_search: { enabled: false }, memory: { enabled: false }, generative_ui: { enabled: false },
  } };
  const agent = { id: 'agent-1', name: 'forge-coder', description: 'fixture', manifest, created_by_subject: { subject_id: 'test', subject_type: 'user', subject_display_name: 'test' } };
  const requests: { method: string; path: string; body: Record<string, unknown> }[] = [];
  let held: ServerResponse | undefined;
  const http = createServer((req, res) => {
    void (async () => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const text = Buffer.concat(chunks).toString();
      const body = text ? JSON.parse(text) as Record<string, unknown> : {};
      const url = new URL(req.url!, 'http://localhost');
      const method = req.method!;
      requests.push({ method, path: url.pathname, body });
      const json = (data: unknown, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (url.pathname === '/api/v1/agents') return json({ data: [agent], pagination: { limit: 50 } });
      if (url.pathname === '/api/v1/agents/agent-1') {
        if (method === 'PUT') Object.assign(manifest, body.manifest);
        return json({ data: agent });
      }
      if (url.pathname === '/api/v1/settings/mcp-servers' && method === 'POST') {
        return mode === 'register-failure' ? json({ error: { message: 'Outbound URL blocked for host "127.0.0.1"' } }, 400) : json({ data: body });
      }
      if (url.pathname.startsWith('/api/v1/settings/mcp-servers/') && method === 'DELETE') { if (mode === 'register-failure') json({ error: { message: 'not found' } }, 404); else json({}); return; }
      if (url.pathname.endsWith('/tools')) return json({ data: ['list_files', 'read_file', 'search_workspace'].map(name => ({ name })) });
      if (url.pathname === '/api/v1/sessions') return json({ data: { id: 'session-1', agent: { type: 'reference', name: 'forge-coder', id: agent.id }, metadata: {}, metrics: { total_turns: 0, total_duration_ms: 0 }, source: null } });
      if (url.pathname.endsWith('/cancel')) { held?.end(); return json({ data: {} }); }
      if (url.pathname.endsWith('/turns') && method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const send = (event: object) => res.write(`data: ${JSON.stringify(event)}\n\n`);
        send({ type: 'model.message.delta', id: 'event-1', thread_id: 'main', content: 'wire-stream' });
        if (mode === 'hold') { held = res; return; }
        send({ type: 'turn.done', id: 'event-2', created_at: new Date().toISOString(), thread_id: null, state: { status: 'done', completed_at: new Date().toISOString(), output: null, required_actions: [] } });
        res.end(); return;
      }
      json({ error: { message: 'unexpected route' } }, 404);
    })().catch(() => { res.writeHead(500).end(); });
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  assert.ok(address && typeof address === 'object');
  const bridge = new Bridge({ baseUrl: `http://127.0.0.1:${address.port}`, agentName: 'forge-coder', root: process.cwd(), childPath: path.resolve('dist/mcp-child.cjs'), log: () => {} });
  return { bridge, requests, manifest, async close() { try { await bridge.stop(); } finally { await new Promise<void>(resolve => { http.close(() => resolve()); http.closeAllConnections(); }); } } };
}

test('SDK contract: named session, real SSE consumption and removal of only owned registration', async () => {
  const f = await fixture('stream');
  try {
    assert.equal(await f.bridge.start(), 'session-1');
    let output = '';
    await f.bridge.ask('inspect fixture', text => { output += text; });
    assert.match(output, /^wire-stream/);
    const create = f.requests.find(r => r.path === '/api/v1/sessions');
    assert.deepEqual(create?.body.agent, { name: 'forge-coder' });
    f.manifest.instructions = 'concurrent unrelated edit';
    await f.bridge.stop();
    assert.deepEqual(f.manifest.mcp_servers, []);
    assert.equal(f.manifest.instructions, 'concurrent unrelated edit');
    assert.equal(f.requests.filter(r => r.path.endsWith('/turns') && r.method === 'POST').length, 1);
  } finally { await f.close(); }
});

test('SDK contract: failed registration preserves the original actionable error and stops companion', async () => {
  const f = await fixture('register-failure');
  try {
    await assert.rejects(f.bridge.start(), error => typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 400);
    assert.equal(f.bridge.companion.url, undefined);
    assert.ok(!f.requests.some(r => r.path === '/api/v1/sessions'));
  } finally { await f.close(); }
});

test('SDK contract: unsafe agent rejected before any MCP process or agent mutation', async () => {
  const f = await fixture('unsafe');
  try {
    await assert.rejects(f.bridge.start(), /dedicated agent/);
    assert.equal(f.bridge.companion.pid, undefined);
    assert.ok(!f.requests.some(r => r.method !== 'GET'));
  } finally { await f.close(); }
});

test('SDK contract: cancellation stops backend and stream; overlapping turns rejected', async () => {
  const f = await fixture('hold');
  try {
    await f.bridge.start();
    let firstDelta!: () => void;
    const received = new Promise<void>(resolve => { firstDelta = resolve; });
    const turn = f.bridge.ask('hold', () => firstDelta());
    const rejected = assert.rejects(turn, /cancelled/);
    await received;
    await assert.rejects(f.bridge.ask('overlap', () => {}), /already running/);
    await f.bridge.cancel();
    await rejected;
    assert.ok(f.requests.some(r => r.path.endsWith('/cancel')));
  } finally { await f.close(); }
});
