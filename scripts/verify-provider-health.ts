import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Bridge } from '../src/bridge';
import { classifyFailure } from '../src/failure';
import { publicError } from '../src/log';

// One bounded inference through TrueForge. No provider/account credentials are read.
async function main(): Promise<void> {
const name = process.env.TRUEFORGE_AGENT_NAME ?? 'forge-coder-openrouter';
const root = await mkdtemp(path.join(tmpdir(), 'forgepilot-health-'));
const marker = randomBytes(16).toString('hex');
await writeFile(path.join(root, 'probe.txt'), marker);
const report: Record<string, unknown> = { at: new Date().toISOString(), agent: name, capacity: 'No remaining account quota API is exposed by this SDK; inference only proves present availability.' };
const bridge = new Bridge({ baseUrl: 'http://localhost:8790', agentName: name, root, isolated: true,
  childPath: path.resolve('dist/mcp-child.cjs'), turnTimeoutSeconds: 90, log: () => {} });
const before = (await bridge.client.mcpServers.list()).data.map(c => c.name).sort();
try {
  report.session = await bridge.start(); report.model = bridge.modelName;
  let output = '', deltas = 0;
  await bridge.ask('Use list_files then read_file to read the discovered text file. Reply with its exact contents. Do not guess or use other tools.', text => { output += text; }, event => { if (event.type === 'model.message.delta' && event.content) deltas++; });
  assert.ok(deltas > 0 && output.includes(marker));
  const calls = [];
  for await (const { event } of await bridge.client.sessions.listEvents(bridge.sessionId!)) if (event.type === 'model.message') calls.push(...(event.toolCalls ?? []).map(c => ({ id: c.id, tool: c.toolInfo.name, arguments: c.function.arguments })));
  assert.ok(calls.some(c => c.tool === 'list_files') && calls.some(c => c.tool === 'read_file'));
  report.calls = calls; report.metrics = bridge.lastTurnMetrics; report.deltas = deltas; report.result = 'PASS';
} catch (error) {
  const failure = classifyFailure(error); report.result = 'FAIL'; report.failure = { kind: failure.kind, message: failure.message }; process.exitCode = 1;
} finally {
  await bridge.stop();
  assert.equal(await readFile(path.join(root, 'probe.txt'), 'utf8'), marker);
  assert.deepEqual((await bridge.client.mcpServers.list()).data.map(c => c.name).sort(), before);
  report.cleanup = 'PASS';
  await writeFile(`artifacts/final-health-${name}.json`, JSON.stringify(report, null, 2));
  await rm(root, { recursive: true, force: true });
  console.log(JSON.stringify(report));
}
}
await main().catch(error => { console.error(publicError(error)); process.exitCode = 1; });
