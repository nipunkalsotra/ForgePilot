import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ResilientBridge } from '../src/resilience';
import { hash } from '../src/patch';

/** Deterministic SDK-wire harness + REAL companion MCP and sandbox processes. No model inference. */
export async function terminalWireFixture(mode: 'correct' | 'deny' | 'deny-error' | 'hold' | 'fallback' | 'wrong-source' = 'correct', rootOverride?: string) {
  const root = rootOverride ?? await mkdtemp(path.join(tmpdir(), 'forgepilot-terminal-wire-'));
  const content = 'const value = 1;\n'; await writeFile(path.join(root, 'wire.ts'), content);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node failure.cjs' } }));
  await writeFile(path.join(root, 'failure.cjs'), 'console.error("expected assertion failure"); process.exitCode=7;');
  const manifests = new Map<string, { name: string; url: string; auth: { headers: { Authorization: string } } }>();
  const sessions = new Map<string, { spec: Record<string, unknown>; res?: ServerResponse; step: number; client: Client; calls: number; primary: boolean }>();
  const approvals: { status: string; callId: string; sessionId: string }[] = [];
  const results: { kind?: string; exitCode?: number; stderr?: string }[] = [];
  let started!: () => void; const commandRequested = new Promise<void>(resolve => { started = resolve; });
  const manifest = { model: { name: 'fixture/model' }, config: { sandbox: { enabled: false }, dynamic_sub_agents: { enabled: false }, web_search: { enabled: false }, memory: { enabled: false }, generative_ui: { enabled: false } }, mcp_servers: [] };
  const http = createServer((req, res) => { void (async () => {
    const buffers = []; for await (const b of req) buffers.push(b);
    const body = JSON.parse(Buffer.concat(buffers).toString() || '{}') as Record<string, unknown>;
    const pathname = new URL(req.url!, 'http://localhost').pathname;
    const json = (data: unknown) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (pathname === '/api/v1/agents') return json({ data: ['primary', 'secondary'].map(name => ({ id: name, name, manifest })), pagination: { limit: 50 } });
    if (pathname.startsWith('/api/v1/agents/')) return json({ data: { id: 'agent', name: 'agent', manifest } });
    if (pathname === '/api/v1/models') return json({ data: [{ name: 'fixture/model' }] });
    if (pathname === '/api/v1/settings/mcp-servers') { const m = body.manifest as typeof manifests extends Map<string, infer V> ? V : never; manifests.set(m.name, m); return json({ data: body }); }
    if (pathname.startsWith('/api/v1/settings/mcp-servers/')) { manifests.delete(pathname.split('/').at(-1)!); return json({}); }
    if (pathname.endsWith('/tools')) {
      const name = pathname.split('/').at(-2)!, m = manifests.get(name)!;
      const client = new Client({ name: 'wire-discovery', version: '1' });
      await client.connect(new StreamableHTTPClientTransport(new URL(m.url), { requestInit: { headers: m.auth.headers } }));
      const tools = await client.listTools(); await client.close(); return json({ data: tools.tools });
    }
    if (pathname === '/api/v1/sessions') {
      const id = randomUUID(), spec = (body.agent as { spec: Record<string, unknown> }).spec;
      const name = (spec.mcp_servers as { name: string }[])[0]!.name, m = manifests.get(name)!;
      const client = new Client({ name: 'wire-execution', version: '1' });
      await client.connect(new StreamableHTTPClientTransport(new URL(m.url), { requestInit: { headers: m.auth.headers } }));
      sessions.set(id, { spec, step: 0, client, calls: 0, primary: (body.metadata as { savedAgent: string }).savedAgent === 'primary' });
      return json({ data: { id, agent: { type: 'inline', spec }, metadata: body.metadata, metrics: {}, source: null } });
    }
    const id = pathname.split('/')[4]!, s = sessions.get(id); if (!s) { res.writeHead(404).end(); return; }
    const send = (event: object) => s.res?.write(`data: ${JSON.stringify({ created_at: '', thread_id: 'main', id: randomUUID(), ...event })}\n\n`);
    const done = () => { send({ type: 'model.message.delta', content: 'Used the actual failure feedback; changes remain staged for review.' }); send({ type: 'turn.done', state: { status: 'done', completed_at: '', output: null, required_actions: [] } }); s.res?.end(); };
    const connector = (s.spec.mcp_servers as { name: string }[])[0]!.name;
    const call = (name: string, input: unknown, callId: string) => send({ type: 'model.message', id: `source-${callId}`, content: null, tool_calls: [{ id: callId, type: 'function', function: { name, arguments: JSON.stringify(input) }, tool_info: { type: 'mcp', name, server_id: connector, server_name: connector } }] });
    const tool = async (name: string, input: Record<string, unknown>, callId: string) => {
      s.calls++; const result = await s.client.callTool({ name, arguments: input });
      const payload = JSON.parse((result.content as { text: string }[])[0]!.text); results.push(payload);
      send({ type: 'tool.response', tool_call_id: callId, content: JSON.stringify(payload) }); return payload;
    };
    if (pathname.endsWith('/cancel')) { s.res?.end(); return json({ data: {} }); }
    if (pathname === `/api/v1/sessions/${id}`) return json({ data: { id, agent: { type: 'inline', spec: s.spec }, metadata: {}, metrics: {}, source: null } });
    if (pathname.endsWith('/turns')) {
      s.res = res; res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      send({ type: 'turn.created', turn_id: `turn-${id}`, previous_turn_id: null, state: { status: 'running' } });
      const callId = `command-${id}`; call('run_command', { operation: 'npm_test', script: 'test', timeoutSeconds: 5 }, callId);
      send({ type: 'tool.approval_required', id: `approval-${callId}`, tool_calls: [{ id: callId, source_event_id: mode === 'wrong-source' ? 'mismatched' : `source-${callId}` }] }); started(); return;
    }
    if (pathname.endsWith('/events') && req.method === 'GET') return json({ data: [], pagination: { limit: 50 } });
    if (pathname.endsWith('/events') && req.method === 'POST') {
      json({ data: [] });
      const a = (body.events as { tool_call_id: string; approval: { status: string } }[])[0]!;
      approvals.push({ status: a.approval.status, callId: a.tool_call_id, sessionId: id });
      if (a.approval.status === 'deny') {
        send({ type: 'tool.response', tool_call_id: a.tool_call_id, content: JSON.stringify({ kind: 'forgepilot.command', termination: 'denied' }) });
        if (mode === 'deny-error') { send({ type: 'turn.done', state: { status: 'error', completed_at: '', message: 'Error code: 503 provider unavailable after denial' } }); s.res?.end(); } else done();
        return;
      }
      if (s.step++ === 0) {
        if (mode === 'fallback' && s.primary) { send({ type: 'turn.done', state: { status: 'error', completed_at: '', message: 'Error code: 503 provider unavailable' } }); s.res?.end(); return; }
        await tool('run_command', { operation: 'npm_test', script: 'test', timeoutSeconds: 5 }, a.tool_call_id);
        const input = { operation: 'modify', path: 'wire.ts', baseHash: hash(content), edits: [{ oldText: '1', newText: '2' }] };
        const draftCall = `draft-${id}`; call('draft_file', input, draftCall); const draft = await tool('draft_file', input, draftCall);
        const final = { plan: 'Correction after actual verification failure', draftIds: [draft.draftId] };
        call('check_drafts', final, `check-${id}`); await tool('check_drafts', final, `check-${id}`);
        const proposalId = `proposal-${id}`; call('propose_drafts', final, proposalId);
        send({ type: 'tool.approval_required', id: `approval-${proposalId}`, tool_calls: [{ id: proposalId, source_event_id: `source-${proposalId}` }] });
      } else {
        const drafts = await s.client.callTool({ name: 'list_drafts', arguments: {} });
        const list = JSON.parse((drafts.content as { text: string }[])[0]!.text);
        await tool('propose_drafts', { plan: 'Correction after actual verification failure', draftIds: list.drafts.map((d: { draftId: string }) => d.draftId) }, a.tool_call_id); done();
      }
      return;
    }
    res.writeHead(404).end();
  })().catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); }); });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve)); const address = http.address(); if (!address || typeof address !== 'object') throw new Error('bind');
  const options = { baseUrl: `http://127.0.0.1:${address.port}`, agentName: 'primary', root, autonomous: true, childPath: path.resolve('dist/mcp-child.cjs'), log: () => {} };
  const bridge = new ResilientBridge(options, { enabled: true, agentName: 'secondary' });
  return { root, content, bridge, approvals, results, sessions, commandRequested, options,
    async close() { await bridge.stop(); for (const s of sessions.values()) await s.client.close(); await new Promise<void>(resolve => { http.close(() => resolve()); http.closeAllConnections(); }); if (!rootOverride) await rm(root, { recursive: true, force: true }); } };
}
