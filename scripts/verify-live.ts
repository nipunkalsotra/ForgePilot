import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, readFile, readdir, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Bridge } from '../src/bridge';
import { jsonLogger, publicError } from '../src/log';

async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const visit = async (relative = '') => {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile()) result[name] = createHash('sha256').update(await readFile(path.join(root, name))).digest('hex');
      else throw new Error('Unexpected non-regular fixture entry');
    }
  };
  await visit();
  return result;
}

const root = await mkdtemp(path.join(tmpdir(), 'forgepilot-live-'));
const marker = `forgepilot-real-mcp-${randomBytes(12).toString('hex')}`;
await mkdir(path.join(root, 'src'));
await writeFile(path.join(root, 'src/inspection.txt'), `Workspace inspection marker: ${marker}\n`);
await writeFile(path.join(root, '.env'), 'FORGEPILOT_TEST_SECRET=must-not-be-readable\n');
const before = await snapshot(root);
const toolExecutions: string[] = [];
const report: Record<string, unknown> = { timestamp: new Date().toISOString(), trueforgeVersion: '0.185.1', sdkVersion: '0.185.0', checks: {} };
const checks: Record<string, string> = {};
report.checks = checks;
const log = jsonLogger(line => process.stderr.write(`${line}\n`));
const bridge = new Bridge({ baseUrl: process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790', agentName: process.env.TRUEFORGE_AGENT_NAME ?? 'forge-coder',
  token: process.env.TRUEFORGE_TOKEN, root, childPath: path.resolve('dist/mcp-child.cjs'),
  turnTimeoutSeconds: 120, log: (event, fields) => {
    log(event, fields);
    if (event === 'tool.completed' && typeof fields?.tool === 'string') toolExecutions.push(fields.tool);
  },
});
let failed = false;
try {
  checks.session = 'FAIL';
  const sessionId = await bridge.start();
  report.sessionId = sessionId;
  report.model = bridge.modelName;
  checks.session = 'PASS';
  let response = '';
  let deltas = 0;
  checks.streaming = 'FAIL';
  await bridge.ask('Use the workspace MCP list_files tool to discover files. Then use read_file to read src/inspection.txt. Report the exact inspection marker from that file. Do not write files, use other tools, or guess its contents.',
    text => { response += text; process.stdout.write(text); }, event => {
      if (event.type === 'model.message.delta' && event.content) deltas++;
    });
  assert.ok(deltas > 0, 'No real assistant text deltas received');
  checks.streaming = 'PASS';
  report.textDeltaCount = deltas;
  checks.mcpExecution = 'FAIL';
  assert.ok(toolExecutions.includes('list_files') && toolExecutions.includes('read_file'), 'Both discovery and read must execute on our server');
  assert.ok(response.includes(marker), 'Assistant must return the unpredictable marker read from disk');
  checks.mcpExecution = 'PASS';
  checks.persistedToolHistory = 'FAIL';
  const history = await bridge.client.sessions.listEvents(sessionId);
  const calls: { id: string; name: string }[] = [];
  const responses: { id: string; content: string }[] = [];
  for await (const item of history) {
    if (item.event.type === 'model.message') {
      for (const call of item.event.toolCalls ?? []) {
        if (call.toolInfo.type === 'mcp' && call.toolInfo.serverName === bridge.connectorName) calls.push({ id: call.id, name: call.function.name });
      }
    }
    if (item.event.type === 'tool.response') responses.push({ id: item.event.toolCallId, content: item.event.content });
  }
  assert.ok(calls.length >= 2 && calls.some(c => responses.some(r => r.id === c.id && r.content.includes(marker))), 'Persisted tool call/response must contain the real file marker');
  checks.persistedToolHistory = 'PASS';
  report.persistedToolNames = calls.map(c => c.name);
} catch (error) {
  failed = true;
  report.error = publicError(error);
  process.stderr.write(`\nLIVE CHECK FAILED: ${publicError(error)}\n`);
} finally {
  try { await bridge.stop(); checks.cleanup = 'PASS'; } catch (error) { failed = true; checks.cleanup = 'FAIL'; report.cleanupError = publicError(error); }
  checks.workspaceUnchanged = JSON.stringify(await snapshot(root)) === JSON.stringify(before) ? 'PASS' : 'FAIL';
  if (checks.workspaceUnchanged !== 'PASS') failed = true;
  for (const name of ['session', 'streaming', 'mcpExecution', 'persistedToolHistory']) checks[name] ??= 'NOT TESTED';
  report.toolExecutions = toolExecutions;
  report.workspaceHashesBefore = before;
  report.workspaceHashesAfter = await snapshot(root);
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/live-verification.json', `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
  console.log('\n' + JSON.stringify(report, null, 2));
}
if (failed) process.exitCode = 1;
