import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Autonomous } from '../src/autonomous';
import type { Bridge } from '../src/bridge';
import type { BatchStore } from '../src/batch';
import { hash } from '../src/patch';

/** Actual editor integration with explicitly labelled deterministic proposal fixture. */
export async function batchHostTests(): Promise<void> {
  const root = vscode.workspace.workspaceFolders![0]!.uri.fsPath, before = 'first = 1\nseparator = 0\nsecond = 2\n';
  const paths = ['batch-a.py', 'batch-b.py', 'batch-c.py'];
  for (const file of paths) await writeFile(path.join(root, file), before);
  const output = vscode.window.createOutputChannel('Batch Host Verification');
  const fake = { async autonomous(store: BatchStore) {
    await store.stage({ plan: 'Fixture plan', files: [...paths.map(file => ({ operation: 'modify', path: file, baseHash: hash(before), edits: [{ oldText: 'first = 1', newText: 'first = 10' }, { oldText: 'second = 2', newText: 'second = 20' }] })),
      { operation: 'create', path: 'batch-new.py', content: 'created = True\n' }] }, true); store.complete();
  } } as unknown as Bridge;
  const agent = new Autonomous(async () => ({ bridge: fake, root }), output, 'forgepilot-batch-fixture');
  const provider = vscode.workspace.registerTextDocumentContentProvider('forgepilot-batch-fixture', agent);
  try {
    await agent.run('fixture change'); const p = agent.current!;
    assert.equal(agent.getChildren().length, 4);
    for (const file of p.files) {
      await agent.showDiff({ fileId: file.id });
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab; assert.ok(tab?.input instanceof vscode.TabInputTextDiff);
      assert.equal((await vscode.workspace.openTextDocument(tab.input.modified)).getText(), file.proposed);
    }
    agent.review('accepted', { fileId: p.files[0]!.id, hunkId: p.files[0]!.hunks[0]!.id });
    agent.review('rejected', { fileId: p.files[0]!.id, hunkId: p.files[0]!.hunks[1]!.id });
    agent.review('rejected', { fileId: p.files[1]!.id });
    agent.review('accepted', undefined, true);
    await agent.apply();
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, paths[0]!)));
    assert.equal(doc.getText(), 'first = 10\nseparator = 0\nsecond = 2\n');
    assert.equal((await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, paths[1]!)))).getText(), before);
    assert.equal((await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, 'batch-new.py')))).getText(), 'created = True\n');
    await assert.rejects(agent.run('fixture failing subsequent generation'), /Save/);
    await agent.undo(); assert.equal(doc.getText(), before); await assert.rejects(readFile(path.join(root, 'batch-new.py')));
    for (const file of paths) await (await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, file)))).save();
    await agent.run('fixture change'); agent.review('accepted'); await agent.apply();
    const edit = new vscode.WorkspaceEdit(); edit.insert(doc.uri, new vscode.Position(0, 0), '# user\n'); await vscode.workspace.applyEdit(edit);
    await assert.rejects(agent.undo(), /blocked/); assert.match(doc.getText(), /^# user/);
    console.log('PASS: Actual multi-file VS Code diffs, file/hunk mixed decisions, coordinated apply, reviewed creation, exact batch undo, and subsequent-user-change protection. Agent fixture, not live model evidence.');
  } finally { agent.dispose(); provider.dispose(); output.dispose(); }
}
