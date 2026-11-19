import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AgentPanel } from '../src/panel';
import type { Autonomous } from '../src/autonomous';
import { terminalWireFixture } from './terminal-wire-fixture';
import { TrueForge } from '@truefoundry/trueforge-sdk';
import type { AutonomousPresentation } from '../src/autonomous';
import { RequestFailure } from '../src/failure';

/** Real extension-host / native editor APIs; deterministic SDK fixture, not model evidence. */
export async function panelHostTests(panel: AgentPanel, autonomous: Autonomous): Promise<void> {
  const root = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
  const fixture = await terminalWireFixture('correct', root), config = vscode.workspace.getConfiguration('forgepilot');
  const base = config.get('baseUrl'), agent = config.get('agentName');
  const run = autonomous.run.bind(autonomous); let commandApprovals = 0, stagingApprovals = 0;
  autonomous.run = (instruction, _, answer, presentation) => run(instruction, async () => { stagingApprovals++; return true; }, answer,
    { ...presentation, approveCommand: async () => { commandApprovals++; return true; } });
  try {
    await config.update('baseUrl', fixture.options.baseUrl, vscode.ConfigurationTarget.Global);
    await config.update('agentName', 'primary', vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('forgepilot.autonomous', '');
    for (let i = 0; i < 50 && !panel.resolved; i++) await delay(100);
    assert.equal(panel.resolved, true, 'VS Code must resolve the actual registered WebviewView');
    // Observe the REAL shipped script's ready message after a supported HTML reload;
    // direct controller calls below are not substituted for proving renderer startup.
    const originalReceive = panel.receive; let rendererReady = false;
    panel.receive = async input => { if (input && typeof input === 'object' && 'type' in input && input.type === 'ready') rendererReady = true; await originalReceive.call(panel, input); };
    try {
      const view = (panel as unknown as { view: vscode.WebviewView }).view;
      view.webview.html += '<!-- extension-host renderer readiness check -->';
      for (let i = 0; i < 50 && !rendererReady; i++) await delay(100);
      assert.equal(rendererReady, true, 'The actual local script must load under CSP and send its ready handshake');
    } finally { panel.receive = originalReceive; }
    const old = panel.state.sessionId;
    await panel.receive({ type: 'submit', sessionId: old, requestId: panel.state.requestId, text: 'Use failing verification feedback and propose the normal correction' });
    assert.equal(panel.state.state, 'completed', panel.state.error);
    assert.ok(panel.state.usage && panel.state.usage.toolCalls >= 4, 'Real panel must receive correlated resource accounting');
    assert.equal(panel.state.usage.providerQuota, 'UNKNOWN');
    assert.equal(commandApprovals, 1); assert.equal(stagingApprovals, 1);
    assert.ok(panel.state.tools.some(t => t.name === 'run_command' && t.phase === 'failed' && t.detail.includes('Exit: 7')));
    assert.equal(panel.state.proposal?.status, 'staged'); assert.equal(panel.state.proposal?.files[0]?.pending, 1);
    assert.ok(panel.state.messages.some(m => m.role === 'assistant' && m.text.includes('actual failure feedback')));
    assert.ok(vscode.window.tabGroups.all.some(g => g.tabs.some(t => t.input instanceof vscode.TabInputTextDiff)));
    await panel.receive({ type: 'context', sessionId: old, requestId: panel.state.requestId });
    assert.ok(vscode.workspace.textDocuments.some(d => d.uri.path === '/context-inspector'));
    await assert.rejects(panel.receive({ type: 'apply', sessionId: old, requestId: panel.state.requestId }), /every hunk/);
    assert.equal(await readFile(path.join(root, 'wire.ts'), 'utf8'), fixture.content, 'Undecided hunks cannot be applied');
    // Native hunk decisions are still required after the refused Apply.
    panel.state.status('completed'); panel.state.proposalChanged(autonomous.current);
    autonomous.review('accepted');
    await panel.receive({ type: 'diff', sessionId: old, requestId: panel.state.requestId, fileId: autonomous.current!.files[0]!.id });
    await panel.receive({ type: 'apply', sessionId: old, requestId: panel.state.requestId });
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, 'wire.ts')));
    assert.equal(document.getText(), 'const value = 2;\n'); assert.equal(panel.state.proposal?.status, 'applied'); await document.save();
    await panel.receive({ type: 'undo', sessionId: old, requestId: panel.state.requestId }); assert.equal(document.getText(), fixture.content); assert.equal(panel.state.proposal, null, 'Undone batches must not remain labelled applied'); await document.save();
    await panel.newSession(); assert.notEqual(panel.state.sessionId, old);
    await panel.receive({ type: 'submit', sessionId: old, requestId: null, text: 'stale message' }); assert.equal(panel.state.state, 'idle');
    await panel.receive({ type: 'submit', sessionId: panel.state.sessionId, requestId: null, text: 'malformed', approved: true }); assert.equal(panel.state.state, 'idle');
    let hooks!: AutonomousPresentation, release!: () => void;
    autonomous.run = async (_instruction, _approval, _answer, presentation) => { hooks = presentation!; await new Promise<void>(resolve => { release = resolve; }); };
    const pending = panel.submit('cancellable presentation fixture');
    const cancelling = panel.cancel();
    hooks.stream!({ type: 'model.message.delta', id: 'late', threadId: 'main', createdAt: '', content: 'stale malicious response' }, { sessionId: 'late-session', modelName: 'late-model' });
    release(); await pending; await cancelling;
    assert.equal(panel.state.state, 'cancelled'); assert.equal(panel.state.messages.some(m => m.text.includes('stale malicious')), false);
    autonomous.run = async () => { throw new RequestFailure('cancelled', 'local'); };
    await panel.submit('Native progress cancellation fixture'); assert.equal(panel.state.state, 'cancelled', 'Backend/native progress cancellation is not labelled failed'); assert.equal(panel.state.requestId, null);
    const temporary = new AgentPanel(vscode.Uri.file(root), autonomous, async () => {}, async () => {}); temporary.dispose();
    await temporary.receive({ type: 'submit', sessionId: temporary.state.sessionId, requestId: temporary.state.requestId, text: 'after disposal' }); assert.equal(temporary.state.messages.length, 0);
    console.log('PASS: Actual Agent WebviewView registration/resolution, message-route prompt → SDK → real MCP failed command → fresh retained-draft staging → native diff → hunk decision → guarded apply/undo, context access, stale/malformed message refusal. Approvals automated; no physical GUI clicks.');
  } finally {
    autonomous.run = run; await vscode.commands.executeCommand('forgepilot.stop');
    await config.update('baseUrl', base, vscode.ConfigurationTarget.Global); await config.update('agentName', agent, vscode.ConfigurationTarget.Global);
    await fixture.close();
  }
}

