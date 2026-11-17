import * as vscode from 'vscode';
import { Bridge } from './bridge';
import { ForgePilotError, jsonLogger, publicError } from './log';

let bridge: Bridge | undefined;
let starting: Promise<void> | undefined;
let closing: Promise<void> | undefined;
let output: vscode.OutputChannel;
let logs: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('ForgePilot');
  logs = vscode.window.createOutputChannel('ForgePilot Logs');
  context.subscriptions.push(output, logs);
  const log = jsonLogger(line => logs.appendLine(line));
  const report = (error: unknown) => {
    const message = publicError(error);
    output.appendLine(`\n[error] ${message}`);
    log('operation.failed');
    void vscode.window.showErrorMessage(`ForgePilot: ${message}`);
  };
  const command = (name: string, fn: (...args: unknown[]) => Promise<void>) => {
    context.subscriptions.push(vscode.commands.registerCommand(name, async (...args: unknown[]) => {
      try { await fn(...args); } catch (error) { report(error); }
    }));
  };
  const start = async () => {
    if (!vscode.workspace.isTrusted) throw new ForgePilotError('Trust this workspace before starting ForgePilot.');
    if (closing) throw new ForgePilotError('ForgePilot is stopping. Wait for cleanup to finish.');
    if (starting) return starting;
    if (bridge) { output.show(true); return; }
    starting = (async () => {
      const folders = vscode.workspace.workspaceFolders?.filter(f => f.uri.scheme === 'file');
      if (!folders?.length) throw new ForgePilotError('Open a local workspace folder first.');
      const folder = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Authorize one workspace root for read-only tools' });
      if (!folder) return;
      const config = vscode.workspace.getConfiguration('forgepilot');
      const candidate = new Bridge({
        baseUrl: config.get<string>('baseUrl', 'http://localhost:8790'), agentName: config.get<string>('agentName', 'forge-coder'),
        turnTimeoutSeconds: config.get<number>('turnTimeoutSeconds', 180), root: folder.uri.fsPath,
        childPath: context.asAbsolutePath('dist/mcp-child.cjs'), token: await context.secrets.get('trueforge.token'), log,
      });
      output.show(true);
      output.appendLine(`[starting read-only session for ${folder.name}]`);
      const id = await candidate.start();
      bridge = candidate;
      output.appendLine(`[session ${id}; model ${candidate.modelName}; workspace ${folder.uri.fsPath}]`);
    })();
    try { await starting; } finally { starting = undefined; }
  };
  command('forgepilot.start', start);
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
  command('forgepilot.cancel', async () => { await bridge?.cancel(); });
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
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => { void stop().catch(report); }));
  log('extension.activated');
}

async function stop(): Promise<void> {
  if (closing) return closing;
  closing = (async () => {
    try { await starting; } catch { /* Startup performs its own rollback. */ }
    const selected = bridge;
    bridge = undefined;
    await selected?.stop();
  })();
  try { await closing; } finally { closing = undefined; }
}

export async function deactivate(): Promise<void> { await stop(); }
