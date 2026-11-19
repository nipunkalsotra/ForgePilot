import { startServer, type RunningServer } from './server';
import { jsonLogger } from '../log';
import type { CommandApproval } from '../terminal';

let server: RunningServer | undefined;
let closing = false;
const log = jsonLogger(line => process.stderr.write(`${line}\n`));
const startup = setTimeout(() => { void stop(); }, 10_000);

async function stop(): Promise<void> {
  if (closing) return;
  closing = true;
  clearTimeout(startup);
  const force = setTimeout(() => process.exit(1), 2000);
  await server?.close();
  clearTimeout(force);
  process.exit(0);
}

process.once('disconnect', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });
process.once('SIGINT', () => { void stop(); });
process.on('message', (message: unknown) => {
  if (message && typeof message === 'object' && 'type' in message && message.type === 'context-reset') server?.resetContext();
});
process.on('message', (message: unknown) => {
  if (!message || typeof message !== 'object' || !('type' in message) || message.type !== 'command-grant' || !('id' in message) || typeof message.id !== 'string') return;
  void (async () => {
    if (!server || closing || !('approval' in message)) throw new Error('Companion unavailable');
    await server.grantCommand(message.approval as CommandApproval);
    process.send?.({ type: 'command-ready', id: message.id, ok: true });
  })().catch(() => process.send?.({ type: 'command-ready', id: message.id, ok: false }));
});
process.on('message', (message: unknown) => {
  if (!message || typeof message !== 'object' || !('type' in message) || message.type !== 'drafts' || !('id' in message) || typeof message.id !== 'string') return;
  try {
    if (!server || closing) throw new Error('Companion unavailable');
    if ('requestId' in message && typeof message.requestId === 'string') server.beginDrafts(message.requestId, 'seed' in message ? message.seed as { prompt: string; model?: string; spent?: number; tools?: number } : undefined); else server.invalidateDrafts();
    process.send?.({ type: 'drafts-ready', id: message.id, ok: true });
  } catch { process.send?.({ type: 'drafts-ready', id: message.id, ok: false }); }
});
process.once('message', (message: unknown) => {
  void (async () => {
    if (typeof message !== 'object' || message === null || !('root' in message) || !('token' in message)
      || typeof message.root !== 'string' || typeof message.token !== 'string') throw new Error('Invalid initialization');
    server = await startServer(message.root, message.token, log, 'proposals' in message && message.proposals === true, 'autonomous' in message && message.autonomous === true, 'contextBudget' in message && typeof message.contextBudget === 'number' ? message.contextBudget : 12000, 'toolIntervalMs' in message && typeof message.toolIntervalMs === 'number' ? message.toolIntervalMs : 0, 'commandTimeoutSeconds' in message && typeof message.commandTimeoutSeconds === 'number' ? message.commandTimeoutSeconds : 120, callId => process.send?.({ type: 'command-running', callId }), 'budgetConfig' in message ? message.budgetConfig : {}, snapshot => process.send?.({ type: 'usage', snapshot }));
    if (closing || !process.connected) { await server.close(); return; }
    clearTimeout(startup);
    process.send?.({ type: 'ready', url: server.url });
  })().catch(() => { log('mcp.start.failed'); void stop(); });
});
process.on('uncaughtException', () => { log('mcp.uncaught'); void stop(); });
process.on('unhandledRejection', () => { log('mcp.rejection'); void stop(); });