/** Real saved-agent inference via the ACTUAL panel submission route. Bounded Git status only. */
export async function panelLiveHost(panel: AgentPanel, autonomous: Autonomous): Promise<void> {
  const root = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
  await promisify(execFile)('/usr/bin/git', ['init', '-q', root]);
  await writeFile(path.join(root, 'panel-inspection.txt'), 'live-panel-verification\n');
  const run = autonomous.run.bind(autonomous); const approvals: object[] = [], attempts: object[] = [];
  const client = new TrueForge({ baseUrl: 'http://localhost:8790', maxRetries: 0 });
  const beforeConnectors = (await client.mcpServers.list()).data.map(c => c.name).sort();
  let decision: 'approve' | 'deny' | 'cancel' = 'approve';
  autonomous.run = (instruction, approve, answer, presentation) => run(instruction, approve, answer, { ...presentation,
    approveCommand: async (plan, correlation, signal) => {
      assert.equal(plan.request.operation, 'git_status'); approvals.push({ decision, ...correlation, command: plan.summary });
      if (decision === 'cancel') { setTimeout(() => { void panel.cancel(); }, 0); await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); return true; }
      return decision === 'approve';
    } });
  const evidence: Record<string, unknown> = { kind: 'genuine saved-agent inference through installed Agent Panel controller', physicalClicks: 'NOT TESTED', attempts, approvals };
  try {
    for (const choice of ['approve', 'deny', 'cancel'] as const) {
      decision = choice; await panel.newSession(); await vscode.commands.executeCommand('forgepilot.autonomous', '');
      await panel.receive({ type: 'submit', sessionId: panel.state.sessionId, requestId: panel.state.requestId,
        text: 'Read-only request. Use context_query once, then run_command EXACTLY ONCE with operation=git_status and timeoutSeconds=10. After the command result, including developer denial, report the actual result in one sentence. Never retry denied commands. No drafts or proposal.' });
      const history: object[] = [];
      if (panel.state.backendSession) for await (const { event } of await client.sessions.listEvents(panel.state.backendSession)) {
        if (event.type === 'tool.approval_required') history.push({ type: event.type, id: event.id, refs: event.toolCalls });
        if (event.type === 'user.tool_approval') history.push({ type: event.type, id: event.id, callId: event.toolCallId, approval: event.approval });
        if (event.type === 'tool.response') { try { const result = JSON.parse(event.content); if (result.kind === 'forgepilot.command') history.push({ type: event.type, id: event.id, callId: event.toolCallId, result }); } catch { /* Denial text is not presented as an execution result. */ } }
      }
      const attempt = { decision, sessionId: panel.state.backendSession, model: panel.state.model, state: panel.state.state, error: panel.state.error, tools: panel.state.tools, history };
      attempts.push(attempt);
      assert.equal(panel.state.state, choice === 'cancel' ? 'cancelled' : 'completed', panel.state.error);
      assert.equal(approvals.length, attempts.length);
      if (choice === 'approve') {
        assert.ok(panel.state.tools.some(t => t.name === 'run_command' && t.phase === 'completed' && t.detail.includes('Exit: 0')));
        assert.ok(panel.state.messages.some(m => m.role === 'assistant' && m.text.length));
      } else assert.equal(panel.state.tools.some(t => t.name === 'run_command' && t.phase === 'completed'), false);
      console.log(`PASS: Installed Agent Panel genuine TrueForge ${choice} Git-status check. ${panel.state.backendSession}`);
    }
    evidence.result = 'PASS';
  } catch (error) { evidence.result = 'CONDITIONAL'; evidence.error = error instanceof Error ? error.message : 'Verification failed'; throw error; }
  finally {
    autonomous.run = run; await vscode.commands.executeCommand('forgepilot.stop');
    assert.deepEqual((await client.mcpServers.list()).data.map(c => c.name).sort(), beforeConnectors); evidence.connectorCleanup = 'PASS';
    await writeFile(path.join(process.env.FORGEPILOT_ARTIFACTS!, 'agent-panel-installed-live.json'), JSON.stringify(evidence, null, 2));
  }
}

