import { fork, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { ForgePilotError, type Logger } from './log';

export class Companion {
  readonly token = randomBytes(32).toString('hex');
  private child?: ChildProcess;
  url?: string;
  get pid(): number | undefined { return this.child?.pid; }

  constructor(private readonly childPath: string, private readonly log: Logger) {}

  async start(root: string): Promise<string> {
    if (this.child) throw new ForgePilotError('Companion is already running.');
    // No provider keys or other inherited secrets are passed to the child.
    const child = fork(this.childPath, [], { execArgv: [], env: { ELECTRON_RUN_AS_NODE: '1', SYSTEMROOT: process.env.SYSTEMROOT },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
    this.child = child;
    child.on('error', () => this.log('companion.error'));
    child.on('exit', (code, signal) => { this.url = undefined; this.log('companion.exit', { code: code ?? undefined, signal: signal ?? undefined }); });
    // Child only emits metadata JSON. Never forward arbitrary stdout or raw errors.
    let buffered = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      buffered = (buffered + chunk.toString()).slice(-8192);
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as Record<string, unknown>;
          if (typeof entry.event === 'string') this.log(entry.event, {
            tool: typeof entry.tool === 'string' ? entry.tool : undefined,
            bytes: typeof entry.bytes === 'number' ? entry.bytes : undefined,
            durationMs: typeof entry.durationMs === 'number' ? entry.durationMs : undefined,
          });
        } catch { /* Non-structured child diagnostics are intentionally suppressed. */ }
      }
    });
    try {
      const url = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(new ForgePilotError('Companion startup timed out.')); }, 10_000);
        const cleanup = () => { clearTimeout(timer); child.off('exit', failed); child.off('error', failed); child.off('message', ready); };
        const failed = () => { cleanup(); reject(new ForgePilotError('Companion could not start. Check workspace access and build output.')); };
        const ready = (message: unknown) => {
          if (typeof message === 'object' && message !== null && 'url' in message && typeof message.url === 'string'
            && /^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(message.url)) { cleanup(); resolve(message.url); }
        };
        child.once('exit', failed); child.once('error', failed); child.on('message', ready);
        child.send({ root, token: this.token }, error => { if (error) failed(); });
      });
      this.url = url;
      this.log('companion.started', { pid: child.pid });
      return url;
    } catch (error) { await this.stop(); throw error; }
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.url = undefined;
    if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>(resolve => {
      const force = setTimeout(() => { child.kill('SIGKILL'); }, 2500);
      child.once('exit', () => { clearTimeout(force); resolve(); });
      child.kill('SIGTERM');
    });
  }
}
