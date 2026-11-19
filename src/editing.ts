import * as vscode from 'vscode';
import path from 'node:path';
import type { AgentConnection } from './resilience';
import { Workspace } from './workspace';
import { PatchStore, captureSelection, hash, type Hunk, type Patch, type Proposal } from './patch';
import { ForgePilotError } from './log';

interface UndoRecord { uri: vscode.Uri; document: vscode.TextDocument; version: number; before: string; after: string; workspace: Workspace; relative: string; diskHash: string }
export class Editing implements vscode.TreeDataProvider<Hunk>, vscode.TextDocumentContentProvider {
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly textChanged = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChangeTreeData = this.changed.event;
  readonly onDidChange = this.textChanged.event;
  private texts = new Map<string, string>();
  private store?: PatchStore;
  private document?: vscode.TextDocument;
  private undoRecord?: UndoRecord;
  private busy = false;
  private generation = 0;
  private applying = false;
  constructor(private readonly connect: () => Promise<{ bridge: AgentConnection; root: string }>, private readonly write: (text: string) => void, private readonly scheme = 'forgepilot-diff') {}
  get current(): Proposal | undefined { return this.store?.current; }
  getChildren(): Hunk[] { return this.current?.hunks ?? []; }
  getTreeItem(h: Hunk): vscode.TreeItem {
    const item = new vscode.TreeItem(`Line ${h.line + 1} — ${h.decision}`);
    item.description = `${h.end - h.start} characters → ${h.newText.length}`;
    item.contextValue = this.current?.status === 'staged' ? 'forgepilotHunk' : 'forgepilotClosedHunk';
    item.iconPath = new vscode.ThemeIcon(h.decision === 'accepted' ? 'check' : h.decision === 'rejected' ? 'close' : 'diff');
    item.command = { command: 'forgepilot.showHunk', title: 'Show hunk', arguments: [h] };
    return item;
  }
  provideTextDocumentContent(uri: vscode.Uri): string { return this.texts.get(uri.toString()) ?? ''; }
  dispose(): void { this.cancel(); this.changed.dispose(); this.textChanged.dispose(); }
  cancel(): void { this.generation++; this.store?.cancel(); this.changed.fire(); }
  async edit(instruction?: string, approval?: (patch: Patch, signal: AbortSignal) => Promise<boolean>): Promise<void> {
    if (this.busy || this.applying) throw new ForgePilotError('An inline operation is already running.');
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file' || editor.document.isClosed) throw new ForgePilotError('Open a local text editor and select code first.');
    const document = editor.document;
    if (document.isDirty) throw new ForgePilotError('Save the document before requesting an inline edit.');
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!folder) throw new ForgePilotError('Selected document is outside the workspace.');
    const snapshot = captureSelection({ path: path.relative(folder.uri.fsPath, document.uri.fsPath).split(path.sep).join('/'), version: document.version,
      content: document.getText(), start: document.offsetAt(editor.selection.start), end: document.offsetAt(editor.selection.end) });
    this.cancel();
    const generation = this.generation;
    this.busy = true;
    try {
      instruction ??= await vscode.window.showInputBox({ title: 'ForgePilot — inline edit', prompt: 'Describe the modification to the selected code', ignoreFocusOut: true,
        validateInput: text => !text.trim() || text.length > 16_000 ? 'Enter 1–16,000 characters.' : undefined });
      if (!instruction?.trim() || generation !== this.generation) return;
      const { bridge, root } = await this.connect();
      if (generation !== this.generation) return;
      if (path.resolve(root) !== path.resolve(folder.uri.fsPath)) throw new ForgePilotError('Select a document in the authorized workspace root.');
      const workspace = await Workspace.create(root);
      if ((await workspace.readFile(snapshot.path)).content !== snapshot.content) throw new ForgePilotError('Document or file changed. Save and select again.');
      const store = new PatchStore(workspace, snapshot);
      this.store = store; this.document = document;
      if (generation !== this.generation) { store.cancel(); return; }
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'ForgePilot: generating proposed changes', cancellable: true }, async (_, token) => {
        const sub = token.onCancellationRequested(() => { this.cancel(); void bridge.cancel(); });
        try {
          await bridge.propose(store, instruction!, this.write, approval ?? (async (_patch, signal) => {
            if (signal.aborted || generation !== this.generation) return false;
            const result = await vscode.window.showWarningMessage('TrueForge requests permission to stage a patch. This does not apply changes. Review individual hunks next.', 'Allow Staging', 'Reject');
            return !signal.aborted && generation === this.generation && result === 'Allow Staging';
          }));
        } finally { sub.dispose(); }
      });
      if (generation !== this.generation) { store.cancel(); return; }
      if (document.isClosed) throw new ForgePilotError('The selected editor was closed. Open it and select again.');
      await store.validate(store.current!.id, { version: document.version, content: document.getText() });
      this.changed.fire();
      await this.showDiff();
      await vscode.commands.executeCommand('forgepilot.reviewView.focus');
    } catch (error) { this.store?.cancel(); this.changed.fire(); throw error; }
    finally { this.busy = false; }
  }
  review(decision: 'accepted' | 'rejected', hunk?: Hunk): void {
    const p = this.current;
    if (!p) throw new ForgePilotError('No patch to review.');
    this.store!.review(p.id, decision, hunk?.id);
    this.changed.fire(); this.refreshPreview();
  }
  private preview(p: Proposal): string {
    let text = p.snapshot.content;
    for (const h of [...p.hunks].reverse()) if (h.decision !== 'rejected') text = text.slice(0, h.start) + h.newText + text.slice(h.end);
    return text;
  }
  private uris(p: Proposal): [vscode.Uri, vscode.Uri] {
    return ['original', 'proposal'].map(side => vscode.Uri.from({ scheme: this.scheme, path: `/${p.id}/${side}/${p.snapshot.path}` })) as [vscode.Uri, vscode.Uri];
  }
  private refreshPreview(): void {
    const p = this.current; if (!p) return;
    const [original, proposed] = this.uris(p);
    this.texts.set(original.toString(), p.snapshot.content); this.texts.set(proposed.toString(), this.preview(p));
    this.textChanged.fire(proposed);
  }
  async showDiff(hunk?: Hunk): Promise<void> {
    const p = this.current; if (!p) throw new ForgePilotError('No patch to review.');
    this.refreshPreview();
    const [original, proposed] = this.uris(p);
    await vscode.commands.executeCommand('vscode.diff', original, proposed, `ForgePilot: ${p.snapshot.path} (${p.status})`, {
      preview: false, selection: hunk ? new vscode.Range(hunk.line, 0, hunk.line, 0) : undefined,
    });
  }
  async reviewPicker(): Promise<void> {
    const p = this.current; if (!p) throw new ForgePilotError('No patch to review.');
    const pick = await vscode.window.showQuickPick(p.hunks.map(h => ({ label: `Line ${h.line + 1}: ${h.decision}`, h })), { title: 'ForgePilot — select a hunk' });
    if (!pick) return;
    await this.showDiff(pick.h);
    const action = await vscode.window.showQuickPick(['Accept Hunk', 'Reject Hunk'], { title: `Review line ${pick.h.line + 1}` });
    if (action) this.review(action === 'Accept Hunk' ? 'accepted' : 'rejected', pick.h);
  }
  async apply(): Promise<void> {
    if (this.busy || this.applying) throw new ForgePilotError('Wait for the active operation to finish.');
    const store = this.store, p = this.current, doc = this.document;
    if (!store || !p || !doc || doc.isClosed) throw new ForgePilotError('The original document is closed or there is no proposal.');
    const after = store.accepted(p.id);
    this.applying = true;
    try {
      await store.validate(p.id, { version: doc.version, content: doc.getText() });
      // Recheck after the final asynchronous filesystem validation, immediately before dispatch.
      if (doc.isClosed || doc.version !== p.snapshot.version || hash(doc.getText()) !== p.originalHash) throw new ForgePilotError('Document changed during validation.');
      store.beginApply(p.id);
      const edit = new vscode.WorkspaceEdit();
      edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), after);
      const applied = await vscode.workspace.applyEdit(edit, { isRefactoring: false });
      if (!applied || doc.getText() !== after) throw new ForgePilotError('VS Code could not apply the approved patch. Inspect the document before retrying.');
      store.finishApply(true);
      this.undoRecord = { uri: doc.uri, document: doc, version: doc.version, before: p.snapshot.content, after, workspace: store.workspace, relative: p.snapshot.path, diskHash: p.diskHash };
    } catch (error) { store.finishApply(false); throw error; }
    finally { this.applying = false; this.changed.fire(); }
  }
  async undo(): Promise<void> {
    if (this.applying || this.busy) throw new ForgePilotError('Wait for the active operation to finish.');
    const record = this.undoRecord;
    if (!record) throw new ForgePilotError('No accepted ForgePilot edit to undo.');
    const doc = record.document;
    this.applying = true;
    try {
      const disk = await record.workspace.readFile(record.relative);
      if (![record.diskHash, hash(record.after)].includes(hash(disk.content)) || doc.isClosed || doc.version !== record.version || doc.getText() !== record.after)
        throw new ForgePilotError('Undo blocked: document or file changed after the accepted edit.');
      const edit = new vscode.WorkspaceEdit();
      edit.replace(record.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), record.before);
      if (!await vscode.workspace.applyEdit(edit) || doc.getText() !== record.before) throw new ForgePilotError('VS Code could not restore the preceding content.');
      this.undoRecord = undefined;
    } finally { this.applying = false; }
  }
}
