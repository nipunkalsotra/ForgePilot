import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { TrueForge } from '@truefoundry/trueforge-sdk';
import { Editing } from '../src/editing';
import type { Bridge } from '../src/bridge';
import { hash } from '../src/patch';

export async function editingHostTests(): Promise<void> {
  const root = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
  const uri = vscode.Uri.file(path.join(root, 'editing.ts'));
  const before = 'const first = 1;\n// separator\nconst second = 2;\n';
  await writeFile(uri.fsPath, before);
  let mode: 'normal' | 'cancel' | 'error' = 'normal';
  let approve!: () => void;
  let arrived!: () => void;
  const fakeBridge = {
    async propose(store: Parameters<Bridge['propose']>[0]) {
      if (mode === 'error') throw new Error('fixture model failure');
      if (mode === 'cancel') {
        arrived(); await new Promise<void>(resolve => { approve = resolve; });
      }
      await store.stage({ path: 'editing.ts', baseHash: hash(before), edits: [{ oldText: 'first = 1', newText: 'first = 10' }, { oldText: 'second = 2', newText: 'second = 20' }] }, true);
    }, async cancel() {},
  } as unknown as Bridge;
  const editing = new Editing(async () => ({ bridge: fakeBridge, root }), () => {}, 'forgepilot-host-fixture');
  const provider = vscode.workspace.registerTextDocumentContentProvider('forgepilot-host-fixture', editing);
  const select = async () => {
    const doc = await vscode.workspace.openTextDocument(uri); const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(doc.positionAt(0), doc.positionAt(doc.getText().length)); return doc;
  };
  try {
    const doc = await select();
    const editor = vscode.window.activeTextEditor!; editor.selection = new vscode.Selection(0, 0, 0, 0);
    await assert.rejects(editing.edit('change'), /Select/);
    await select(); await editing.edit('change');
    assert.equal(doc.getText(), before); assert.equal(await readFile(uri.fsPath, 'utf8'), before);
    const p = editing.current!;
    assert.equal(p.hunks.length, 2);
    editing.review('accepted', p.hunks[0]); editing.review('rejected', p.hunks[1]);
    await editing.apply(); assert.equal(doc.getText(), 'const first = 10;\n// separator\nconst second = 2;\n');
    await editing.undo(); assert.equal(doc.getText(), before);
    await doc.save();
    await select(); await editing.edit('change'); editing.review('accepted'); await editing.apply();
    const edit = new vscode.WorkspaceEdit(); edit.insert(uri, new vscode.Position(0, 0), '// user\n'); await vscode.workspace.applyEdit(edit);
    await assert.rejects(editing.undo(), /Undo blocked/); assert.match(doc.getText(), /^\/\/ user/);
    // Restore this isolated fixture using the editor before testing further proposals.
    const restore = new vscode.WorkspaceEdit(); restore.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), before);
    await vscode.workspace.applyEdit(restore); await doc.save();
    await select(); await editing.edit('change'); editing.review('rejected'); await assert.rejects(editing.apply(), /no longer/);
    await select(); await editing.edit('change'); editing.review('accepted'); editing.cancel(); await assert.rejects(editing.apply(), /no longer/);
    await select(); await editing.edit('change'); editing.review('accepted');
    const change = new vscode.WorkspaceEdit(); change.insert(uri, new vscode.Position(0, 0), '// user\n'); await vscode.workspace.applyEdit(change);
    await assert.rejects(editing.apply(), /Stale/);
    const clean = new vscode.WorkspaceEdit(); clean.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), before); await vscode.workspace.applyEdit(clean); await doc.save();
    await select(); mode = 'cancel';
    const waiting = new Promise<void>(resolve => { arrived = resolve; });
    const pending = editing.edit('change'); const rejected = assert.rejects(pending, /cancelled|Late/);
    await waiting; editing.cancel(); approve(); await rejected;
    assert.equal(doc.getText(), before); assert.equal(await readFile(uri.fsPath, 'utf8'), before);
    mode = 'error'; await select(); await assert.rejects(editing.edit('change'), /model failure/);
    assert.equal(doc.getText(), before);
    // Verify closed editors gracefully fail after closing all tabs.
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await assert.rejects(editing.edit('change'), /Open a local/);
    console.log('PASS: Actual VS Code APIs: selection, diff, mixed hunks, accept/reject all, apply, exact undo, stale/user-change protection, cancellation and model failure. Agent is a labelled fixture here.');
  } finally { editing.dispose(); provider.dispose(); }
}

