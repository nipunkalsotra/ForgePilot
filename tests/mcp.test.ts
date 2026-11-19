import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fork } from 'node:child_process';
import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer } from '../src/mcp/server';
import { Companion } from '../src/companion';
import { hash } from '../src/patch';

test('real MCP HTTP discovery, tools, policy errors, authentication and shutdown', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'forgepilot-mcp-'));
  const token = randomBytes(32).toString('hex');
  const events: string[] = [];
  await writeFile(path.join(root, 'sample.txt'), 'real MCP fixture');
  const server = await startServer(root, token, event => events.push(event));
  const client = new Client({ name: 'forgepilot-tests', version: '1' });
  try {
    assert.equal((await fetch(server.url, { method: 'POST' })).status, 401);
    assert.equal((await fetch(server.url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, Origin: 'http://attacker.example' } })).status, 403);
    const hostileHost = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(server.url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, Host: 'attacker.example' } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(hostileHost, 403);
    assert.equal((await fetch(server.url, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: 'x'.repeat(20_000) })).status, 413);
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(t => t.name).sort(), ['list_files', 'read_file', 'search_workspace']);
    assert.ok(tools.tools.every(t => t.annotations?.readOnlyHint === true && t.annotations.destructiveHint === false));
    for (const [name, args] of [['list_files', {}], ['read_file', { path: 'sample.txt' }], ['search_workspace', { query: 'fixture' }]] as const) {
      const result = await client.callTool({ name, arguments: args });
      assert.ok(!result.isError);
      assert.match(JSON.stringify(result), /sample.txt/);
      if (name === 'read_file') assert.deepEqual(Object.keys(JSON.parse((result.content as { type: string; text: string }[])[0]!.text)).sort(), ['bytes', 'content', 'path']);
    }
    const denied = await client.callTool({ name: 'read_file', arguments: { path: '../etc/passwd' } });
    assert.equal(denied.isError, true);
    const invalid = await client.callTool({ name: 'search_workspace', arguments: { query: '' } });
    assert.equal(invalid.isError, true);
    assert.equal(events.filter(e => e === 'tool.completed').length, 3);
  } finally { await client.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
  await assert.rejects(fetch(server.url));
});

test('companion process terminates on explicit stop and startup failure', async () => {
  const companion = new Companion(path.resolve('dist/mcp-child.cjs'), () => {});
  const root = await mkdtemp(path.join(tmpdir(), 'forgepilot-child-'));
  try {
    const url = await companion.start(root);
    const pid = companion.pid!;
    assert.ok(pid);
    await companion.stop();
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    await assert.rejects(fetch(url));
    await companion.stop();
    const invalid = new Companion(path.resolve('dist/mcp-child.cjs'), () => {});
    await assert.rejects(invalid.start(path.join(root, 'missing')));
  } finally { await companion.stop(); await rm(root, { recursive: true, force: true }); }
});

test('companion terminates when parent IPC disappears', async () => {
  const child = fork(path.resolve('dist/mcp-child.cjs'), [], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const exited = new Promise<void>(resolve => { child.once('exit', () => resolve()); });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('message', () => resolve()); child.once('error', reject);
      child.send({ root: process.cwd(), token: randomBytes(32).toString('hex') });
    });
    child.disconnect();
    await Promise.race([exited, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('Orphan process remained')), 4000); timer.unref(); })]);
    assert.equal(child.exitCode, 0);
  } finally { if (child.exitCode === null) child.kill('SIGKILL'); }
});

