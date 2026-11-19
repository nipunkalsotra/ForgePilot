import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { TrueForge } from '@truefoundry/trueforge-sdk';
import type { Autonomous } from '../src/autonomous';
import type { RecoveryTrace } from '../src/resilience';

/** Genuine model smoke test, kept separate from deterministic editor fixtures. */
export async function autonomousLiveHost(agent: Autonomous): Promise<void> {
  const root = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
  const sources = new Map([
    ['switch.py', 'def is_enabled(value: str) -> bool:\n    """Return whether the switch is enabled."""\n    return value == "yes"\n'],
    ['tests/test_switch.py', 'import unittest\nfrom switch import is_enabled\n\n\nclass SwitchTests(unittest.TestCase):\n    def test_exact_yes(self):\n        self.assertTrue(is_enabled("yes"))\n        self.assertFalse(is_enabled("no"))\n'],
    ['README.md', '# Switch helper\n\nThe switch helper accepts the string `yes`. Other strings are false.\n'],
  ]);
  await mkdir(path.join(root, 'tests'));
  for (const [name, content] of sources) await writeFile(path.join(root, name), content);
  const client = new TrueForge({ baseUrl: 'http://localhost:8790', maxRetries: 0 });
  const old = new Set((await client.sessions.list()).data.map(s => s.id));
  await vscode.workspace.getConfiguration('forgepilot').update('turnTimeoutSeconds', 300, vscode.ConfigurationTarget.Global);
  await vscode.workspace.getConfiguration('forgepilot').update('autonomousToolIntervalMs', 0, vscode.ConfigurationTarget.Global);
  const instruction = 'Make the switch helper recognize the affirmative string regardless of letter case while preserving false results for other strings. Update the existing automated tests with mixed-case coverage and update the existing usage documentation. Discover the files yourself and deliver the complete three-file change together.';
  const evidence: Record<string, unknown> = { timestamp: new Date().toISOString(), instruction, approvalDriver: 'explicit automated decisions in actual VS Code; human clicks not tested', toolIntervalMs: 0 };
  const hunkDecisions: unknown[] = []; evidence.hunkDecisions = hunkDecisions;
  try {
    let approvals = 0;
    await agent.run(instruction, async batch => {
      approvals++; assert.equal(batch.files.length, 3);
      evidence.stagingDecision = { at: new Date().toISOString(), decision: 'allow staging', paths: batch.files.map(f => f.path) };
      for (const [name, content] of sources) assert.equal(await readFile(path.join(root, name), 'utf8'), content);
      return true;
    }, async q => q.options[0] ?? 'Proceed with the requested task.');
    assert.equal(approvals, 1);
    const proposal = agent.current!; evidence.proposal = proposal;
    assert.deepEqual(proposal.files.map(f => f.path).sort(), [...sources.keys()].sort());
    for (const file of proposal.files) {
      await agent.showDiff({ fileId: file.id });
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab; assert.ok(tab?.input instanceof vscode.TabInputTextDiff);
      assert.equal((await vscode.workspace.openTextDocument(tab.input.original)).getText(), sources.get(file.path));
      assert.equal((await vscode.workspace.openTextDocument(tab.input.modified)).getText(), file.proposed);
      for (const hunk of file.hunks) {
        await vscode.commands.executeCommand('forgepilot.batchAccept', { fileId: file.id, hunkId: hunk.id });
        hunkDecisions.push({ path: file.path, hunkId: hunk.id, decision: 'accepted' });
      }
    }
    await agent.apply();
    for (const file of proposal.files) await (await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, file.path)))).save();
    const python = process.env.FORGEPILOT_FLASK_PYTHON ?? 'python3';
    const commands = [];
    for (const args of [['-m', 'unittest', 'discover', '-s', 'tests', '-v'], ['-c', 'from switch import is_enabled; assert all(is_enabled(v) for v in ["yes","YES","YeS"]); assert not any(is_enabled(v) for v in ["no","NO","", "other"]); print("mixed-case behavior PASS")']]) {
      const result = spawnSync(python, args, { cwd: root, env: { ...process.env, PYTHONPATH: root }, encoding: 'utf8', timeout: 30000, maxBuffer: 65536 });
      commands.push({ args, exit: result.status, stdout: result.stdout, stderr: result.stderr }); assert.equal(result.status, 0, result.stdout + result.stderr);
    }
    evidence.commands = commands;
    await agent.undo();
    for (const [name, content] of sources) { const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, name))); assert.equal(doc.getText(), content); await doc.save(); }
    evidence.undo = 'Exact original contents restored for all three saved files'; evidence.result = 'PASS';
  } catch (error) { evidence.result = 'FAIL'; evidence.error = error instanceof Error ? error.message : String(error); throw error; }
  finally {
    evidence.retrieval = agent.evidence;
    const traces = (vscode.extensions.getExtension('nipunkalsotra.forgepilot')!.exports as { readonly recovery: RecoveryTrace[] }).recovery;
    evidence.recovery = traces;
    const owned = new Set(traces.map(t => t.sessionId));
    const sessions = (await client.sessions.list()).data.filter(s => owned.has(s.id) && !old.has(s.id));
    evidence.sessions = sessions.map(s => s.id);
    const events = [];
    for (const s of sessions) for await (const { event } of await client.sessions.listEvents(s.id)) events.push(event);
    evidence.events = events;
    await vscode.commands.executeCommand('forgepilot.stop');
    const remaining = (await client.mcpServers.list()).data.map(s => s.name);
    assert.ok(traces.every(t => !t.connector || !remaining.includes(t.connector)), 'Every owned connector must be removed; unrelated sessions may independently close their own connectors');
    evidence.cleanup = 'PASS';
    await writeFile(path.join(process.env.FORGEPILOT_ARTIFACTS!, process.env.FORGEPILOT_EVIDENCE_NAME ?? 'openrouter-three-file.json'), JSON.stringify(evidence, null, 2));
    console.log(`Generic live three-file ${evidence.result}; sessions ${JSON.stringify(evidence.sessions)}`);
  }
}
