import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import { ForgePilotError } from './log';
import { permittedParts } from './workspace';

// No executable, shell text, environment or arbitrary flags are accepted from a model.
export const commandSchema = z.strictObject({
  operation: z.enum(['git_status', 'git_diff_check', 'pytest', 'npm_test', 'cli_help']),
  cwd: z.string().min(1).max(512).default('.'),
  testPaths: z.array(z.string().min(1).max(512)).min(1).max(8).optional(),
  script: z.enum(['test', 'test:unit', 'lint']).optional(),
  timeoutSeconds: z.number().int().min(1).max(120).default(30),
});
export type CommandRequest = z.infer<typeof commandSchema>;
export interface CommandPlan { request: CommandRequest; executable: string; args: string[]; directory: string; summary: string; risk: string; binding: string }
export interface CommandApproval { requestId: string; callId: string; sourceEventId: string; approvalEventId: string; request: CommandRequest; binding: string }
export interface CommandResult {
  kind: 'forgepilot.command'; category: string; summary: string; exitCode: number | null;
  termination: 'exited' | 'denied' | 'cancelled' | 'timeout' | 'output_limit' | 'unavailable';
  durationMs: number; stdout: string; stderr: string; truncated: boolean; timedOut: boolean; cancelled: boolean;
  callId?: string; approvalEventId?: string;
}
export function parseCommand(input: unknown): CommandRequest {
  const parsed = commandSchema.safeParse(input);
  if (!parsed.success) throw new ForgePilotError('Unsupported command request. Use a documented verification operation without shell text or extra fields.');
  const r = parsed.data;
  if ((r.operation === 'pytest') !== !!r.testPaths || (r.operation === 'npm_test') !== !!r.script)
    throw new ForgePilotError('pytest requires only testPaths; npm_test requires only script. Other operations accept neither.');
  return r;
}
export function commandDigest(request: CommandRequest): string { return createHash('sha256').update(JSON.stringify(parseCommand(request))).digest('hex'); }

async function confined(root: string, relative: string, directory: boolean): Promise<string> {
  if (relative === '.' && directory) return root;
  const parts = relative.split('/');
  // Structural path grammar, not a shell-injection blacklist.
  if (!parts.length || parts.some(p => !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(p)) || !permittedParts(parts))
    throw new ForgePilotError('Command paths must be ordinary workspace-relative paths without traversal or hidden/sensitive components.');
  let candidate = root;
  for (const part of parts) { candidate = path.join(candidate, part); if ((await lstat(candidate)).isSymbolicLink()) throw new ForgePilotError('Command paths cannot use symbolic links.'); }
  const resolved = await realpath(candidate), rel = path.relative(root, resolved), info = await lstat(resolved);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) || (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1))
    throw new ForgePilotError('Command path escaped the authorized workspace or is not a supported target.');
  return resolved;
}
export async function planCommand(root: string, input: unknown, maxSeconds = 120): Promise<CommandPlan> {
  const request = parseCommand(input);
  if (request.timeoutSeconds > maxSeconds) throw new ForgePilotError(`Command timeout exceeds the configured ${maxSeconds}-second limit.`);
  if (await realpath(root) !== root) throw new ForgePilotError('Authorized workspace identity changed.');
  const directory = await confined(root, request.cwd, true);
  const rootInfo = await lstat(root), directoryInfo = await lstat(directory);
  let executable = '/usr/bin/git', args: string[];
  const git = ['--no-optional-locks', '--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.pager=cat', '-c', 'core.attributesFile=/dev/null'];
  switch (request.operation) {
    case 'git_status': args = [...git, 'status', '--short', '--untracked-files=normal']; break;
    case 'git_diff_check': args = [...git, 'diff', '--no-ext-diff', '--no-textconv', '--check']; break;
    case 'cli_help': args = [...git, '--help']; break;
    case 'pytest':
      for (const p of request.testPaths!) {
        if (!p.endsWith('.py') || !p.split('/').at(-1)!.startsWith('test')) throw new ForgePilotError('pytest accepts bounded test*.py files only.');
        await confined(directory, p, false);
      }
      executable = '/usr/bin/python3'; args = ['-B', '-m', 'pytest', '-q', '-p', 'no:cacheprovider', '--', ...request.testPaths!]; break;
    case 'npm_test': {
      // Resolve only known distro-managed npm CLI paths. Never accept an
      // executable or arbitrary path from the model, PATH or workspace.
      const candidates = ['/usr/lib/node_modules/npm/bin/npm-cli.js', '/usr/share/nodejs/npm/bin/npm-cli.js'];
      let npmCli: string | undefined;
      for (const candidate of candidates) {
        try {
          const file = await lstat(candidate);
          if (file.isFile()) { npmCli = candidate; break; }
        } catch { /* This system does not provide this packaged npm layout. */ }
      }
      if (!npmCli) throw new ForgePilotError('Supported system npm CLI is unavailable; command execution requires a supported Linux runtime.');
      executable = '/usr/bin/node';
      args = [npmCli, '--offline', '--ignore-scripts', 'run', request.script!];
      break;
    }
  }
  return { request, executable, args, directory, binding: `${rootInfo.dev}:${rootInfo.ino}/${directoryInfo.dev}:${directoryInfo.ino}`,
    summary: `${path.basename(executable)} ${args.join(' ')} (cwd: ${request.cwd}, timeout: ${request.timeoutSeconds}s)`,
    risk: ['pytest', 'npm_test'].includes(request.operation)
      ? 'Executes repository-controlled code. Linux sandbox makes the workspace and system read-only, isolates networking and uses temporary scratch space. Output may disclose repository secrets to TrueForge/the model. Only saved disk content is tested; staged proposals are not applied.'
      : 'Reads Git metadata in a read-only, network-isolated Linux sandbox. Output may disclose repository filenames or content to TrueForge/the model.' };
}