/** One bounded genuine failure → model correction → separate staging/native hunk review. */
export async function panelCorrectionLiveHost(panel: AgentPanel, autonomous: Autonomous): Promise<void> {
  const root = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
  const original = 'exports.calculate = function calculate() { return 1; };\n';
  await writeFile(path.join(root, 'calculator.cjs'), original);
  await writeFile(path.join(root, 'verify.cjs'), "const assert = require('node:assert/strict'); const {calculate} = require('./calculator.cjs'); assert.equal(calculate(), 2); console.log('fixture validation passed');\n");
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node verify.cjs' } }));
  const run = autonomous.run.bind(autonomous); const commands: object[] = [], stages: object[] = [];
  let failedResultObserved = false;
  const evidence: Record<string, unknown> = { kind: 'genuine installed panel failure-feedback correction; automated acceptance approval/hunk driver', physicalClicks: 'NOT TESTED', commands, stages };
  autonomous.run = (instruction, _approve, answer, presentation) => run(instruction, async (patch, signal) => {
    assert.equal(signal.aborted, false); assert.equal(failedResultObserved, true, 'Actual command failure must precede staging approval');
    assert.equal(patch.files.length, 1); assert.equal(patch.files[0]!.path, 'calculator.cjs');
    assert.equal(await readFile(path.join(root, 'calculator.cjs'), 'utf8'), original);
    stages.push({ paths: patch.files.map(f => f.path), decision: 'allow staging only' }); return true;
  }, answer, { ...presentation, observe: event => {
    presentation?.observe?.(event);
    if (event.tool === 'run_command') { const result = event.result as { exitCode?: number }; failedResultObserved = typeof result.exitCode === 'number' && result.exitCode !== 0; evidence.commandResult = event.result; }
  }, approveCommand: async (plan, correlation) => {
    assert.equal(plan.request.operation, 'npm_test'); assert.equal(plan.request.script, 'test'); assert.equal(commands.length, 0, 'One bounded verification request only');
    commands.push({ ...correlation, command: plan.summary }); return true;
  } });
  try {
    await panel.newSession(); await vscode.commands.executeCommand('forgepilot.autonomous', '');
    await panel.receive({ type: 'submit', sessionId: panel.state.sessionId, requestId: panel.state.requestId,
      text: 'Fix the calculator so calculate() returns 2. Discover the relevant files with context_query. FIRST call run_command once with operation=npm_test, script=test, timeoutSeconds=10 to observe the actual failing verification. Use that failure feedback to correct ONLY the calculator implementation through retained draft_file/check_drafts/propose_drafts. Do not change package.json or the verifier. Request fresh staging permission and finish after successful staging; do not run another command or claim application.' });
    evidence.sessionId = panel.state.backendSession; evidence.model = panel.state.model; evidence.panelState = panel.state.state; evidence.tools = panel.state.tools;
    assert.equal(panel.state.state, 'completed', panel.state.error); assert.equal(commands.length, 1); assert.equal(stages.length, 1);
    assert.equal(autonomous.current?.generationSucceeded, true); assert.equal(panel.state.proposal?.status, 'staged');
    assert.ok(autonomous.current!.files.every(f => f.hunks.every(h => h.decision === 'pending')));
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, 'calculator.cjs')));
    assert.equal(document.getText(), original); await assert.rejects(autonomous.apply(), /every hunk/);
    await autonomous.showDiff({ fileId: autonomous.current!.files[0]!.id });
    autonomous.review('accepted'); await autonomous.apply(); await document.save();
    const checked = await promisify(execFile)('/usr/bin/node', ['verify.cjs'], { cwd: root, timeout: 10000, env: { PATH: '/usr/bin:/bin' } });
    assert.match(checked.stdout, /fixture validation passed/); evidence.developerVerification = { exitCode: 0, stdout: checked.stdout, stderr: checked.stderr };
    evidence.applied = 'explicit automated native hunk acceptance + guarded coordinator';
    await autonomous.undo(); await document.save(); assert.equal(document.getText(), original); assert.equal(panel.state.proposal, null); evidence.guardedUndo = 'PASS';
    const client = new TrueForge({ baseUrl: 'http://localhost:8790', maxRetries: 0 }); const history: object[] = [];
    for await (const { event } of await client.sessions.listEvents(panel.state.backendSession)) {
      if (event.type === 'tool.approval_required') history.push({ type: event.type, id: event.id, refs: event.toolCalls });
      if (event.type === 'user.tool_approval') history.push({ type: event.type, id: event.id, callId: event.toolCallId, approval: event.approval });
    }
    evidence.history = history; evidence.result = 'PASS';
    console.log(`PASS: Genuine installed panel failed npm command → model retained-draft correction → fresh SDK staging → native pending hunks → explicit accept/apply → actual verification passed → guarded undo. ${panel.state.backendSession}`);
  } catch (error) { evidence.result = 'CONDITIONAL'; evidence.error = error instanceof Error ? error.message : 'Correction check failed'; throw error; }
  finally { autonomous.run = run; await vscode.commands.executeCommand('forgepilot.stop'); await writeFile(path.join(process.env.FORGEPILOT_ARTIFACTS!, 'agent-panel-correction-live.json'), JSON.stringify(evidence, null, 2)); }
}