test('opt-in proposal MCP validates structured edits and never writes files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'forgepilot-proposal-mcp-'));
  const content = 'const value = 1;\n';
  await writeFile(path.join(root, 'source.ts'), content);
  const token = randomBytes(32).toString('hex');
  const server = await startServer(root, token, () => {}, true);
  const client = new Client({ name: 'proposal-test', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const tools = await client.listTools(); assert.equal(tools.tools.length, 4);
    const args = { path: 'source.ts', baseHash: hash(content), edits: [{ oldText: '1', newText: '2' }] };
    const result = await client.callTool({ name: 'propose_patch', arguments: args });
    assert.ok(!result.isError); assert.match(JSON.stringify(result), /forgepilot.patch/);
    for (const arguments_ of [{ ...args, path: '../outside' }, { ...args, baseHash: '0'.repeat(64) }, { ...args, edits: [{ oldText: 'missing', newText: 'x' }] }])
      assert.equal((await client.callTool({ name: 'propose_patch', arguments: arguments_ })).isError, true);
    assert.equal(await readFile(path.join(root, 'source.ts'), 'utf8'), content);
  } finally { await client.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('autonomous MCP exposes secure retrieval and no-write multi-file proposal transport', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'forgepilot-agent-mcp-'));
  const content = 'def config_command():\n    return 1\n';
  for (const file of ['commands.py', 'tests.py', 'guide.md']) await writeFile(path.join(root, file), content);
  const token = randomBytes(32).toString('hex');
  const server = await startServer(root, token, () => {}, false, true);
  const client = new Client({ name: 'autonomous-test', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    assert.equal((await client.listTools()).tools.length, 17);
    for (const [name, args] of [['discover_files', { query: 'commands' }], ['lookup_symbol', { name: 'config_command' }], ['context_query', { query: 'config command' }], ['read_range', { path: 'commands.py', start: 1, count: 2 }]] as const) {
      const result = await client.callTool({ name, arguments: args }); assert.ok(!result.isError, JSON.stringify(result));
    }
    const draft = { plan: 'Update related files', files: ['commands.py', 'tests.py', 'guide.md'].map(file => ({ operation: 'modify', path: file, baseHash: hash(content), edits: [{ oldText: 'return 1', newText: 'return 2' }] })) };
    const check = await client.callTool({ name: 'check_batch', arguments: draft });
    assert.match(JSON.stringify(check), /forgepilot.check/); assert.match(JSON.stringify(check), /validation only/);
    const invalid = await client.callTool({ name: 'check_batch', arguments: { ...draft, files: [{ ...draft.files[0]!, edits: [{ oldText: 'does not exist', newText: 'replacement' }] }] } });
    assert.equal((JSON.parse((invalid.content as { type: string; text: string }[])[0]!.text) as { valid: boolean }).valid, false);
    const result = await client.callTool({ name: 'propose_batch', arguments: draft });
    assert.ok(!result.isError); assert.match(JSON.stringify(result), /forgepilot.batch/);
    const requestId = crypto.randomUUID(), draftIds: string[] = [];
    server.beginDrafts(requestId);
    for (const file of draft.files) {
      const response = await client.callTool({ name: 'draft_file', arguments: { ...file } });
      const saved = JSON.parse((response.content as { type: string; text: string }[])[0]!.text) as { valid: boolean; draftId: string };
      assert.equal(saved.valid, true); draftIds.push(saved.draftId);
    }
    const extended = await client.callTool({ name: 'extend_draft', arguments: { draftId: draftIds[0], edits: [{ oldText: 'config_command', newText: 'updated_command' }] } });
    const extendedDraft = JSON.parse((extended.content as { text: string }[])[0]!.text) as { valid: boolean; draftId: string };
    assert.equal(extendedDraft.valid, true); draftIds[0] = extendedDraft.draftId;
    const checked = await client.callTool({ name: 'check_drafts', arguments: { plan: draft.plan, draftIds } });
    assert.equal((JSON.parse((checked.content as { type: string; text: string }[])[0]!.text) as { valid: boolean }).valid, true);
    const listing = await client.callTool({ name: 'list_drafts', arguments: {} });
    for (const id of draftIds) assert.ok(JSON.stringify(listing).includes(id));
    const retained = await client.callTool({ name: 'propose_drafts', arguments: { plan: draft.plan, draftIds } });
    assert.ok(!retained.isError); assert.match(JSON.stringify(retained), /forgepilot.batch/);
    server.invalidateDrafts();
    assert.equal((await client.callTool({ name: 'propose_drafts', arguments: { plan: draft.plan, draftIds } })).isError, true);
    for (const file of ['commands.py', 'tests.py', 'guide.md']) assert.equal(await readFile(path.join(root, file), 'utf8'), content);
    assert.equal((await client.callTool({ name: 'read_range', arguments: { path: '../outside', start: 1, count: 2 } })).isError, true);
  } finally { await client.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('optional autonomous tool pacing spaces responses without changing file contents', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'forgepilot-paced-mcp-'));
  await writeFile(path.join(root, 'source.py'), 'value = 1\n');
  const token = randomBytes(32).toString('hex');
  const server = await startServer(root, token, () => {}, false, true, 12000, 60);
  const client = new Client({ name: 'pacing-test', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const completed: number[] = [];
    await Promise.all([1, 2].map(async () => {
      const result = await client.callTool({ name: 'read_range', arguments: { path: 'source.py', start: 1, count: 1 } });
      assert.ok(!result.isError); completed.push(Date.now());
    }));
    completed.sort((a, b) => a - b);
    assert.ok(completed[1]! - completed[0]! >= 40, 'Responses must occupy distinct pacing slots');
    assert.equal(await readFile(path.join(root, 'source.py'), 'utf8'), 'value = 1\n');
  } finally { await client.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});
