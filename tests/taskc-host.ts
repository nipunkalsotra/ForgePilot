import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { TrueForge } from '@truefoundry/trueforge-sdk';
import type { Editing } from '../src/editing';
import type { RecoveryTrace } from '../src/resilience';
import { publicError } from '../src/log';
import { hash } from '../src/patch';

const run = promisify(execFile);
export async function taskCHost(api: { editing: Editing; readonly recovery: RecoveryTrace[] }): Promise<void> {
  const root = vscode.workspace.workspaceFolders![0]!.uri.fsPath, uri = vscode.Uri.file(path.join(root, 'src/flask/helpers.py'));
  const git = async (...args: string[]) => (await run('git', args, { cwd: root })).stdout.trim();
  assert.equal(await git('rev-parse', 'HEAD'), '22d924701a6ae2e4cd01e9a15bbaf3946094af65'); assert.equal(await git('status', '--porcelain'), '');
  const before = await readFile(uri.fsPath, 'utf8'); const doc = await vscode.workspace.openTextDocument(uri);
  const select = async () => { const editor = await vscode.window.showTextDocument(doc); const start = before.indexOf('def get_debug_flag('), end = before.indexOf('\ndef ', start + 1); assert.ok(end > start && start >= 0); editor.selection = new vscode.Selection(doc.positionAt(start), doc.positionAt(end)); };
  const instruction = "Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.";
  const c = new TrueForge({ baseUrl: 'http://localhost:8790', timeoutInSeconds: 10, maxRetries: 0 });
  const initialConnectors = (await c.mcpServers.list()).data.map(s => s.name).sort();
  const report: Record<string, unknown> = { timestamp: new Date().toISOString(), root, commit: await git('rev-parse', 'HEAD'), instruction, initialHash: hash(before), scenarios: {} };
  const scenarios = report.scenarios as Record<string, unknown>;
  let ticks = 0, maxGap = 0, previous = Date.now();
  const timer = setInterval(() => { const now = Date.now(); ticks++; maxGap = Math.max(maxGap, now - previous); previous = now; }, 25);
  const config = vscode.workspace.getConfiguration('forgepilot');
  const setup = async (primary: string, fallback?: string) => {
    await vscode.commands.executeCommand('forgepilot.stop');
    await config.update('agentName', primary, vscode.ConfigurationTarget.Global);
    await config.update('fallbackEnabled', !!fallback, vscode.ConfigurationTarget.Global);
    await config.update('fallbackAgentName', fallback ?? '', vscode.ConfigurationTarget.Global);
    await config.update('turnTimeoutSeconds', 45, vscode.ConfigurationTarget.Global); await select();
  };
  const unchanged = async () => { assert.equal(doc.getText(), before); assert.equal(await readFile(uri.fsPath, 'utf8'), before); assert.equal(await git('status', '--porcelain'), ''); };
  try {
    for (const [scenario, agent, expected] of [['A-invalid-key', process.env.FORGEPILOT_TASKC_AUTH!, 'credentials'], ['B-unreachable', process.env.FORGEPILOT_TASKC_NET!, 'network'], ['D-both-unavailable', process.env.FORGEPILOT_TASKC_AUTH!, 'network']] as const) {
      await setup(agent, scenario.startsWith('D') ? process.env.FORGEPILOT_TASKC_NET! : undefined);
      const started = Date.now(), initialTicks = ticks; let failure = '';
      // Exercise the contributed command's actual sanitized error notification path.
      await vscode.commands.executeCommand('forgepilot.inlineEdit', instruction);
      failure = api.recovery.at(-1)?.failure ?? ''; assert.equal(failure, expected);
      await unchanged(); const trace = api.recovery;
      assert.equal(trace.length, scenario.startsWith('D') ? 2 : 1); assert.ok(ticks > initialTicks); assert.ok(Date.now() - started < 90000);
      scenarios[scenario] = { result: 'PASS', elapsedMs: Date.now() - started, eventLoopTicks: ticks - initialTicks, failure, trace, failurePresentation: 'Production inline command error handler invoked; physical notification rendering not manually inspected', workspaceUnchanged: true };
      await vscode.commands.executeCommand('forgepilot.stop'); assert.deepEqual((await c.mcpServers.list()).data.map(s => s.name).sort(), initialConnectors);
    }
    if (process.env.FORGEPILOT_TASKC_UI_ONLY === '1') { assert.ok(maxGap < 1000); report.result = 'PASS'; return; }
    await setup(process.env.FORGEPILOT_TASKC_AUTH!, 'forge-coder');
    let approvals = 0;
    await api.editing.edit(instruction, async (_patch, signal) => { approvals++; await unchanged();
      const failed = api.recovery[0]!; assert.equal(failed.outcome, 'failed');
      assert.ok(!(await c.mcpServers.list()).data.some(s => s.name === failed.connector), 'Failed generation connector must be revoked before fallback approval');
      return !signal.aborted; });
    assert.equal(approvals, 1); await unchanged();
    const trace = api.recovery; assert.equal(trace.length, 2); assert.equal(trace[0]?.failure, 'credentials'); assert.equal(trace[1]?.outcome, 'succeeded'); assert.notEqual(trace[0]?.sessionId, trace[1]?.sessionId);
    const proposal = api.editing.current!; assert.ok(proposal.hunks.length); assert.ok(proposal.hunks.every(h => h.decision === 'pending'));
    const diffTabs = vscode.window.tabGroups.all.flatMap(g => g.tabs).filter(t => t.input instanceof vscode.TabInputTextDiff && t.input.original.path.includes(proposal.id)); assert.ok(diffTabs.length);
    const native = diffTabs[0]!.input as vscode.TabInputTextDiff;
    assert.equal((await vscode.workspace.openTextDocument(native.original)).getText(), before);
    assert.equal((await vscode.workspace.openTextDocument(native.modified)).getText(), proposal.proposed);
    scenarios['C-automatic-fallback'] = { result: 'PASS', trace, approvals, hunkCount: proposal.hunks.length, nativeDiffTabs: diffTabs.length, workspaceUnchanged: true };
    // Beyond official Task C: exercise approved application, behavior and guarded undo.
    report.hunkDecisions = proposal.hunks.map(h => ({ id: h.id, decision: 'accepted', driver: 'explicit automated VS Code command' }));
    for (const hunk of proposal.hunks) await vscode.commands.executeCommand('forgepilot.acceptHunk', hunk);
    await api.editing.apply(); await doc.save();
    const python = process.env.FORGEPILOT_FLASK_PYTHON ?? 'python3';
    const behavior = await run(python, ['-c', `import os,json,flask\nfrom flask.helpers import get_debug_flag\nassert flask.__file__.startswith(${JSON.stringify(root)})\nexpected={'off':False,'OFF':False,'n':False,'N':False,'':False,'0':False,'false':False,'FALSE':False,'FaLsE':False,'no':False,'NO':False,'1':True,'true':True,'yes':True,'on':True,'random':True}\nfor value,wanted in expected.items():\n os.environ['FLASK_DEBUG']=value\n assert get_debug_flag() is wanted,value\nos.environ.pop('FLASK_DEBUG',None)\nassert get_debug_flag() is False\nprint(json.dumps(expected))`], { cwd: root, env: { ...process.env, PYTHONPATH: path.join(root, 'src') }, timeout: 30000 });
    report.appliedDiff = await git('diff', '--', 'src/flask/helpers.py'); report.behavior = JSON.parse(behavior.stdout);
    const pytest = await run(python, ['-m', 'pytest', 'tests/test_helpers.py', '-q'], { cwd: root, env: { ...process.env, PYTHONPATH: path.join(root, 'src') }, timeout: 60000 });
    report.pytest = { exitCode: 0, stdout: pytest.stdout, stderr: pytest.stderr };
    await api.editing.undo(); await doc.save(); await unchanged(); report.undo = 'PASS';
    // Cancel after successful staging: it must cease being reviewable without another provider transition.
    await setup(process.env.FORGEPILOT_TASKC_AUTH!, 'forge-coder');
    await api.editing.edit(instruction, async () => true); await vscode.commands.executeCommand('forgepilot.cancel');
    await assert.rejects(api.editing.apply()); await unchanged(); scenarios['E-cancel-staged'] = { result: 'PASS', trace: api.recovery };
    const history = [];
    for (const item of trace) if (item.sessionId) {
      const events = []; for await (const { event } of await c.sessions.listEvents(item.sessionId)) events.push({ type: event.type, id: event.id, ...(event.type === 'model.message' ? { toolCalls: event.toolCalls?.map(call => ({ id: call.id, name: call.function.name })) } : {}), ...(event.type === 'user.tool_approval' || event.type === 'tool.response' ? { toolCallId: event.toolCallId } : {}), ...(event.type === 'tool.approval_required' ? { toolCalls: event.toolCalls } : {}), ...(event.type === 'turn.done' ? { status: event.state.status, metrics: event.state.metrics } : {}) });
      history.push({ ...item, events });
    }
    report.history = history; maxGap = Math.max(maxGap, Date.now() - previous);
    assert.ok(maxGap < 1000, 'Extension-host event loop must not stall for a second in the acceptance test');
    report.result = 'PASS';
  } catch (error) { report.result = 'FAIL'; report.error = publicError(error); report.lastTrace = api.recovery; throw error; }
  finally {
    clearInterval(timer); report.eventLoop = { ticks, maximumObservedGapMs: maxGap, measurement: '25ms extension-host timer, no physical UI clicks' };
    await vscode.commands.executeCommand('forgepilot.stop');
    report.cleanup = JSON.stringify((await c.mcpServers.list()).data.map(s => s.name).sort()) === JSON.stringify(initialConnectors) ? 'PASS' : 'FAIL';
    report.finalGitStatus = await git('status', '--porcelain');
    const prefix = process.env.FORGEPILOT_TASKC_REPORT_PREFIX ?? 'phase4-taskc'; assert.match(prefix, /^[a-z0-9-]{1,80}$/);
    await writeFile(path.join(process.env.FORGEPILOT_ARTIFACTS!, `${prefix}${process.env.FORGEPILOT_TASKC_UI_ONLY === '1' ? '-ui' : ''}.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ result: report.result, scenarios, cleanup: report.cleanup, finalGitStatus: report.finalGitStatus }));
  }
}
