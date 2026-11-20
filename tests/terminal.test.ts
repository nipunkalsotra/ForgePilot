import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, symlink, rm, realpath, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CommandAuthority, parseCommand, planCommand, sanitizeCommandOutput, type CommandApproval } from '../src/terminal';
import { startServer } from '../src/mcp/server';
import { Companion } from '../src/companion';
import { setTimeout as delay } from 'node:timers/promises';

const exec = promisify(execFile);
async function fixture(source = 'console.log("actual stdout"); console.error("actual stderr");') {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'forgepilot-command-')));
  await writeFile(path.join(root, 'probe.cjs'), source);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node probe.cjs' } }));
  await exec('/usr/bin/git', ['init', '-q', root]);
  const authority = new CommandAuthority(root); const requestId = randomUUID(); authority.begin(requestId);
  const input = { operation: 'npm_test', script: 'test', timeoutSeconds: 5 };
  const grant = async (request: unknown = input, overrides: Partial<CommandApproval> = {}) => {
    const plan = await planCommand(root, request);
    const approval = { requestId, callId: randomUUID(), sourceEventId: randomUUID(), approvalEventId: randomUUID(), request: plan.request, binding: plan.binding, ...overrides };
    await authority.grant(approval); return approval;
  };
  return { root, input, authority, requestId, grant, async close() { await authority.close(); await rm(root, { recursive: true, force: true }); } };
}
test('terminal policy: typed operations reject arbitrary commands, flags, chains, inline code and malformed variants', () => {
  for (const input of [ { command: 'sh -c true' }, { operation: 'rm' }, { operation: 'git_status', args: ['--exec=evil'] },
    { operation: 'git_status', cwd: '.', env: { TOKEN: 'forged' } }, { operation: 'pytest' }, { operation: 'npm_test', script: 'install' },
    { operation: 'git_status', script: 'test' }, { operation: 'git_status', timeoutSeconds: 121 }, { operation: 'git_status', approved: true } ])
    assert.throws(() => parseCommand(input));
});
test('terminal confinement rejects traversal, absolute paths, shell text and symlink escapes before approval', async () => {
  const f = await fixture();
  try {
    await symlink('/tmp', path.join(f.root, 'escape'));
    for (const cwd of ['../', '/tmp', 'a/../../tmp', './', 'a\\b', '$(id)', 'x;id', 'x|cat', 'x>out', 'escape', '.git', 'a//b'])
      await assert.rejects(planCommand(f.root, { operation: 'git_status', cwd }));
    await writeFile(path.join(f.root, 'test_ok.py'), 'assert True\n');
    await symlink('/etc/passwd', path.join(f.root, 'test_link.py'));
    for (const p of ['../test.py', '/tmp/test.py', 'test_link.py', 'test_ok.py;id', '-c', 'test_ok.py::test'])
      await assert.rejects(planCommand(f.root, { operation: 'pytest', testPaths: [p] }));
    assert.equal((await planCommand(f.root, { operation: 'pytest', testPaths: ['test_ok.py'] })).executable, '/usr/bin/python3');
    await assert.rejects(planCommand(f.root, { operation: 'git_status', timeoutSeconds: 10 }, 5));
  } finally { await f.close(); }
});
test('terminal grant: no approval, denied/mismatched payload and replay execute zero additional commands', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.authority.execute(f.input)).termination, 'denied');
    const grant = await f.grant();
    assert.equal((await f.authority.execute({ operation: 'git_status' })).termination, 'denied');
    const [a, b] = await Promise.all([f.authority.execute(f.input), f.authority.execute(f.input)]);
    assert.equal(a.exitCode, 0); assert.equal(a.stdout.trim().endsWith('actual stdout'), true); assert.match(a.stderr, /actual stderr/);
    assert.equal(a.callId, grant.callId); assert.equal(a.approvalEventId, grant.approvalEventId);
    assert.equal(b.termination, 'denied'); assert.equal((await f.authority.execute(f.input)).termination, 'denied');
    await assert.rejects(f.authority.grant(grant), /repeated/);
  } finally { await f.close(); }
});
test('terminal returns real Git output, nonzero command status and permits a subsequent command after failure', async () => {
  const f = await fixture('console.error("deterministic failure"); process.exitCode = 7;');
  try {
    await f.grant(); const failed = await f.authority.execute(f.input);
    assert.equal(failed.exitCode, 7); assert.equal(failed.termination, 'exited'); assert.match(failed.stderr, /deterministic failure/);
    const request = { operation: 'git_status' }; await f.grant(request);
    const next = await f.authority.execute(request); assert.equal(next.exitCode, 0); assert.match(next.stdout, /probe.cjs/);
    const help = { operation: 'cli_help' }; await f.grant(help); assert.equal((await f.authority.execute(help)).exitCode, 0);
  } finally { await f.close(); }
});
test('terminal timeout kills nested detached descendants in the PID namespace', async () => {
  const marker = `fp-child-${randomBytes(8).toString('hex')}`;
  const f = await fixture(`const {spawn} = require('node:child_process'); spawn(process.execPath,['-e',${JSON.stringify(`process.title=${JSON.stringify(marker)}; setInterval(()=>{},1000);`)}],{detached:true,stdio:'ignore'}); console.log('spawned'); setInterval(()=>{},1000);`);
  try {
    const request = { ...f.input, timeoutSeconds: 1 }; await f.grant(request);
    const result = await f.authority.execute(request); assert.equal(result.termination, 'timeout'); assert.equal(result.timedOut, true); assert.notEqual(result.exitCode, 0);
    const { stdout } = await exec('/usr/bin/ps', ['-eo', 'args=']); assert.equal(stdout.includes(marker), false, 'No descendant survives sandbox teardown');
  } finally { await f.close(); }
});
test('terminal output budget is combined and explicit; excess output terminates execution', async () => {
  const f = await fixture('process.stdout.write("A".repeat(40000)); process.stderr.write("B".repeat(40000)); setInterval(()=>{},1000);');
  try { await f.grant(); const r = await f.authority.execute(f.input); assert.equal(r.truncated, true); assert.equal(r.termination, 'output_limit'); assert.ok(Buffer.byteLength(r.stdout + r.stderr) <= 12000); }
  finally { await f.close(); }
});
test('terminal cancellation revokes pending grants, stops execution and refuses stale sessions', async () => {
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  const f = await fixture('console.log("running"); setInterval(()=>{},1000);');
  const authority = new CommandAuthority(f.root, 120, 12000, () => entered()); authority.begin(f.requestId);
  try {
    const p = await planCommand(f.root, f.input), grant = { requestId: f.requestId, callId: 'call', sourceEventId: 'source', approvalEventId: 'approval', request: p.request, binding: p.binding };
    await authority.grant(grant); const execution = authority.execute(f.input); await started; authority.invalidate();
    assert.equal((await execution).cancelled, true); await assert.rejects(authority.grant(grant));
    assert.equal((await authority.execute(f.input)).termination, 'denied'); assert.throws(() => authority.begin(f.requestId));
    authority.begin(randomUUID()); await assert.rejects(authority.grant(grant));
  } finally { await authority.close(); await f.close(); }
});
test('terminal approval is bound to directory identity and cannot follow a replacement', async () => {
  const f = await fixture();
  try {
    await mkdir(path.join(f.root, 'sub')); const r = { operation: 'git_status', cwd: 'sub' }; await f.grant(r);
    await rename(path.join(f.root, 'sub'), path.join(f.root, 'old')); await mkdir(path.join(f.root, 'sub'));
    await assert.rejects(f.authority.execute(r), /identity changed/);
  } finally { await f.close(); }
});
test('terminal sandbox blocks source writes, host reads and networking, and strips inherited credentials', async () => {
  const f = await fixture(`const fs=require('node:fs'); for(const name of ['TRUEFORGE_TOKEN','OPENAI_API_KEY','NODE_OPTIONS','PYTHONPATH','FORGEPILOT_COMPANION_TOKEN']) { if(process.env[name]) throw Error('inherited '+name); } try {fs.writeFileSync('probe.cjs','unauthorized')} catch(e) { console.log('write:'+e.code); } try{fs.readFileSync('/etc/passwd')}catch(e){console.log('host:'+e.code)}; require('node:net').connect(8790,'127.0.0.1').on('error',()=>console.log('network:blocked'));`);
  const prior = process.env.TRUEFORGE_TOKEN; process.env.TRUEFORGE_TOKEN = 'must-not-inherit';
  try { const before = await readFile(path.join(f.root, 'probe.cjs'), 'utf8'); await f.grant(); const r = await f.authority.execute(f.input); assert.equal(r.exitCode, 0); assert.match(r.stdout, /write:EROFS/); assert.match(r.stdout, /host:ENOENT/); assert.match(r.stdout, /network:blocked/); assert.equal(await readFile(path.join(f.root, 'probe.cjs'), 'utf8'), before); }
  finally { if (prior === undefined) delete process.env.TRUEFORGE_TOKEN; else process.env.TRUEFORGE_TOKEN = prior; await f.close(); }
});
test('command output redacts recognized sensitive markers and terminal controls', () => {
  const r = sanitizeCommandOutput('\x1b[31mAuthorization: Bearer abc123\nOPENAI_API_KEY=supersecret\nTOKEN: anothersecret\x00');
  assert.doesNotMatch(r, /abc123|supersecret|anothersecret/); assert.equal(r.includes('\x1b') || r.includes('\x00'), false); assert.match(r, /REDACTED/);
});
test('approved command output redacts sensitive markers independently in stdout and stderr', async () => {
  const f = await fixture('console.log("TOKEN=do-not-return-this");console.error("Authorization: Bearer do-not-return-that");');
  try {
    await f.grant(); const result = await f.authority.execute(f.input); assert.equal(result.exitCode, 0);
    assert.doesNotMatch(result.stdout + result.stderr, /do-not-return/); assert.match(result.stdout, /REDACTED/); assert.match(result.stderr, /REDACTED/);
  } finally { await f.close(); }
});
test('terminal stop awaits process cleanup and permanently closes command authority', async () => {
  const f = await fixture('setInterval(()=>{},1000)');
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  const authority = new CommandAuthority(f.root, 120, 12000, () => started()); authority.begin(f.requestId);
  try {
    const plan = await planCommand(f.root, f.input);
    await authority.grant({ requestId: f.requestId, callId: 'stop', sourceEventId: 'source', approvalEventId: 'approval', request: plan.request, binding: plan.binding });
    const command = authority.execute(f.input); await ready; await authority.close(); assert.equal((await command).termination, 'cancelled');
    assert.throws(() => authority.begin(randomUUID())); assert.equal((await authority.execute(f.input)).termination, 'denied');
  } finally { await authority.close(); await f.close(); }
});
test('stopping the actual companion during a running MCP command cleans up the process and its access', async () => {
  // Linux process.title is limited by the original short "node probe.cjs" argv storage.
  const marker = `fs-${randomBytes(4).toString('hex')}`;
  const f = await fixture(`process.title=${JSON.stringify(marker)}; setInterval(()=>{},1000);`);
  const companion = new Companion(path.resolve('dist/mcp-child.cjs'), () => {}), client = new Client({ name: 'stop-command', version: '1' });
  try {
    const url = await companion.start(f.root, false, true); const pid = companion.pid!;
    await companion.setDraftRequest(f.requestId); const plan = await planCommand(f.root, f.input);
    await companion.grantCommand({ requestId: f.requestId, callId: 'running-stop', sourceEventId: 'source', approvalEventId: 'approval', request: plan.request, binding: plan.binding });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${companion.token}` } } }));
    const command = client.callTool({ name: 'run_command', arguments: f.input }).catch(() => undefined);
    let observed = false;
    for (let i = 0; i < 40 && !observed; i++) { observed = (await exec('/usr/bin/ps', ['-eo', 'args='])).stdout.includes(marker); if (!observed) await delay(25); }
    assert.equal(observed, true, 'The harmless command must actually start before Stop');
    await companion.stop(); await command; assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.equal((await exec('/usr/bin/ps', ['-eo', 'args='])).stdout.includes(marker), false); assert.equal(companion.url, undefined);
  } finally { await client.close(); await companion.stop(); await f.close(); }
});
test('authenticated MCP advertises run_command but cannot grant itself authorization or use unknown schema fields', async () => {
  const f = await fixture(); const token = randomBytes(32).toString('hex'), server = await startServer(f.root, token, () => {}, false, true);
  const client = new Client({ name: 'terminal-security', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const names = (await client.listTools()).tools.map(t => t.name); assert.ok(names.includes('run_command')); assert.equal(names.some(n => n.includes('grant')), false);
    const result = await client.callTool({ name: 'run_command', arguments: { operation: 'git_status' } }); assert.match(JSON.stringify(result), /denied/);
    const malformed = await client.callTool({ name: 'run_command', arguments: { operation: 'git_status', approved: true } }); assert.equal(malformed.isError, true);
    server.beginDrafts(f.requestId); const plan = await planCommand(f.root, { operation: 'git_status' });
    await server.grantCommand({ requestId: f.requestId, callId: 'call', sourceEventId: 'source', approvalEventId: 'approval', request: plan.request, binding: plan.binding });
    const approved = await client.callTool({ name: 'run_command', arguments: { operation: 'git_status' } });
    const content = approved.content as { type: string; text: string }[]; assert.equal(JSON.parse(content[0]!.text).exitCode, 0);
    server.invalidateDrafts(); assert.match(JSON.stringify(await client.callTool({ name: 'run_command', arguments: { operation: 'git_status' } })), /denied/);
  } finally { await client.close(); await server.close(); await f.close(); }
});
