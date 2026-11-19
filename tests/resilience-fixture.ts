import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AUTONOMOUS_TOOLS } from '../src/mcp/autonomous';
import { ResilientBridge } from '../src/resilience';
import { hash } from '../src/patch';

export type WireMode = '401' | '503' | 'quota' | 'valid' | 'staged-error' | 'hold' | 'malformed' | 'denial-503';
/** Local SDK wire fixture; never represents genuine provider inference. */
export async function resilienceFixture(primary: WireMode, secondary: WireMode = 'valid', rootOverride?: string, autonomous = false) {
  const root = rootOverride ?? await mkdtemp(path.join(tmpdir(), 'forgepilot-resilience-'));
  const content = 'const value = 1;\n'; await writeFile(path.join(root, 'resilience.ts'), content);
  const patch = { path: 'resilience.ts', baseHash: hash(content), edits: [{ oldText: 'value = 1', newText: 'value = 2' }] };
  const batch = { plan: 'Update discovered value', files: [{ operation: 'modify', ...patch }] };
  const manifest = { model: { name: 'fixture/model' }, config: { sandbox: { enabled: false }, dynamic_sub_agents: { enabled: false }, web_search: { enabled: false }, memory: { enabled: false }, generative_ui: { enabled: false } }, mcp_servers: [] };
  const sessions = new Map<string, { agent: { type: string; spec: { mcp_servers: { name: string }[] } }; mode: WireMode; res?: ServerResponse }>();
  const requests: { method?: string; path: string; body: Record<string, unknown> }[] = [];
  const connectors = new Set<string>(); const notifications: string[] = [];
  let mode = primary; let turnStarted!: () => void; const started = new Promise<void>(resolve => { turnStarted = resolve; });
  const http = createServer((req, res) => { void (async () => {
    const buffers = []; for await (const b of req) buffers.push(b);
    const body = JSON.parse(Buffer.concat(buffers).toString() || '{}') as Record<string, unknown>;
    const pathname = new URL(req.url!, 'http://localhost').pathname; requests.push({ method: req.method, path: pathname, body });
    const json = (value: unknown) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (pathname === '/api/v1/agents') return json({ data: ['primary', 'secondary'].map(name => ({ id: name, name, manifest })), pagination: { limit: 50 } });
    if (pathname.startsWith('/api/v1/agents/')) return json({ data: { id: pathname.split('/').at(-1), name: pathname.split('/').at(-1), manifest } });
    if (pathname === '/api/v1/models') return json({ data: [{ name: 'fixture/model' }] });
    if (pathname === '/api/v1/settings/mcp-servers') { connectors.add((body.manifest as { name: string }).name); return json({ data: body }); }
    if (pathname.startsWith('/api/v1/settings/mcp-servers/')) { connectors.delete(pathname.split('/').at(-1)!); return json({}); }
    if (pathname.endsWith('/tools')) return json({ data: ['list_files', 'read_file', 'search_workspace', ...(autonomous ? AUTONOMOUS_TOOLS : ['propose_patch'])].map(name => ({ name })) });
    if (pathname === '/api/v1/sessions') {
      const id = `session-${sessions.size + 1}`;
      const agent = { type: 'inline', ...(body.agent as { spec: { mcp_servers: { name: string }[] } }) };
      sessions.set(id, { agent, mode: (body.metadata as { savedAgent: string }).savedAgent === 'primary' ? mode : secondary });
      return json({ data: { id, agent, metadata: body.metadata, metrics: {}, source: null } });
    }
    const id = pathname.split('/')[4]!, s = sessions.get(id);
    if (!s) { res.writeHead(404).end(); return; }
    const sessionData = { id, agent: s.agent, metadata: {}, metrics: {}, source: null };
    if (pathname.endsWith('/cancel')) { s.res?.end(); return json({ data: {} }); }
    if (pathname === `/api/v1/sessions/${id}`) return json({ data: sessionData });
    const send = (event: object) => s.res?.write(`data: ${JSON.stringify({ created_at: '', thread_id: 'main', id: crypto.randomUUID(), ...event })}\n\n`);
    const done = () => { send({ type: 'turn.done', state: { status: 'done', completed_at: '', output: null, required_actions: [] } }); s.res?.end(); };
    if (pathname.endsWith('/events')) {
      if (s.mode === 'denial-503') { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'fixture unavailable after rejection' } })); return; }
      json({ data: [] });
      const events = body.events as { approval: { status: string } }[];
      if (events?.[0]?.approval.status === 'allow') {
        send({ type: 'tool.response', tool_call_id: `call-${id}`, content: JSON.stringify(autonomous ? { kind: 'forgepilot.batch', patch: batch } : { kind: 'forgepilot.patch', patch }) });
        if (s.mode === 'staged-error') { send({ type: 'turn.done', state: { status: 'error', completed_at: '', message: 'Error code: 503 provider unavailable secret-do-not-log' } }); s.res?.end(); }
        else done();
      }
      return;
    }
    if (pathname.endsWith('/turns')) {
      s.res = res; res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      send({ type: 'turn.created', turn_id: `turn-${id}`, previous_turn_id: null, state: { status: 'running' } });
      turnStarted();
      if (s.mode === 'hold') { send({ type: 'model.message.delta', content: 'fixture progress' }); return; }
      if (['401', '503', 'quota'].includes(s.mode)) {
        send({ type: 'turn.done', state: { status: 'error', completed_at: '', message: s.mode === 'quota' ? 'Rate limit exceeded: free-models-per-day secret-do-not-log' : `Error code: ${s.mode} secret-do-not-log` } }); res.end(); return;
      }
      const input = body.input as { content: string }[];
      if (!input[0]?.content.includes('Inline editing request.') && !input[0]?.content.includes('Autonomous repository task.')) { send({ type: 'model.message.delta', content: 'fixture completed' }); done(); return; }
      const connector = s.agent.spec.mcp_servers[0]!.name;
      send({ type: 'model.message', id: `source-${id}`, tool_calls: [{ id: `call-${id}`, type: 'function', function: { name: autonomous ? 'propose_batch' : 'propose_patch', arguments: JSON.stringify(s.mode === 'malformed' ? { bad: true } : autonomous ? batch : patch) }, tool_info: { type: 'mcp', name: autonomous ? 'propose_batch' : 'propose_patch', server_id: connector, server_name: connector } }] });
      send({ type: 'tool.approval_required', tool_calls: [{ id: `call-${id}`, source_event_id: `source-${id}` }] }); return;
    }
    res.writeHead(404).end();
  })().catch(() => { res.writeHead(500).end(); }); });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const address = http.address(); if (!address || typeof address !== 'object') throw new Error('Fixture bind failed');
  const options = { baseUrl: `http://127.0.0.1:${address.port}`, agentName: 'primary', root, childPath: path.resolve('dist/mcp-child.cjs'), proposals: !autonomous, autonomous, log: () => {} };
  const bridge = new ResilientBridge(options, { enabled: true, agentName: 'secondary', notify: message => notifications.push(message) });
  return { root, content, options, bridge, sessions, requests, connectors, notifications, started, setMode(value: WireMode) { mode = value; },
    unchanged: async () => (await readFile(path.join(root, 'resilience.ts'), 'utf8')) === content,
    async close() { await bridge.stop(); await new Promise<void>(resolve => { http.close(() => resolve()); http.closeAllConnections(); }); if (!rootOverride) await rm(root, { recursive: true, force: true }); } };
}
