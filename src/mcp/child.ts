import { startServer, type RunningServer } from './server';
import { jsonLogger } from '../log';

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
process.once('message', (message: unknown) => {
  void (async () => {
    if (typeof message !== 'object' || message === null || !('root' in message) || !('token' in message)
      || typeof message.root !== 'string' || typeof message.token !== 'string') throw new Error('Invalid initialization');
    server = await startServer(message.root, message.token, log);
    if (closing || !process.connected) { await server.close(); return; }
    clearTimeout(startup);
    process.send?.({ type: 'ready', url: server.url });
  })().catch(() => { log('mcp.start.failed'); void stop(); });
});
process.on('uncaughtException', () => { log('mcp.uncaught'); void stop(); });
process.on('unhandledRejection', () => { log('mcp.rejection'); void stop(); });
