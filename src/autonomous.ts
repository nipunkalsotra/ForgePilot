import * as vscode from 'vscode';
import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';
import path from 'node:path';
import type { AgentConnection } from './resilience';
import { Workspace } from './workspace';
import { BatchStore, type BatchPatch, type DocumentBaseline } from './batch';
import { EditCoordinator, type EditorHost, type EditorChange } from './coordinator';
import type { ContextPackage } from './context';
import { ForgePilotError } from './log';

export interface ReviewNode { fileId: string; hunkId?: string }
class VsCodeEditorHost implements EditorHost {
  private docs = new Map<string, vscode.TextDocument>();
  constructor(readonly root: string) {}
  uri(relative: string): vscode.Uri { return vscode.Uri.file(path.join(this.root, relative)); }
  async snapshot(relative: string, operation: 'modify' | 'create'): Promise<DocumentBaseline> {
    const uri = this.uri(relative);
    if (operation === 'create') {
      if (vscode.workspace.textDocuments.some(d => !d.isClosed && d.uri.toString() === uri.toString())) throw new ForgePilotError('Creation target already has an editor document.');
      return { content: '', version: 0 };
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    if (doc.isDirty) throw new ForgePilotError(`Save ${relative} before generating or applying a batch.`);
    this.docs.set(relative, doc); return { content: doc.getText(), version: doc.version };
  }
  current(relative: string): DocumentBaseline | undefined {
    const doc = this.docs.get(relative);
    return doc && !doc.isClosed ? { content: doc.getText(), version: doc.version } : undefined;
  }
  async apply(changes: EditorChange[]): Promise<boolean> {
    const edit = new vscode.WorkspaceEdit();
    for (const change of changes) {
      const uri = this.uri(change.path), doc = this.docs.get(change.path);
      if (change.operation === 'delete') edit.deleteFile(uri, { recursive: false, ignoreIfNotExists: false });
      else if (change.operation === 'create') { edit.createFile(uri, { overwrite: false, ignoreIfExists: false }); edit.insert(uri, new vscode.Position(0, 0), change.content); }
      else {
        if (!doc || doc.isClosed) return false;
        edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), change.content);
      }
    }
    const ok = await vscode.workspace.applyEdit(edit, { isRefactoring: false });
    for (const change of changes) {
      if (change.operation === 'delete') this.docs.delete(change.path);
      else if (change.operation === 'create') { try { this.docs.set(change.path, await vscode.workspace.openTextDocument(this.uri(change.path))); } catch { /* Coordinator handles incomplete application. */ } }
    }
    return ok;
  }
}