/** Best-effort output redaction; unknown secrets in approved repository output remain possible. */
export function sanitizeCommandOutput(value: string): string {
  // eslint-disable-next-line no-control-regex -- Strip terminal control sequences before displaying untrusted output.
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .replace(/(\b(?:authorization\s*:\s*bearer|bearer)\s+)\S+/gi, '$1[REDACTED]')
    .replace(/(\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL)[A-Z0-9_]*\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,})\b/g, '[REDACTED]');
}

/** Grants arrive only over private parent IPC, never through MCP or model arguments. */
export class CommandAuthority {
  private scope?: string;
  private retired = new Set<string>();
  private grants = new Map<string, CommandApproval>();
  private seen = new Set<string>();
  private jobs = new Set<AbortController>();
  private pending = new Set<Promise<void>>();
  private closed = false;
  constructor(readonly root: string, readonly maxSeconds = 120, readonly outputBytes = 12000, private readonly running: (callId: string) => void = () => {}) {}
  begin(id: string): void {
    if (this.closed || id === this.scope || this.retired.has(id) || this.retired.size >= 64) throw new ForgePilotError('Terminal scope cannot be reused. Start a fresh session.');
    this.invalidate(); this.scope = id; this.seen.clear();
  }
  invalidate(): void {
    if (this.scope) this.retired.add(this.scope);
    this.scope = undefined; this.grants.clear();
    for (const job of this.jobs) job.abort();
  }
  async close(): Promise<void> { this.closed = true; this.invalidate(); await Promise.allSettled([...this.pending]); }
  async grant(value: CommandApproval): Promise<void> {
    if (!value || value.requestId !== this.scope || !value.callId || !value.sourceEventId || !value.approvalEventId || this.seen.has(value.callId)) throw new ForgePilotError('Stale or repeated command approval.');
    const plan = await planCommand(this.root, value.request, this.maxSeconds);
    if (plan.binding !== value.binding) throw new ForgePilotError('Approved workspace/directory identity changed.');
    if (value.requestId !== this.scope || this.closed || this.seen.has(value.callId)) throw new ForgePilotError('Command approval was revoked.');
    if (this.grants.size || this.jobs.size || this.seen.size >= 64) throw new ForgePilotError('Only one pending command and at most 64 commands per request are supported.');
    this.seen.add(value.callId); this.grants.set(commandDigest(plan.request), structuredClone(value));
  }
  async execute(input: unknown): Promise<CommandResult> {
    const start = Date.now(), request = parseCommand(input), key = commandDigest(request), grant = this.grants.get(key);
    const result: CommandResult = { kind: 'forgepilot.command', category: request.operation, summary: request.operation,
      exitCode: null, termination: 'denied', durationMs: 0, stdout: '', stderr: '', truncated: false, timedOut: false, cancelled: false };
    if (!grant || grant.requestId !== this.scope || this.closed) { result.stderr = 'No current single-use developer approval for this exact command.'; return result; }
    this.grants.delete(key); // Consume before any await or spawn. Replays cannot execute.
    result.callId = grant.callId; result.approvalEventId = grant.approvalEventId;
    const controller = new AbortController(); this.jobs.add(controller);
    let finish!: () => void; const done = new Promise<void>(resolve => { finish = resolve; }); this.pending.add(done);
    try {
      const plan = await planCommand(this.root, request, this.maxSeconds); result.summary = plan.summary;
      if (plan.binding !== grant.binding) throw new ForgePilotError('Approved workspace/directory identity changed.');
      if (controller.signal.aborted || grant.requestId !== this.scope) { result.termination = 'cancelled'; result.cancelled = true; return result; }
      if (process.platform !== 'linux') { result.termination = 'unavailable'; result.stderr = 'Command execution requires Linux Bubblewrap; no unsandboxed fallback is allowed.'; return result; }
      // Only system runtimes and the read-only authorized root are visible. No home, host /tmp,
      // sockets, provider configuration, companion token or inherited environment are mounted.
      const args = ['--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL', '--json-status-fd', '3',
        '--ro-bind', '/usr', '/usr', '--ro-bind', '/bin', '/bin', '--ro-bind', '/lib', '/lib'];
      try { await lstat('/lib64'); args.push('--ro-bind', '/lib64', '/lib64'); } catch { /* Distribution without /lib64. */ }
      args.push('--proc', '/proc', '--dev', '/dev', '--size', '67108864', '--tmpfs', '/tmp', '--dir', '/tmp/home', '--dir', '/tmp/cache',
        '--ro-bind', this.root, this.root, '--chdir', plan.directory, '--', plan.executable, ...plan.args);
      if (controller.signal.aborted) { result.termination = 'cancelled'; result.cancelled = true; return result; }
      this.running(grant.callId);
      await new Promise<void>(resolve => {
        const child = spawn('/usr/bin/bwrap', args, { shell: false, detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
          env: { PATH: '/usr/bin:/bin', HOME: '/tmp/home', XDG_CACHE_HOME: '/tmp/cache', TMPDIR: '/tmp', LANG: 'C.UTF-8',
            GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
            PYTHONDONTWRITEBYTECODE: '1', PYTEST_DISABLE_PLUGIN_AUTOLOAD: '1', npm_config_cache: '/tmp/cache', npm_config_userconfig: '/tmp/home/.npmrc', npm_config_globalconfig: '/tmp/global-npmrc' } });
        let used = 0, stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), finished = false;
        let sandboxStatus = '';
        (child.stdio[3] as Readable).on('data', (b: Buffer) => { sandboxStatus = (sandboxStatus + b.toString()).slice(0, 4096); });
        const kill = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } } };
        const terminate = (reason: CommandResult['termination']) => { if (result.termination !== 'denied') return; result.termination = reason; kill(); };
        const abort = () => terminate('cancelled'); controller.signal.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(() => terminate('timeout'), request.timeoutSeconds * 1000);
        const collect = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
          const keep = chunk.subarray(0, Math.max(0, this.outputBytes - used)); used += keep.length;
          if (stream === 'stdout') stdout = Buffer.concat([stdout, keep]); else stderr = Buffer.concat([stderr, keep]);
          if (keep.length < chunk.length) { result.truncated = true; terminate('output_limit'); }
        };
        child.stdout!.on('data', (b: Buffer) => collect(b, 'stdout')); child.stderr!.on('data', (b: Buffer) => collect(b, 'stderr'));
        const finish = (code: number | null, failed = false) => {
          if (finished) return; finished = true; clearTimeout(timer); controller.signal.removeEventListener('abort', abort); kill();
          const exit = sandboxStatus.split('\n').flatMap(line => { try { const status = JSON.parse(line) as { 'exit-code'?: unknown }; return typeof status['exit-code'] === 'number' ? [status['exit-code']] : []; } catch { return []; } }).at(-1);
          result.exitCode = exit ?? null;
          if (result.termination === 'denied') result.termination = failed || exit === undefined ? 'unavailable' : 'exited';
          result.stdout = sanitizeCommandOutput(stdout.toString('utf8')); result.stderr = sanitizeCommandOutput(stderr.toString('utf8'));
          if (failed || result.termination === 'unavailable') result.stderr = 'Sandbox runtime unavailable. Install/enable Linux Bubblewrap and system runtimes; no command was run without isolation.';
          void code; // Wrapper exit is not invented as the requested command's exit code.
          result.cancelled = result.termination === 'cancelled'; result.timedOut = result.termination === 'timeout'; resolve();
        };
        child.once('error', () => finish(null, true)); child.once('close', code => finish(code));
        if (controller.signal.aborted) abort();
      });
      return result;
    } finally { result.durationMs = Date.now() - start; this.jobs.delete(controller); this.pending.delete(done); finish(); }
  }
}
