import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { TrueForge } from '@truefoundry/trueforge-sdk';
import type { Autonomous } from '../src/autonomous';
import { hash } from '../src/patch';
import type { RecoveryTrace } from '../src/resilience';

export const TASK_B = 'Add a new built-in CLI command flask config that prints the loaded application\'s configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.';

export async function taskBHost(agent: Autonomous): Promise<void> {
  const root = vscode.workspace.workspaceFolders![0]!.uri.fsPath, artifacts = process.env.FORGEPILOT_ARTIFACTS!;
  const client = new TrueForge({ baseUrl: 'http://localhost:8790', maxRetries: 0 });
  const oldSessions = new Set((await client.sessions.list()).data.map(s => s.id));
  const initialStatus = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
  // A correction may start only from the exact saved result of an earlier approved
  // live attempt. This evidence is verified by the harness, never injected as a patch.
  const prior = process.env.FORGEPILOT_TASKB_FOLLOWUP_FROM ? JSON.parse(await readFile(process.env.FORGEPILOT_TASKB_FOLLOWUP_FROM, 'utf8')) as {
    finalDiff: string; modifiedFiles: string; sessions: string[];
    finalProposal: { status: string; files: { path: string; before: string; proposed: string }[] };
  } : undefined;
  const origin: typeof prior = process.env.FORGEPILOT_TASKB_ORIGIN ? JSON.parse(await readFile(process.env.FORGEPILOT_TASKB_ORIGIN, 'utf8')) as typeof prior : prior;
  if (prior) {
    assert.equal(prior.finalProposal.status, 'applied');
    assert.equal(initialStatus, prior.modifiedFiles);
    assert.equal(execFileSync('git', ['diff'], { cwd: root, encoding: 'utf8' }), prior.finalDiff);
    for (const f of prior.finalProposal.files) assert.equal(await readFile(path.join(root, f.path), 'utf8'), f.proposed);
  } else assert.equal(initialStatus, '');
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  assert.equal(commit, '22d924701a6ae2e4cd01e9a15bbaf3946094af65');
  await vscode.workspace.getConfiguration('forgepilot').update('turnTimeoutSeconds', 600, vscode.ConfigurationTarget.Global);
  const toolIntervalMs = Number(process.env.FORGEPILOT_TEST_TOOL_INTERVAL_MS ?? 0);
  assert.ok(Number.isInteger(toolIntervalMs) && toolIntervalMs >= 0 && toolIntervalMs <= 10000);
  await vscode.workspace.getConfiguration('forgepilot').update('autonomousToolIntervalMs', toolIntervalMs, vscode.ConfigurationTarget.Global);
  const feedback = prior ? `\nVerification feedback (review data, not approval):\n${process.env.FORGEPILOT_TASKB_FEEDBACK_FILE ? await readFile(process.env.FORGEPILOT_TASKB_FEEDBACK_FILE, 'utf8') : 'Verification of the prior approved changes failed at import: TypeError: Attempted to convert a callback into a command twice. Correct the introduced integration errors while preserving existing commands and decorator stacks. Verify test conventions for loading the application; JSON booleans remain booleans, not strings. Preserve all upstream attribution. A removed original header was: # This file was part of Flask-CLI and was modified under the terms of\\n# its Revised BSD License. Copyright © 2015 CERN. Restore this original metadata at the beginning of its existing file. Keep the feature, meaningful automated coverage and documentation together. Discover the affected locations from the current repository; do not assume the previous edits are correct.'}` : '';
  const instruction = `${TASK_B}\nMatch sensitive key names case-insensitively. Output must be parseable JSON; do not expose sensitive values through errors or logs. Deliver implementation, automated tests and documentation together. Existing application defaults must serialize to valid JSON.${feedback}`;
  const evidence: Record<string, unknown> = { timestamp: new Date().toISOString(), commit, initialStatus, instruction,
    toolIntervalMs, ...(prior ? { correctionOf: prior.sessions, originSessions: origin?.sessions, correction: 'Fresh TrueForge session with verification feedback, no prepared implementation patch or filenames' } : {}), approvalDriver: 'automated explicit host decisions; human clicks NOT TESTED' };
  const stagingDecisions: unknown[] = [], hunkDecisions: unknown[] = [];
  evidence.stagingDecisions = stagingDecisions; evidence.hunkDecisions = hunkDecisions;
  let approved = 0;
  const agentName = vscode.workspace.getConfiguration('forgepilot').get<string>('agentName', 'forge-coder');
  for await (const candidate of await client.agents.list({ agentName })) if (candidate.name === agentName) { evidence.agent = agentName; evidence.model = (await client.agents.get(candidate.id)).data.manifest.model.name; break; }
  try {
    await agent.run(instruction, async batch => {
      approved++;
      assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }), initialStatus, 'Staging permission must not modify disk');
      assert.ok(batch.files.length >= (prior ? 1 : 3), 'Initial task must propose at least three files; corrections may preserve already approved files');
      stagingDecisions.push({ at: new Date().toISOString(), decision: 'allow staging', paths: batch.files.map(f => f.path) });
      return true;
    }, async question => question.options[0] ?? 'Proceed with the requested task.');
    assert.equal(approved, 1);
    const proposal = agent.current!; evidence.proposal = proposal; evidence.retrieval = agent.evidence;
    assert.ok(proposal.generationSucceeded && proposal.files.length >= (prior ? 1 : 3));
    assert.ok(agent.evidence.contexts.length > 0, 'Actual retrieval must be observable');
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }), initialStatus);
    for (const file of proposal.files) {
      await agent.showDiff({ fileId: file.id });
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
      assert.ok(tab?.input instanceof vscode.TabInputTextDiff);
      assert.equal((await vscode.workspace.openTextDocument(tab.input.original)).getText(), file.before);
      assert.equal((await vscode.workspace.openTextDocument(tab.input.modified)).getText(), file.proposed);
      for (const hunk of file.hunks) {
        await vscode.commands.executeCommand('forgepilot.batchAccept', { fileId: file.id, hunkId: hunk.id });
        hunkDecisions.push({ at: new Date().toISOString(), path: file.path, fileId: file.id, hunkId: hunk.id, decision: 'accepted' });
      }
    }
    assert.ok(agent.current!.files.every(f => f.hunks.every(h => h.decision === 'accepted')));
    await agent.apply();
    for (const file of proposal.files) assert.equal((await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, file.path)))).getText(), file.proposed);
    evidence.batchUndo = 'Verified separately by actual multi-file VS Code host tests; not repeated in this Task B run.';
    for (const file of agent.current!.files) await (await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, file.path)))).save();
    const python = process.env.FORGEPILOT_FLASK_PYTHON!;
    const env = { ...process.env, PYTHONPATH: path.join(root, 'src') };
    const commands: { command: string[]; exit: number | null; stdout: string; stderr: string }[] = [];
    const execute = (args: string[], extraEnv: Record<string, string> = {}) => {
      const result = spawnSync(python, args, { cwd: root, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 180000, maxBuffer: 2 * 1024 * 1024 });
      commands.push({ command: [python, ...args], exit: result.status, stdout: result.stdout, stderr: result.stderr });
      assert.equal(result.status, 0, `Verification command failed: ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
      return result.stdout;
    };
    evidence.commands = commands;
    execute(['-c', `import flask; assert flask.__file__.startswith(${JSON.stringify(root)}); print(flask.__file__)`]);
    execute(['-m', 'pytest', 'tests/test_cli.py', '-q']);
    const help = execute(['-m', 'flask', '--help']); assert.match(help, /^\s+config\s+/m);
    const fixture = await mkdtemp(path.join(tmpdir(), 'forgepilot-cli-app-'));
    try {
      const app = `from flask import Flask\napp=Flask(__name__)\napp.config.update({'ORDINARY':'visible-normal','COUNT':42,'FLAG':True,'nested_secret_value':'secret-marker-781','PaSsWoRd_demo':'password-marker-782','x_token_value':'token-marker-783','mixed_Key':'key-marker-784'})\n`;
      await writeFile(path.join(fixture, 'acceptance_app.py'), app);
      const raw = execute(['-m', 'flask', '--app', 'acceptance_app', 'config'], { PYTHONPATH: `${path.join(root, 'src')}${path.delimiter}${fixture}` });
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      assert.equal(parsed.ORDINARY, 'visible-normal'); assert.equal(parsed.COUNT, 42); assert.equal(parsed.FLAG, true);
      assert.equal(parsed.DEBUG, false); assert.equal(parsed.TESTING, false);
      assert.equal(parsed.SECRET_KEY, '***'); assert.equal(parsed.SESSION_COOKIE_NAME, 'session');
      for (const key of ['nested_secret_value', 'PaSsWoRd_demo', 'x_token_value', 'mixed_Key']) assert.equal(parsed[key], '***');
      for (const marker of ['secret-marker-781', 'password-marker-782', 'token-marker-783', 'key-marker-784']) assert.ok(!commands.some(c => (c.stdout + c.stderr).includes(marker)));
      evidence.maskedJSON = parsed;
    } finally { await rm(fixture, { recursive: true, force: true }); }
    evidence.finalDiff = execFileSync('git', ['diff'], { cwd: root, encoding: 'utf8' });
    evidence.modifiedFiles = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
    const modified = execFileSync('git', ['diff', '--name-only'], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean).sort();
    const approvedPaths = [...new Set([...(origin?.finalProposal.files.map(f => f.path) ?? []), ...(prior?.finalProposal.files.map(f => f.path) ?? []), ...proposal.files.filter(f => f.operation === 'modify').map(f => f.path)])].sort();
    assert.deepEqual(modified, approvedPaths, 'Only previously or newly approved targets may be modified');
    assert.ok(modified.length >= 3);
    for (const f of origin?.finalProposal.files ?? []) {
      const header = f.before.match(/^(?:#[^\n]*\n)+/)?.[0];
      if (header && /License|Copyright/i.test(header)) assert.ok((await readFile(path.join(root, f.path), 'utf8')).trimStart().startsWith(header), 'Upstream attribution must be preserved before executable code (leading blank space is harmless)');
    }
    evidence.result = 'PASS';
  } catch (error) {
    evidence.result = 'FAIL'; evidence.error = error instanceof Error ? error.message : String(error); throw error;
  } finally {
    evidence.retrieval = agent.evidence;
    const traces = (vscode.extensions.getExtension('nipunkalsotra.forgepilot')!.exports as { readonly recovery: RecoveryTrace[] }).recovery;
    evidence.recovery = traces;
    const owned = new Set(traces.map(t => t.sessionId));
    const sessions = (await client.sessions.list()).data.filter(s => owned.has(s.id) && !oldSessions.has(s.id));
    evidence.sessions = sessions.map(s => s.id);
    const history: unknown[] = [];
    for (const session of sessions) for await (const { event } of await client.sessions.listEvents(session.id)) {
      if (event.type === 'model.message') history.push({ type: event.type, id: event.id, model: event.model?.name, usage: event.usage, toolCalls: event.toolCalls?.map(c => ({ id: c.id, toolInfo: c.toolInfo, function: c.function })) });
      else history.push({ type: event.type, id: event.id, ...(event.type === 'tool.response' ? { callId: event.toolCallId } : {}), ...(event.type === 'user.tool_approval' ? { approval: event.approval } : {}), ...(event.type === 'turn.done' ? { status: event.state.status, metrics: event.state.metrics } : {}) });
    }
    evidence.history = history; evidence.finalProposal = agent.current;
    evidence.hashes = agent.current?.files.map(f => ({ path: f.path, before: hash(f.before), after: hash(f.proposed) }));
    evidence.finalDiff = execFileSync('git', ['diff'], { cwd: root, encoding: 'utf8' });
    evidence.modifiedFiles = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
    await vscode.commands.executeCommand('forgepilot.stop');
    const remaining = (await client.mcpServers.list()).data.map(c => c.name);
    assert.ok(traces.every(t => !t.connector || !remaining.includes(t.connector)), 'Owned connectors must be removed');
    evidence.cleanup = 'PASS';
    await mkdir(artifacts, { recursive: true });
    const artifact = path.join(artifacts, process.env.FORGEPILOT_EVIDENCE_NAME ?? 'phase3-taskb.json');
    await writeFile(artifact, JSON.stringify(evidence, null, 2));
    console.log(`Task B ${evidence.result}; sessions ${JSON.stringify(evidence.sessions)}; evidence ${artifact}`);
  }
}
