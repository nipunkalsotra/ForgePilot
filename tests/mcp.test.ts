import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fork } from 'node:child_process';
import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer } from '../src/mcp/server';
import { Companion } from '../src/companion';

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
