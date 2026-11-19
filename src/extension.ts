import * as vscode from 'vscode';
import { classifyFailure } from './failure';
import { ResilientBridge } from './resilience';
import { Autonomous, type ReviewNode } from './autonomous';
import { Editing } from './editing';
import type { Hunk } from './patch';
import { ForgePilotError, jsonLogger, publicError } from './log';
import { AgentPanel } from './panel';

let bridge: ResilientBridge | undefined;
let starting: Promise<void> | undefined;
let closing: Promise<void> | undefined;
let editing: Editing | undefined;
let editingEnabled = false;
let autonomousEnabled = false;
let autonomousController: Autonomous | undefined;
let authorizedRoot: string | undefined;
let output: vscode.OutputChannel;
let logs: vscode.OutputChannel;
let panel: AgentPanel | undefined;

export function activate(context: vscode.ExtensionContext): { editing: Editing; autonomous: Autonomous; panel: AgentPanel; readonly recovery: ResilientBridge['evidence'] } {
  output = vscode.window.createOutputChannel('ForgePilot');
  logs = vscode.window.createOutputChannel('ForgePilot Logs');
  context.subscriptions.push(output, logs);
  const log = jsonLogger(line => logs.appendLine(line));
  const report = (error: unknown) => {
    const message = publicError(error);
    output.appendLine(`\n[error] ${message}`);
    const failure = classifyFailure(error);
    log('operation.failed', { kind: failure.kind });
    if (failure.kind === 'cancelled') return;
    void vscode.window.showErrorMessage(`ForgePilot: ${message}`);
  };
  const command = (name: string, fn: (...args: unknown[]) => Promise<void>) => {
    context.subscriptions.push(vscode.commands.registerCommand(name, async (...args: unknown[]) => {
      try { await fn(...args); } catch (error) { report(error); }
    }));
  };
  const start = async (enableEditing = false, enableAutonomous = false, connectNow = false) => {
    if (!vscode.workspace.isTrusted) throw new ForgePilotError('Trust this workspace before starting ForgePilot.');
    if (closing) throw new ForgePilotError('ForgePilot is stopping. Wait for cleanup to finish.');
    if (starting) return starting;
    if (bridge && (enableEditing && !editingEnabled || enableAutonomous && !autonomousEnabled)) { const previous = bridge; bridge = undefined; await previous.stop(); }
    if (bridge) { output.show(true); return; }
    starting = (async () => {
      const folders = vscode.workspace.workspaceFolders?.filter(f => f.uri.scheme === 'file');
      if (!folders?.length) throw new ForgePilotError('Open a local workspace folder first.');
      const folder = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Authorize one workspace root for bounded tools' });
      if (!folder) return;
      const config = vscode.workspace.getConfiguration('forgepilot');
      const candidate = new ResilientBridge({
        baseUrl: config.get<string>('baseUrl', 'http://localhost:8790'), agentName: config.get<string>('agentName', 'forge-coder'),
        turnTimeoutSeconds: config.get<number>('turnTimeoutSeconds', 180), root: folder.uri.fsPath,
        childPath: context.asAbsolutePath('dist/mcp-child.cjs'), proposals: enableEditing, autonomous: enableAutonomous, contextBudget: config.get<number>('contextBudget', 12000), toolIntervalMs: enableAutonomous ? config.get<number>('autonomousToolIntervalMs', 0) : 0, token: await context.secrets.get('trueforge.token'), log,
        commandTimeoutSeconds: config.get<number>('commandTimeoutSeconds', 120),
        budgetConfig: config.get('tokenBudget', {}),
      }, { enabled: config.get<boolean>('fallbackEnabled', false), agentName: config.get<string>('fallbackAgentName', ''), notify: message => { output.appendLine(`[recovery] ${message}`); void vscode.window.showInformationMessage(`ForgePilot: ${message}`); } });
      output.show(true);
      output.appendLine(`[starting ${enableAutonomous ? 'autonomous' : enableEditing ? 'proposal' : 'read-only'} session for ${folder.name}]`);
      bridge = candidate;
      try {
        const id = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'ForgePilot: connecting to TrueForge', cancellable: true }, async (_, token) => {
          const subscription = token.onCancellationRequested(() => { void candidate.cancel().catch(report); });
          try { return connectNow ? await candidate.start() : undefined; } finally { subscription.dispose(); }
        });
        editingEnabled = enableEditing; autonomousEnabled = enableAutonomous; authorizedRoot = folder.uri.fsPath;
        output.appendLine(id ? `[session ${id}; model ${candidate.modelName}; workspace ${folder.uri.fsPath}]` : '[ready; session setup is included in the cancellable request]');
      } catch (error) { if (bridge === candidate) bridge = undefined; await candidate.stop(); throw error; }
    })();
    try { await starting; } finally { starting = undefined; }
  };
  command('forgepilot.start', async () => { await start(false, false, true); });
  command('forgepilot.ask', async (instruction) => {
    await start();
    if (!bridge) return;
    const selected = bridge;
    const prompt = typeof instruction === 'string' ? instruction : await vscode.window.showInputBox({ title: 'ForgePilot — read-only agent', prompt: 'Ask the saved TrueForge agent to inspect this workspace', ignoreFocusOut: true,
      validateInput: text => text.length > 16_000 ? 'Maximum 16,000 characters.' : undefined });
    if (!prompt?.trim()) return;
    output.show(true);
    output.appendLine('\n[user instruction sent to TrueForge]');
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'ForgePilot is reading your workspace', cancellable: true }, async (_, cancellation) => {
      const subscription = cancellation.onCancellationRequested(() => { void selected.cancel().catch(report); });
      try { await selected.ask(prompt, text => output.append(text)); }
      finally { subscription.dispose(); }
    });
  });
  command('forgepilot.cancel', async () => { editing?.cancel(); await panel?.cancel(); autonomousController?.cancel(); await bridge?.cancel(); });
  command('forgepilot.stop', async () => {
    await stop();
    output.appendLine('[session stopped; local MCP access closed]');
  });
  command('forgepilot.setToken', async () => {
    const token = await vscode.window.showInputBox({ title: 'TrueForge authentication token', prompt: 'Optional OIDC token for TrueForge. Leave empty to remove. Model API keys belong in TrueForge.', password: true, ignoreFocusOut: true });
    if (token === undefined) return;
    if (token.trim()) await context.secrets.store('trueforge.token', token.trim());
    else await context.secrets.delete('trueforge.token');
  });
  const edits = new Editing(async () => {
    await start(true);
    if (!bridge || !authorizedRoot || !editingEnabled) throw new ForgePilotError('An editing session could not be started.');
    return { bridge, root: authorizedRoot };
  }, text => output.append(text));
  editing = edits;
  context.subscriptions.push(edits, vscode.workspace.registerTextDocumentContentProvider('forgepilot-diff', edits),
    vscode.window.createTreeView('forgepilot.reviewView', { treeDataProvider: edits, showCollapseAll: false }));
  command('forgepilot.inlineEdit', async instruction => { await edits.edit(typeof instruction === 'string' ? instruction : undefined); });
  command('forgepilot.review', async () => { await edits.reviewPicker(); });
  command('forgepilot.showHunk', async hunk => { await edits.showDiff(hunk as Hunk | undefined); });
  command('forgepilot.acceptHunk', async hunk => { if (!hunk || typeof hunk !== 'object' || !('id' in hunk)) throw new ForgePilotError('Select a hunk in ForgePilot Patch Review.'); edits.review('accepted', hunk as Hunk); });
  command('forgepilot.rejectHunk', async hunk => { if (!hunk || typeof hunk !== 'object' || !('id' in hunk)) throw new ForgePilotError('Select a hunk in ForgePilot Patch Review.'); edits.review('rejected', hunk as Hunk); });
  command('forgepilot.acceptAll', async () => { edits.review('accepted'); });
  command('forgepilot.rejectAll', async () => { edits.review('rejected'); });
  command('forgepilot.apply', async () => { await edits.apply(); });
  command('forgepilot.undo', async () => { await edits.undo(); });
  const autonomous = new Autonomous(async () => {
    await start(false, true);
    if (!bridge || !authorizedRoot || !autonomousEnabled) throw new ForgePilotError('Autonomous session could not start.');
    return { bridge, root: authorizedRoot };
  }, output);
  autonomousController = autonomous;
  context.subscriptions.push(autonomous, vscode.workspace.registerTextDocumentContentProvider('forgepilot-agent', autonomous),
    vscode.window.createTreeView('forgepilot.batchView', { treeDataProvider: autonomous }));
  const agentPanel = new AgentPanel(context.extensionUri, autonomous, async () => { await bridge?.cancel(); }, stop);
  panel = agentPanel;
  context.subscriptions.push(agentPanel, vscode.window.registerWebviewViewProvider('forgepilot.agentView', agentPanel));
  command('forgepilot.autonomous', async instruction => { await agentPanel.focus(); if (typeof instruction === 'string' && instruction.trim()) await agentPanel.submit(instruction); });
  command('forgepilot.newSession', async () => { await agentPanel.newSession(); await agentPanel.focus(); });
  command('forgepilot.batchDiff', async node => { await autonomous.showDiff(node as ReviewNode); });
  command('forgepilot.batchReview', async () => { await autonomous.picker(); });
  command('forgepilot.batchAccept', async node => { if (!node || typeof node !== 'object' || !('fileId' in node)) throw new ForgePilotError('Select a batch file or hunk.'); autonomous.review('accepted', node as ReviewNode); });
  command('forgepilot.batchReject', async node => { if (!node || typeof node !== 'object' || !('fileId' in node)) throw new ForgePilotError('Select a batch file or hunk.'); autonomous.review('rejected', node as ReviewNode); });
  command('forgepilot.batchAcceptRemaining', async () => { autonomous.review('accepted', undefined, true); });
  command('forgepilot.batchRejectRemaining', async () => { autonomous.review('rejected', undefined, true); });
  command('forgepilot.batchApply', async () => { await autonomous.apply(); });
  command('forgepilot.batchUndo', async () => { await autonomous.undo(); });
  command('forgepilot.contextInspector', async () => { await autonomous.inspect(); });
  command('forgepilot.verificationTerminal', async () => {
    if (!vscode.workspace.isTrusted) throw new ForgePilotError('Trust the workspace first.');
    const root = authorizedRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) throw new ForgePilotError('Open a local workspace first.');
    vscode.window.createTerminal({ name: 'ForgePilot Verification', cwd: root }).show();
  });
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => { void stop().catch(report); }));
  log('extension.activated');
  return { editing: edits, autonomous, panel: agentPanel, get recovery() { return bridge?.evidence ?? []; } };
}

async function stop(): Promise<void> {
  editing?.cancel(); autonomousController?.cancel();
  panel?.state.cancel();
  if (closing) return closing;
  closing = (async () => {
    await bridge?.cancel();
    try { await starting; } catch { /* Startup performs its own rollback. */ }
    const selected = bridge;
    bridge = undefined;
    await selected?.stop();
  })();
  try { await closing; } finally { closing = undefined; }
}

export async function deactivate(): Promise<void> { await stop(); }
