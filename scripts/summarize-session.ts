import { TrueForge } from '@truefoundry/trueforge-sdk';
import { publicError } from '../src/log';

// Read-only evidence: omit prompts, source text, raw provider bodies and credentials.
async function main(): Promise<void> {
const client = new TrueForge({ baseUrl: 'http://localhost:8790', maxRetries: 0, timeoutInSeconds: 10 });
const ids = process.argv.slice(2);
if (!ids.length) ids.push((await client.sessions.list()).data.find(s => s.metadata.client === 'ForgePilot')!.id);
for (const id of ids) {
  const events = [];
  for await (const { event } of await client.sessions.listEvents(id)) events.push(event);
  events.sort((a, b) => a.id.localeCompare(b.id));
  const calls = new Map(events.flatMap(e => e.type === 'model.message' ? (e.toolCalls ?? []).map(c => [c.id, c] as const) : []));
  const chronology = events.flatMap(e => {
    if (e.type === 'model.message') return (e.toolCalls ?? []).map(c => {
      let args: Record<string, unknown> = {}; try { args = JSON.parse(c.function.arguments) as Record<string, unknown>; } catch { /* Invalid arguments are not exposed. */ }
      return { event: e.id, call: c.id, tool: c.toolInfo.name, path: args.path, start: args.start, count: args.count, operation: args.operation };
    });
    return [];
  });
  const feedback = events.flatMap<Record<string, unknown>>(e => {
    if (e.type !== 'tool.response') return [];
    try {
      const r = JSON.parse(e.content) as Record<string, unknown>;
      return [{ call: e.toolCallId, tool: calls.get(e.toolCallId)?.toolInfo.name, kind: r.kind, valid: r.valid, code: r.code, path: r.path, draftId: r.draftId, retainedFiles: r.retainedFiles }];
    } catch { return [{ call: e.toolCallId, tool: calls.get(e.toolCallId)?.toolInfo.name, code: 'NON_JSON_RESPONSE' }]; }
  });
  console.log(JSON.stringify({ id, chronology, feedback, compactions: events.filter(e => e.type.startsWith('thread.context_compaction')).map(e => e.type),
    terminal: events.flatMap(e => e.type === 'turn.done' ? [{ status: e.state.status, metrics: e.state.metrics }] : []) }));
}
}
await main().catch(error => { console.error(publicError(error)); process.exitCode = 1; });