export class Autonomous implements vscode.TreeDataProvider<ReviewNode>, vscode.TextDocumentContentProvider {
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly textChanged = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChangeTreeData = this.changed.event;
  readonly onDidChange = this.textChanged.event;
  private texts = new Map<string, string>();
  private store?: BatchStore;
  private coordinator?: EditCoordinator;
  private lastApplied?: EditCoordinator;
  private busy = false;
  private epoch = 0;
  private contexts: ContextPackage[] = [];
  private responseTokens = 0;
  private actualUsage?: TrueForgeApi.TurnMetrics;
  private activityOmitted = 0;
  private activity: { tool: string; callId: string; result: unknown; responseBytes: number }[] = [];
  constructor(private readonly connect: () => Promise<{ bridge: AgentConnection; root: string }>, private readonly output: vscode.OutputChannel, private readonly scheme = 'forgepilot-agent') {}
  get current() { return this.store?.current; }
  get evidence() { return structuredClone({ contexts: this.contexts, activity: this.activity, actualTrueForgeTurnMetrics: this.actualUsage, workspaceResponseEstimatedTokens: this.responseTokens, activityOmitted: this.activityOmitted, budgetScope: 'Each context_query package is budgeted; cumulative workspace tool response estimates are shown separately and exclude provider messages/output.' }); }
  getChildren(parent?: ReviewNode): ReviewNode[] {
    const p = this.current;
    if (!p) return [];
    if (!parent) return p.files.map(f => ({ fileId: f.id }));
    return parent.hunkId ? [] : (p.files.find(f => f.id === parent.fileId)?.hunks ?? []).map(h => ({ fileId: parent.fileId, hunkId: h.id }));
  }
  getTreeItem(node: ReviewNode): vscode.TreeItem {
    const f = this.current?.files.find(f => f.id === node.fileId), h = f?.hunks.find(h => h.id === node.hunkId);
    const label = h ? `Line ${h.line + 1} — ${h.decision}` : f ? `${f.path} (${f.operation})` : 'Expired proposal';
    const item = new vscode.TreeItem(label, h ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Expanded);
    item.description = h ? undefined : f ? `${f.hunks.filter(h => h.decision === 'pending').length} pending / ${f.hunks.filter(h => h.decision === 'accepted').length} accepted / ${f.hunks.filter(h => h.decision === 'rejected').length} rejected` : '';
    item.contextValue = this.current?.status === 'staged' && this.current.generationSucceeded && f?.status === 'staged' ? h ? 'forgepilotBatchHunk' : 'forgepilotBatchFile' : 'forgepilotBatchClosed';
    item.iconPath = new vscode.ThemeIcon(h ? h.decision === 'accepted' ? 'check' : h.decision === 'rejected' ? 'close' : 'diff' : 'file');
    item.command = { command: 'forgepilot.batchDiff', title: 'Review diff', arguments: [node] }; return item;
  }
  provideTextDocumentContent(uri: vscode.Uri): string { return this.texts.get(uri.toString()) ?? ''; }
  dispose(): void { this.cancel(); this.changed.dispose(); this.textChanged.dispose(); }
  cancel(): void { this.epoch++; this.store?.cancel(); this.changed.fire(); }
  async run(instruction?: string, approval?: (patch: BatchPatch, signal: AbortSignal) => Promise<boolean>, answer?: (question: { question: string; options: string[] }, signal: AbortSignal) => Promise<string | undefined>): Promise<void> {
    if (this.busy) throw new ForgePilotError('An autonomous operation is already running.');
    this.cancel(); const epoch = this.epoch; this.busy = true;
    this.contexts = []; this.activity = []; this.responseTokens = 0; this.activityOmitted = 0; this.actualUsage = undefined;
    try {
      instruction ??= await vscode.window.showInputBox({ title: 'ForgePilot — Autonomous Agent', prompt: 'Describe the coding task; optional @file:path or @symbol:name references', ignoreFocusOut: true,
        validateInput: text => !text.trim() || text.length > 16000 ? 'Enter 1–16,000 characters.' : undefined });
      if (!instruction?.trim() || epoch !== this.epoch) return;
      const { bridge, root } = await this.connect();
      if (epoch !== this.epoch) return;
      const workspace = await Workspace.create(root), host = new VsCodeEditorHost(root);
      if (epoch !== this.epoch) { workspace.dispose(); return; }
      const store = new BatchStore(workspace, (p, op) => host.snapshot(p, op));
      this.store = store; this.coordinator = new EditCoordinator(host);
      this.output.show(true); this.output.appendLine(`\n[autonomous request; session ${bridge.sessionId}]`);
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'ForgePilot autonomous discovery and proposals', cancellable: true }, async (_, token) => {
        const subscription = token.onCancellationRequested(() => { this.cancel(); void bridge.cancel(); });
        try {
          await bridge.autonomous(store, instruction!, text => this.output.append(text), approval ?? (async (batch, signal) => {
            const decision = await vscode.window.showWarningMessage(`TrueForge requests staging ${batch.files.length} file proposals. Individual hunk review is required before application.`, 'Allow Batch Staging', 'Reject');
            return !signal.aborted && epoch === this.epoch && decision === 'Allow Batch Staging';
          }), observation => {
            if (epoch !== this.epoch) return;
            this.responseTokens += Math.ceil(observation.responseBytes / 3);
            if (observation.context) this.contexts.push(observation.context);
            if (this.activity.length < 150) this.activity.push({ tool: observation.tool, callId: observation.callId, result: observation.result, responseBytes: observation.responseBytes }); else this.activityOmitted++;
            this.output.appendLine(`\n[${observation.tool}; call ${observation.callId}${observation.context ? `; context ~${observation.context.estimatedTokens}/${observation.context.budget} tokens` : ''}]`);
            this.refreshInspector();
          }, answer ?? (async (question, signal) => {
            if (signal.aborted) return undefined;
            const response = question.options.length ? await vscode.window.showQuickPick(question.options, { title: question.question }) : await vscode.window.showInputBox({ title: 'ForgePilot agent question', prompt: question.question, ignoreFocusOut: true });
            return signal.aborted || epoch !== this.epoch ? undefined : response;
          }));
        } finally { this.actualUsage = bridge.lastTurnMetrics; this.refreshInspector(); subscription.dispose(); }
      });
      if (epoch !== this.epoch) { store.cancel(); return; }
      this.changed.fire();
      if (store.current?.files[0]) await this.showDiff({ fileId: store.current.files[0].id });
      await vscode.commands.executeCommand('forgepilot.batchView.focus');
    } catch (error) { this.store?.cancel(); this.changed.fire(); throw error; }
    finally { this.busy = false; }
  }
  review(decision: 'accepted' | 'rejected', node?: ReviewNode, remaining = false): void {
    if (this.busy || !this.store) throw new ForgePilotError('Wait for successful generation before reviewing.');
    this.store.review(decision, node?.fileId, node?.hunkId, remaining); this.changed.fire();
    for (const file of this.current!.files) this.refreshDiff(file.id);
  }
  private diffUri(fileId: string, side: string): vscode.Uri { return vscode.Uri.from({ scheme: this.scheme, path: `/${this.current!.id}/${fileId}/${side}` }); }
  private refreshDiff(fileId: string): void {
    const file = this.current?.files.find(f => f.id === fileId); if (!file) return;
    const original = this.diffUri(fileId, 'original'), proposed = this.diffUri(fileId, 'proposal');
    this.texts.set(original.toString(), file.before); this.texts.set(proposed.toString(), this.store!.render(file, true)); this.textChanged.fire(proposed);
  }
  async showDiff(node: ReviewNode): Promise<void> {
    const file = this.current?.files.find(f => f.id === node.fileId); if (!file) throw new ForgePilotError('Unknown batch file.');
    this.refreshDiff(file.id);
    const line = file.hunks.find(h => h.id === node.hunkId)?.line ?? 0;
    await vscode.commands.executeCommand('vscode.diff', this.diffUri(file.id, 'original'), this.diffUri(file.id, 'proposal'), `ForgePilot: ${file.path}`, { preview: false, selection: new vscode.Range(line, 0, line, 0) });
  }
  async picker(): Promise<void> {
    const choices = this.current?.files.flatMap(f => f.hunks.map(h => ({ label: `${f.path}:${h.line + 1} — ${h.decision}`, node: { fileId: f.id, hunkId: h.id } }))) ?? [];
    const choice = await vscode.window.showQuickPick(choices, { title: 'Review batch hunk' }); if (!choice) return;
    await this.showDiff(choice.node);
    const decision = await vscode.window.showQuickPick(['Accept Hunk', 'Reject Hunk']);
    if (decision) this.review(decision === 'Accept Hunk' ? 'accepted' : 'rejected', choice.node);
  }
  private refreshInspector(): void {
    const uri = vscode.Uri.from({ scheme: this.scheme, path: '/context-inspector' });
    this.texts.set(uri.toString(), JSON.stringify(this.evidence, null, 2)); this.textChanged.fire(uri);
  }
  async inspect(): Promise<void> { this.refreshInspector(); await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.from({ scheme: this.scheme, path: '/context-inspector' })), { preview: false }); }
  async apply(): Promise<void> {
    if (this.busy || !this.store || !this.coordinator) throw new ForgePilotError('No completed batch to apply.');
    this.busy = true; try { await this.coordinator.apply(this.store); this.lastApplied = this.coordinator; } finally { this.busy = false; this.changed.fire(); }
  }
  async undo(): Promise<void> {
    if (this.busy || !this.lastApplied) throw new ForgePilotError('No batch available to undo.');
    this.busy = true; try { await this.lastApplied.undo(); this.store?.cancel(); } finally { this.busy = false; this.changed.fire(); }
  }
}
