import { readdir, readFile, writeFile } from 'node:fs/promises';
import { TrueForge, type TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { localBaseUrl } from '../src/config';

// Read-only historical analysis. Do not dump raw SDK errors, model text or arguments.
const client = new TrueForge({ baseUrl: localBaseUrl(process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790'), token: process.env.TRUEFORGE_TOKEN, maxRetries: 0 });
const classify = (text: string) => {
  if (/quota|429|rate.limit|resource.exhaust/i.test(text)) return 'PROVIDER_QUOTA';
  if (/503|high demand|overload|unavailable/i.test(text)) return 'PROVIDER_UNAVAILABLE';
  if (/timeout|timed.out|connect|fetch failed/i.test(text)) return 'PROVIDER_CONNECTION';
  if (/turn failed|did not complete successfully/i.test(text)) return 'TURN_FAILED_UNSPECIFIED';
  if (/different request|draft request/i.test(text)) return 'DRAFT_SCOPE_MISMATCH';
  if (/INVALID_OPERATION/i.test(text)) return 'INVALID_OPERATION';
  if (/duplicate/i.test(text)) return 'DUPLICATE_PATH';
  if (/uniquely|anchor/i.test(text)) return 'ANCHOR_INVALID';
  if (/malformed|schema|oldText|operation|validation|expected|invalid/i.test(text)) return 'SCHEMA_INVALID';
  if (/response_required|interactive/i.test(text)) return 'UNSUPPORTED_CLIENT_QUESTION';
  return 'UNCLASSIFIED';
};
const rows = [];
const seen = new Set<string>();
for (const name of (await readdir('artifacts')).filter(f => /^phase3-(?:taskb(?:-attempt\d+|-before-recovery)?|openrouter-attempt\d+)\.json$/.test(f))) {
  const artifact = JSON.parse(await readFile(`artifacts/${name}`, 'utf8')) as { sessions: string[]; error: string };
  for (const session of artifact.sessions) {
    if (seen.has(session)) continue;
    seen.add(session);
    const events: TrueForgeApi.SessionEvent[] = [];
    for await (const { event } of await client.sessions.listEvents(session)) events.push(event);
    events.sort((a, b) => a.id.localeCompare(b.id));
    const calls = events.flatMap(e => e.type === 'model.message' ? e.toolCalls ?? [] : []);
    const terminals = events.filter(e => e.type === 'turn.done');
    const feedback = events.filter(e => {
      if (e.type !== 'tool.response') return false;
      try {
        const result = JSON.parse(e.content) as { error?: unknown; valid?: boolean };
        return Boolean(result.error) || result.valid === false;
      } catch { return /^(?:Error|Invalid|Malformed|Tool .* not found|Patch .*must match|Duplicate|Expected|Unsafe|Path|File .* not)/i.test(e.content); }
    }).map(e => {
      if (e.type !== 'tool.response') throw new Error('Expected tool response');
      const call = calls.find(c => c.id === e.toolCallId);
      return { callId: e.toolCallId, tool: call?.toolInfo.name, category: classify(e.content), bytes: Buffer.byteLength(e.content) };
    });
    const modelUsage = events.flatMap(e => e.type === 'model.message' && e.usage ? [e.usage] : []);
    rows.push({ artifact: name, session, observedError: classify(artifact.error), toolCalls: calls.length,
      terminals: terminals.map(e => ({ status: e.state.status, category: e.state.status === 'error' ? classify(e.state.message) : undefined, metrics: e.state.metrics })),
      summedModelUsage: modelUsage.length ? { input: modelUsage.reduce((n, m) => n + m.inputTokens, 0), output: modelUsage.reduce((n, m) => n + m.outputTokens, 0) } : undefined,
      feedback });
  }
}
await writeFile('artifacts/phase3-failure-analysis.json', JSON.stringify(rows, null, 2));
for (const r of rows) console.log(JSON.stringify(r));
