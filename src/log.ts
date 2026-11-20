import { classifyFailure } from './failure';
export type Logger = (event: string, fields?: Record<string, string | number | boolean | undefined>) => void;

/** Deliberately log metadata only: never prompts, tool contents, headers or SDK error bodies. */
export function jsonLogger(write: (line: string) => void): Logger {
  return (event, fields = {}) => write(JSON.stringify({ timestamp: new Date().toISOString(), event, ...fields }));
}

export function publicError(error: unknown): string {
  if (error instanceof Error && error.name === 'WorkspaceError') return error.message;
  if (error instanceof Error && error.name === 'ForgePilotError') return error.message;
  const status = typeof error === 'object' && error !== null && 'statusCode' in error ? error.statusCode : undefined;
  if (typeof status === 'number') {
    const body = 'body' in (error as object) ? (error as { body?: { error?: { message?: unknown } } }).body : undefined;
    if (status === 400 && typeof body?.error?.message === 'string' && body.error.message.includes('Outbound URL blocked')) {
      return 'TrueForge blocks local MCP URLs. Restart TrueForge with OUTBOUND_URL_ALLOWED_HOSTS=\'["127.0.0.1"]\' (see README), then start a new ForgePilot session.';
    }
    return classifyFailure(error).message;
  }
  return classifyFailure(error).message;
}

export { ForgePilotError } from './errors';
