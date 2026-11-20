import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, symlink, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Workspace } from '../src/workspace';
import { TokenBudgetManager } from '../src/budget';
import { ContextEngine } from '../src/context';
import { DraftStore, checkFile } from '../src/drafts';
import { hash } from '../src/patch';
import { startServer } from '../src/mcp/server';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'forgepilot-resources-'));
  await writeFile(path.join(root, 'sample.py'), 'def sample():\n    return 1 # ' + 'bounded context '.repeat(10) + '\n');
  const workspace = await Workspace.create(root);
  return { root, workspace, async close() { workspace.dispose(); await rm(root, { recursive: true, force: true }); } };
}
test('range deduplication revalidates hashes, rejects stale files, and resets with request scope', async () => {
  const f = await fixture(); const e = new ContextEngine(f.workspace);
  try {
    const first = await e.range('sample.py', 1, 2), duplicate = await e.range('sample.py', 1, 2);
    assert.equal(duplicate.content, ''); assert.equal(duplicate.hash, first.hash); assert.ok('duplicate' in duplicate && duplicate.duplicate);
    await writeFile(path.join(f.root, 'sample.py'), 'def sample():\n    return 2\n');
    const changed = await e.range('sample.py', 1, 2); assert.match(changed.content, /return 2/); assert.notEqual(changed.hash, first.hash);
    e.reset(); assert.match((await e.range('sample.py', 1, 2)).content, /return 2/);
    await rm(path.join(f.root, 'sample.py')); await assert.rejects(e.range('sample.py', 1, 2));
  } finally { await f.close(); }
});
test('deduplication never bypasses sensitive-path, symlink or disposed authorization checks', async () => {
  const f = await fixture(); const e = new ContextEngine(f.workspace);
  try {
    await e.range('sample.py', 1, 2); await rm(path.join(f.root, 'sample.py')); await symlink('/etc/passwd', path.join(f.root, 'sample.py'));
    await assert.rejects(e.range('sample.py', 1, 2)); await assert.rejects(e.range('../sample.py', 1, 2));
    await writeFile(path.join(f.root, '.env'), 'TOKEN=private'); await assert.rejects(e.range('.env', 1, 1));
    f.workspace.dispose(); await assert.rejects(f.workspace.readFile('.env')); await assert.rejects(f.workspace.readRange('sample.py'));
  } finally { await f.close(); }
});
test('retrieval omits changed scan snapshots instead of attributing stale code to current hashes', async () => {
  const f = await fixture(); const original = f.workspace.readFile.bind(f.workspace); let reads = 0;
  f.workspace.readFile = async (p, limit) => {
    if (p === 'sample.py' && ++reads === 2) await writeFile(path.join(f.root, p), 'def replaced():\n    return 2\n');
    return original(p, limit);
  };
  try { const r = await new ContextEngine(f.workspace).retrieve('sample'); assert.equal(r.selected.length, 0); assert.ok(r.truncated); assert.ok(r.omitted > 0); assert.match(r.omissions?.[0]?.reason ?? '', /changed after scan/); }
  finally { await f.close(); }
});
test('checkpoint metadata contains no source or approval; invalidation and new sessions cannot reuse draft IDs', async () => {
  const f = await fixture(); const d = new DraftStore(f.workspace); const id = randomUUID(); d.begin(id);
  try {
    const source = await readFile(path.join(f.root, 'sample.py'), 'utf8');
    const result = await d.put(id, { operation: 'modify', path: 'sample.py', baseHash: hash(source), edits: [{ oldText: 'return 1', newText: 'return 2' }] });
    assert.ok('draftId' in result && result.draftId); const draftId = 'draftId' in result ? result.draftId! : '';
    const list = d.list(); assert.equal(list.checkpoint.authority, 'none'); assert.doesNotMatch(JSON.stringify(list), /return 1|return 2|Authorization|Bearer|approvalEventId/);
    d.invalidate(); assert.throws(() => d.list()); assert.throws(() => d.begin(id));
    const next = randomUUID(); d.begin(next); assert.throws(() => d.assemble(next, 'stale', [draftId]));
    const fresh = new DraftStore(f.workspace); fresh.begin(randomUUID()); assert.equal(fresh.list().drafts.length, 0); fresh.close();
    assert.equal(await readFile(path.join(f.root, 'sample.py'), 'utf8'), source);
  } finally { d.close(); await f.close(); }
});
test('syntax preflight parses JSON/CommonJS without executing code, and reports actionable failures', async () => {
  const f = await fixture();
  try {
    for (const [name, content] of [['bad.json', '{"x":}'], ['bad.cjs', 'const = broken']]) {
      const r = await checkFile(f.workspace, { operation: 'create', path: name, content }); assert.equal(r.valid, false); assert.equal(r.code, 'SYNTAX_INVALID');
    }
    assert.equal((await checkFile(f.workspace, { operation: 'create', path: 'valid.cjs', content: 'throw new Error("never executed")' })).valid, true);
    const commonjs = '#!/usr/bin/env node\nreturn;\n';
    await writeFile(path.join(f.root, 'reference.cjs'), commonjs);
    (await import('node:child_process')).execFileSync(process.execPath, ['--check', path.join(f.root, 'reference.cjs')]);
    assert.equal((await checkFile(f.workspace, { operation: 'create', path: 'return.cjs', content: commonjs })).valid, true);
    const jsonc = '// TypeScript configuration supports JSONC\n{"compilerOptions": {}}';
    assert.equal((await import('typescript')).default.parseConfigFileTextToJson('tsconfig.json', jsonc).error, undefined);
    assert.equal((await checkFile(f.workspace, { operation: 'create', path: 'tsconfig.json', content: jsonc })).valid, true);
    await assert.rejects(readFile(path.join(f.root, 'valid.cjs')));
  } finally { await f.close(); }
});
test('actual stateless MCP shares request-scoped deduplication and strict limits while preserving checks', async () => {
  const f = await fixture(); const token = randomBytes(32).toString('hex');
  const server = await startServer(f.root, token, () => {}, false, true, 12000, 0, 120, () => {}, { mode: 'strict', taskTokens: 2000 });
  const client = new Client({ name: 'resource-test', version: '1' });
  try {
    server.beginDrafts(randomUUID(), { prompt: 'x'.repeat(5500) });
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: args }); return JSON.parse((r.content as { text: string }[])[0]!.text);
    };
    const first = await call('read_range', { path: 'sample.py', start: 1, count: 2 }); assert.match(first.content, /def sample/);
    const stopped = await call('context_query', { query: 'sample' }); assert.equal(stopped.kind, 'forgepilot.resource_stop');
    const list = await call('list_drafts', {}); assert.equal(list.kind, 'forgepilot.drafts'); assert.equal(list.checkpoint.authority, 'none');
    server.invalidateDrafts(); server.beginDrafts(randomUUID());
    server.resetContext();
    const read = await call('read_range', { path: 'sample.py', start: 1, count: 2 }); assert.match(read.content, /def sample/);
    assert.equal((await call('read_range', { path: 'sample.py', start: 1, count: 2 })).duplicate, true);
    server.resetContext(); assert.match((await call('read_range', { path: 'sample.py', start: 1, count: 2 })).content, /def sample/);
  } finally { await client.close(); await server.close(); await f.close(); }
});

