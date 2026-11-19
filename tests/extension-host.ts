import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { resilienceHostTests } from './resilience-host';
import { batchHostTests } from './batch-host';
import { taskCHost } from './taskc-host';
import type { RecoveryTrace } from '../src/resilience';
import { taskBHost } from './autonomous-host';
import { autonomousLiveHost } from './autonomous-live-host';
import type { Autonomous } from '../src/autonomous';
import { editingHostTests, flaskHostTest } from './editing-host';
import type { Editing } from '../src/editing';
import { TrueForge } from '@truefoundry/trueforge-sdk';

/** Runs inside a genuine VS Code Extension Development Host, not a VS Code mock. */
export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('nipunkalsotra.forgepilot');
  assert.ok(extension, 'ForgePilot must be discovered by VS Code');
  assert.equal(extension.extensionPath, process.env.FORGEPILOT_EXPECTED_EXTENSION_PATH);
  const expected = JSON.parse(process.env.FORGEPILOT_EXPECTED_BUNDLES!) as Record<string, string>;
  for (const name of ['extension.cjs', 'mcp-child.cjs']) assert.equal(
    createHash('sha256').update(await readFile(path.join(extension.extensionPath, 'dist', name))).digest('hex'), expected[name],
    `Loaded ${name} differs from the current build. Install the VSIX using the code CLI wrapper, then reload.`);
  const manifest = extension.packageJSON as { main: string; contributes: { commands: { command: string; title: string }[] } };
  assert.match(await readFile(path.join(extension.extensionPath, manifest.main), 'utf8'), /forgepilot\.autonomous/);
  const contributed = manifest.contributes.commands;
  for (const item of contributed) {
    assert.match(item.title, /^ForgePilot: /);
  }
  // Exercise VS Code's contributed-command activation rather than activating by hand.
  await vscode.commands.executeCommand('forgepilot.contextInspector');
  assert.ok(extension.isActive);
  const commands = await vscode.commands.getCommands(true);
  for (const item of contributed) assert.ok(commands.includes(item.command), `Missing registration ${item.command}`);
  // Empty explicit input exercises the autonomous command without a dialog or model request.
  await vscode.commands.executeCommand('forgepilot.autonomous', '');
  if (process.env.TRUEFORGE_AGENT_NAME) await vscode.workspace.getConfiguration('forgepilot').update('agentName', process.env.TRUEFORGE_AGENT_NAME, vscode.ConfigurationTarget.Global);
  await vscode.commands.executeCommand('forgepilot.cancel');
  await vscode.commands.executeCommand('forgepilot.stop');
  console.log(`PASS: Correct ForgePilot bundle loaded, command-triggered activation, all ${contributed.length} palette contributions/registrations, autonomous invocation, idle cleanup.`);
  if (process.env.FORGEPILOT_TASKC === '1') { await taskCHost(extension.exports as { editing: Editing; readonly recovery: RecoveryTrace[] }); return; }
  if (process.env.FORGEPILOT_AUTONOMOUS_LIVE === '1') { await autonomousLiveHost((extension.exports as { autonomous: Autonomous }).autonomous); return; }
  if (process.env.FORGEPILOT_PHASE3_FLASK === '1') {
    try { await taskBHost((extension.exports as { autonomous: Autonomous }).autonomous); }
    finally { await vscode.commands.executeCommand('forgepilot.stop'); }
    return;
  }
  if (process.env.FORGEPILOT_PHASE2_FLASK === '1') {
    try { await flaskHostTest((extension.exports as { editing: Editing }).editing); }
    finally { await vscode.commands.executeCommand('forgepilot.stop'); }
    return;
  }
  if (process.env.FORGEPILOT_EXTENSION_LIVE !== '1') { await editingHostTests(); await batchHostTests(); await resilienceHostTests(); return; }
  const client = new TrueForge({ baseUrl: 'http://localhost:8790', maxRetries: 0, timeoutInSeconds: 10 });
  const oldSessions = new Set((await client.sessions.list()).data.map(s => s.id));
  const connectorsBefore = (await client.mcpServers.list()).data.map(s => s.name).sort();
  const root = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
  const before = await readFile(path.join(root, 'inspection.txt'), 'utf8');
  try {
    await vscode.commands.executeCommand('forgepilot.start');
    const session = (await client.sessions.list()).data.find(s => !oldSessions.has(s.id) && s.metadata.client === 'ForgePilot');
    assert.ok(session, 'Start command must create a real TrueForge session');
    await vscode.commands.executeCommand('forgepilot.ask', 'Use MCP list_files to discover workspace files, then read_file to read inspection.txt. Report its exact contents. Do not modify files.');
    const history = await client.sessions.listEvents(session.id);
    let hasRead = false;
    let hasMarker = false;
    for await (const { event } of history) {
      if (event.type === 'model.message' && event.toolCalls?.some(c => c.toolInfo.type === 'mcp' && c.toolInfo.name === 'read_file')) hasRead = true;
      if (event.type === 'tool.response' && event.content.includes(process.env.FORGEPILOT_TEST_MARKER!)) hasMarker = true;
    }
    assert.ok(hasRead && hasMarker, 'Actual extension commands must produce persisted MCP calls with the real workspace marker');
    assert.equal(await readFile(path.join(root, 'inspection.txt'), 'utf8'), before);
    assert.deepEqual(await readdir(root), ['inspection.txt']);
    console.log(`PASS: Extension → SDK → saved forge-coder → companion MCP → file → persisted history. Session ${session.id}`);
  } finally {
    await vscode.commands.executeCommand('forgepilot.stop');
    assert.deepEqual((await client.mcpServers.list()).data.map(s => s.name).sort(), connectorsBefore, 'Stop command must remove its temporary connector');
  }
}
