import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Editing } from '../src/editing';
import { resilienceFixture } from './resilience-fixture';

/** Actual editor APIs with SDK-wire failures, explicitly not model inference. */
export async function resilienceHostTests(): Promise<void> {
  const root = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
  const f = await resilienceFixture('staged-error', 'valid', root);
  const editing = new Editing(async () => ({ bridge: f.bridge, root }), () => {}, 'forgepilot-resilience-host');
  const registration = vscode.workspace.registerTextDocumentContentProvider('forgepilot-resilience-host', editing);
  const uri = vscode.Uri.file(path.join(root, 'resilience.ts'));
  const doc = await vscode.workspace.openTextDocument(uri);
  const select = async () => {
    await vscode.commands.executeCommand('workbench.action.closePanel');
    let editor: vscode.TextEditor | undefined;
    for (let i = 0; i < 40; i++) {
      editor = await vscode.window.showTextDocument(doc, { preserveFocus: false, viewColumn: vscode.ViewColumn.One });
      await delay(50);
      if (vscode.window.activeTextEditor?.document.uri.toString() === uri.toString()) break;
    }
    assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), uri.toString(), 'Fixture must capture the selected local editor after VS Code activation');
    editor!.selection = new vscode.Selection(doc.positionAt(0), doc.positionAt(doc.getText().length)); };
  let ticks = 0; const timer = setInterval(() => { ticks++; }, 10);
  try {
    let approvals = 0; await select();
    await editing.edit('update the value', async () => { approvals++; assert.equal(doc.getText(), f.content); return true; });
    assert.equal(approvals, 2); assert.ok(ticks > 0); assert.equal(editing.current?.status, 'staged');
    assert.ok(vscode.window.tabGroups.all.some(g => g.tabs.some(t => t.input instanceof vscode.TabInputTextDiff)));
    assert.equal(await readFile(uri.fsPath, 'utf8'), f.content); assert.equal(doc.getText(), f.content);
    editing.review('accepted'); await editing.apply(); assert.equal(doc.getText(), 'const value = 2;\n');
    await editing.undo(); await doc.save(); assert.equal(doc.getText(), f.content);
    // The next manual request works, then staged cancellation prevents application.
    f.setMode('valid'); await select(); await editing.edit('change again', async () => true);
    editing.review('accepted'); editing.cancel(); await f.bridge.cancel(); await assert.rejects(editing.apply());
    assert.equal(doc.getText(), f.content); assert.equal(await f.unchanged(), true);
    console.log('PASS: Native VS Code resilience fixture: responsive timers, failed staged generation isolated, fresh approval/diff, approved apply, exact undo, next request, cancelled staging. SDK-wire fixture, not provider evidence.');
  } finally { clearInterval(timer); editing.dispose(); registration.dispose(); await f.close(); assert.equal(f.connectors.size, 0); }
}