test('authorized root replacement invalidates context access and short ranges never inflate response cost', async () => {
  const f = await fixture(); const e = new ContextEngine(f.workspace); const old = f.root + '-original';
  try {
    await writeFile(path.join(f.root, 'tiny.py'), 'x=1');
    const first = await e.range('tiny.py', 1, 1), second = await e.range('tiny.py', 1, 1);
    assert.ok(Buffer.byteLength(JSON.stringify(second)) <= Buffer.byteLength(JSON.stringify(first)));
    await rename(f.root, old); await mkdir(f.root); await writeFile(path.join(f.root, 'tiny.py'), 'x=2');
    await assert.rejects(e.range('tiny.py', 1, 1), /authorization/);
  } finally { await f.close(); await rm(old, { recursive: true, force: true }); }
});

test('low-budget outlines and ranges preserve hashes while precisely disclosing reduced source output', async () => {
  const f = await fixture();
  try {
    const source = Array.from({ length: 120 }, (_, i) => `def method_${i}():\n    return ${i}\n`).join('');
    await writeFile(path.join(f.root, 'long.py'), source);
    const resources = new TokenBudgetManager({ mode: 'conservative', taskTokens: 8000 }); resources.beginAttempt('x'.repeat(6000));
    const e = new ContextEngine(f.workspace, 12000, resources);
    const range = await e.range('long.py', 1, 200); assert.equal(range.end, 20); assert.match('omission' in range ? range.omission ?? '' : '', /Budget reduced/); assert.equal(range.hash, hash(source));
    const outline = await e.outline('long.py'); assert.equal(outline.symbols.length, 25); assert.equal(outline.baseHash, hash(source)); assert.equal(outline.truncated, true);
  } finally { await f.close(); }
});
