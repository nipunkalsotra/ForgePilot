import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Bridge } from '../src/bridge';
import { PatchStore, hash } from '../src/patch';
import { Workspace } from '../src/workspace';
import { publicError } from '../src/log';

// Real TrueForge/model/MCP calls. Human approval decisions are automated by this verification driver.
const root = await mkdtemp(path.join(tmpdir(), 'forgepilot-edit-live-'));
const content = 'export const first = 1;\n// separator\nexport const second = 2;\n';
await writeFile(path.join(root, 'sample.ts'), content);
const evidence: Record<string, unknown> = { timestamp: new Date().toISOString(), approvalDriver: 'automated verification; not manual UI interaction' };
const bridge = new Bridge({ baseUrl: process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790', token: process.env.TRUEFORGE_TOKEN,
  agentName: process.env.TRUEFORGE_AGENT_NAME ?? 'forge-coder', root, childPath: path.resolve('dist/mcp-child.cjs'), proposals: true,
  log: (event, fields) => console.log(JSON.stringify({ event, ...fields })) });
const store = () => new PatchStore(workspace, { path: 'sample.ts', content, version: 1, start: 0, end: content.length });
const workspace = await Workspace.create(root);
try {
  evidence.session = await bridge.start(); evidence.model = bridge.modelName;
  const proposal = store();
  let approvals = 0;
  await bridge.propose(proposal, 'Change first to 10 and second to 20. Preserve the separator line.', text => process.stdout.write(text), async () => {
    approvals++;
    assert.equal(await readFile(path.join(root, 'sample.ts'), 'utf8'), content);
    return true;
  });
  assert.equal(approvals, 1);
  const p = proposal.current!;
  assert.equal(p.hunks.length, 2);
  proposal.review(p.id, 'accepted', p.hunks[0]!.id); proposal.review(p.id, 'rejected', p.hunks[1]!.id);
  assert.equal(proposal.accepted(p.id), 'export const first = 10;\n// separator\nexport const second = 2;\n');
  assert.equal(await readFile(path.join(root, 'sample.ts'), 'utf8'), content);
  const events: { type: string; id?: string; callId?: string }[] = [];
  for await (const { event } of await bridge.client.sessions.listEvents(bridge.sessionId!)) {
    events.push({ type: event.type, id: event.id, callId: event.type === 'tool.response' ? event.toolCallId : undefined });
  }
  assert.ok(events.some(e => e.type === 'tool.approval_required'));
  assert.ok(events.some(e => e.type === 'user.tool_approval'));
  evidence.approvalEvents = events; evidence.hunks = p.hunks; evidence.unchangedHash = hash(content);
  proposal.cancel(); assert.throws(() => proposal.accepted(p.id));
  evidence.cancelAfterStaging = 'PASS';
  // Cancel a real turn while it waits for the human staging decision.
  const waitingStore = store();
  let arrived!: () => void, release!: (allow: boolean) => void;
  const waiting = new Promise<void>(resolve => { arrived = resolve; });
  const approvalTurn = bridge.propose(waitingStore, 'Change first to 11; leave everything else unchanged.', () => {}, async () => {
    arrived(); return new Promise<boolean>(resolve => { release = resolve; });
  });
  const approvalCancelled = assert.rejects(approvalTurn, /cancelled/);
  await waiting; await bridge.cancel(); release(true); await approvalCancelled;
  assert.equal(waitingStore.current, undefined);
  evidence.cancelWaitingForApproval = 'PASS';
  // Cancel through sessions.cancel on the first real streamed text fragment.
  let first!: () => void;
  const delta = new Promise<void>(resolve => { first = resolve; });
  const streamed = bridge.ask('Do not call tools. Explain safe code review in detail, in twenty paragraphs.', () => first());
  const streamCancelled = assert.rejects(streamed, /cancelled/);
  await delta; await bridge.cancel(); await streamCancelled;
  assert.equal(await readFile(path.join(root, 'sample.ts'), 'utf8'), content);
  evidence.cancelDuringStreaming = 'PASS';
  evidence.result = 'PASS';
} catch (error) { evidence.result = 'FAIL'; evidence.error = publicError(error); console.error(publicError(error)); process.exitCode = 1; }
finally {
  await bridge.stop(); await rm(root, { recursive: true, force: true });
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/phase2-live.json', JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
}