export async function flaskHostTest(editing: Editing): Promise<void> {
  const root = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), '22d924701a6ae2e4cd01e9a15bbaf3946094af65');
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(), '');
  const uri = vscode.Uri.file(path.join(root, 'src/flask/helpers.py'));
  const client = new TrueForge({ baseUrl: 'http://localhost:8790', maxRetries: 0 });
  const oldSessions = new Set((await client.sessions.list()).data.map(s => s.id));
  const before = await readFile(uri.fsPath, 'utf8');
  const doc = await vscode.workspace.openTextDocument(uri); const editor = await vscode.window.showTextDocument(doc);
  const start = before.indexOf('def get_debug_flag('), end = before.indexOf('\ndef ', start + 1);
  assert.ok(start >= 0 && end > start);
  editor.selection = new vscode.Selection(doc.positionAt(start), doc.positionAt(end));
  let approvals = 0;
  // Exact instruction from official PDF. This is acceptance test data only.
  await editing.edit("Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.", async () => {
    approvals++; assert.equal(doc.getText(), before); assert.equal(await readFile(uri.fsPath, 'utf8'), before); return true;
  });
  assert.equal(approvals, 1);
  assert.equal(doc.getText(), before); assert.equal(await readFile(uri.fsPath, 'utf8'), before);
  const p = editing.current!;
  const diffTabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputTextDiff);
  assert.ok(diffTabs.length, 'A genuine native VS Code diff tab must be open');
  const diffInput = diffTabs[0]!.input as vscode.TabInputTextDiff;
  assert.equal((await vscode.workspace.openTextDocument(diffInput.original)).getText(), before);
  assert.equal((await vscode.workspace.openTextDocument(diffInput.modified)).getText(), p.proposed);
  for (const hunk of p.hunks) await vscode.commands.executeCommand('forgepilot.acceptHunk', hunk);
  assert.ok(editing.current!.hunks.every(h => h.decision === 'accepted'));
  await editing.apply();
  const applied = doc.getText(); assert.notEqual(applied, before);
  await editing.undo(); assert.equal(doc.getText(), before);
  // Generate a fresh proposal to demonstrate the production workflow again after undo.
  await doc.save(); await vscode.window.showTextDocument(doc);
  editor.selection = new vscode.Selection(doc.positionAt(start), doc.positionAt(end));
  await editing.edit("Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.", async () => true);
  editing.review('accepted'); await editing.apply(); await doc.save();
  const python = process.env.FORGEPILOT_FLASK_PYTHON ?? 'python3';
  const behavior = execFileSync(python, ['-c', `import os, json, flask\nfrom flask.helpers import get_debug_flag\nassert flask.__file__.startswith(${JSON.stringify(root)})\nexpected={'off':False,'OFF':False,'n':False,'N':False,'':False,'0':False,'false':False,'FALSE':False,'FaLsE':False,'no':False,'NO':False,'1':True,'true':True,'yes':True,'on':True,'random':True}\nfor value,wanted in expected.items():\n os.environ['FLASK_DEBUG']=value\n assert get_debug_flag() is wanted, value\nos.environ.pop('FLASK_DEBUG',None)\nassert get_debug_flag() is False\nprint(json.dumps(expected))`], { cwd: root, encoding: 'utf8', env: { ...process.env, PYTHONPATH: path.join(root, 'src') } });
  const sessions = (await client.sessions.list()).data.filter(s => !oldSessions.has(s.id) && s.metadata.client === 'ForgePilot');
  assert.equal(sessions.length, 1);
  const events: { type: string; id: string }[] = [];
  for await (const { event } of await client.sessions.listEvents(sessions[0]!.id)) events.push({ type: event.type, id: event.id });
  assert.ok(events.some(e => e.type === 'tool.approval_required'));
  assert.ok(events.some(e => e.type === 'user.tool_approval'));
  await mkdir(path.join(process.env.FORGEPILOT_ARTIFACTS!, ''), { recursive: true });
  await writeFile(path.join(process.env.FORGEPILOT_ARTIFACTS!, 'flask-phase2.json'), JSON.stringify({ result: 'PASS', root, sessionId: sessions[0]!.id, events, commit: '22d92470', originalHash: hash(before), appliedHash: hash(doc.getText()), hunkCount: p.hunks.length, nativeDiffTabs: diffTabs.length,
    approvalDriver: 'automated host test; native warning-button click not tested', undo: 'exact content restored', behavior: JSON.parse(behavior), diff: execFileSync('git', ['diff', '--', 'src/flask/helpers.py'], { cwd: root, encoding: 'utf8' }) }, null, 2));
  console.log(`PASS: Live Flask Task A through ForgePilot, ${p.hunks.length} native review hunks; exact undo and behavior ${behavior}`);
}
