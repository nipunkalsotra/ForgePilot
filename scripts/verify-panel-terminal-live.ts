import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { Bridge } from '../src/bridge';
import { BatchStore } from '../src/batch';
import { Workspace } from '../src/workspace';
import { PanelState } from '../src/panel-state';
import { publicError } from '../src/log';
import type { CommandApproval } from '../src/terminal';

// Genuine harness/model execution; approvals are explicitly automated acceptance-driver
// decisions in a disposable repository, never evidence of physical developer clicks.
const root = await mkdtemp(path.join(tmpdir(), 'forgepilot-terminal-live-'));
await promisify(execFile)('/usr/bin/git', ['init', '-q', root]);
await writeFile(path.join(root, 'inspection.txt'), 'terminal-live-marker\n');
const before = await readFile(path.join(root, 'inspection.txt'), 'utf8');
const workspace = await Workspace.create(root), state = new PanelState();
const report: Record<string, unknown> = { timestamp: new Date().toISOString(), kind: 'genuine TrueForge model + authenticated MCP; automated approval driver', physicalClicks: 'NOT TESTED' };
const bridges: Bridge[] = [];
const attempts: object[] = []; report.attempts = attempts;
try {
  for (const decision of ['approve', 'deny', 'cancel'] as const) {
    const bridge = new Bridge({ baseUrl: 'http://localhost:8790', agentName: process.env.TRUEFORGE_AGENT_NAME ?? 'forge-coder', root,
      childPath: path.resolve('dist/mcp-child.cjs'), autonomous: true, isolated: true, turnTimeoutSeconds: 90, log: () => {} });
    bridges.push(bridge);
    const connectors = (await bridge.client.mcpServers.list()).data.map(c => c.name).sort();
    const attempt: Record<string, unknown> = { decision }; attempts.push(attempt);
    await bridge.start(); attempt.sessionId = bridge.sessionId; attempt.model = bridge.modelName;
    attempt.discoveredTools = (await bridge.client.mcpServers.listTools(bridge.connectorName)).data.map(t => t.name);
    let approvals = 0, deltas = 0; const results: unknown[] = [], correlations: Omit<CommandApproval, 'request' | 'binding'>[] = [];
    const store = new BatchStore(workspace); state.begin(`live ${decision}`);
    const operation = bridge.autonomous(store,
      'Read-only verification request: use context_query once, then call the MCP run_command tool EXACTLY ONCE with operation=git_status, cwd=".", timeoutSeconds=10. After the command result (including developer denial), explain the actual result briefly and finish without drafts or proposals. Never invent execution or retry a denied command.',
      () => {}, async () => assert.fail('No staging requested'), event => { if (event.tool === 'run_command') results.push(event.result); }, undefined, {
        allowNoProposal: true,
        stream(event, identity) { state.stream(event, identity); if (event.type === 'model.message.delta' && event.content) deltas++; },
        async approveCommand(plan, correlation, signal) {
          approvals++; correlations.push(correlation); assert.equal(plan.request.operation, 'git_status'); attempt.command = plan.summary;
          if (decision === 'cancel') { setTimeout(() => { void bridge.cancel(); }, 0); await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); return true; }
          return decision === 'approve';
        },
      });
    if (decision === 'cancel') await assert.rejects(operation, /cancelled/); else await operation;
    assert.equal(approvals, 1); assert.equal(store.current, undefined); assert.equal(await readFile(path.join(root, 'inspection.txt'), 'utf8'), before);
    attempt.correlations = correlations; attempt.results = results; attempt.textDeltas = deltas; attempt.panelModel = state.model;
    if (decision === 'approve') { assert.ok(results.some(r => !!r && typeof r === 'object' && 'exitCode' in r && r.exitCode === 0)); assert.ok(deltas > 0); }
    const history = [];
    for await (const { event } of await bridge.client.sessions.listEvents(bridge.sessionId!)) if (['tool.approval_required', 'user.tool_approval', 'tool.response'].includes(event.type)) history.push({ type: event.type, id: event.id, ...(event.type === 'tool.response' ? { callId: event.toolCallId } : {}) });
    attempt.history = history; attempt.result = 'PASS'; await bridge.stop();
    assert.deepEqual((await bridge.client.mcpServers.list()).data.map(c => c.name).sort(), connectors); attempt.connectorCleanup = 'PASS';
  }
  report.result = 'PASS';
} catch (error) { report.result = 'CONDITIONAL'; report.error = publicError(error); process.exitCode = 1; }
finally {
  for (const bridge of bridges) await bridge.stop(); workspace.dispose(); await rm(root, { recursive: true, force: true });
  await writeFile('artifacts/agent-panel-terminal-live.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
}
