import { ForgePilotError } from './log';

/** Treat SDK types as an interoperability hint, not proof that the server succeeded. */
export function requireSuccessfulCompletion(state: unknown): void {
  if (state && typeof state === 'object' && 'status' in state && state.status === 'error' && 'message' in state && typeof state.message === 'string' && /\b429\b|quota|rate.?limit/i.test(state.message)) {
    throw new ForgePilotError('TrueForge model request was rate-limited. Pending proposals are invalid; retry after the provider limit resets.');
  }
  if (!state || typeof state !== 'object' || !('status' in state) || state.status !== 'done'
    || !('requiredActions' in state) || !Array.isArray(state.requiredActions) || state.requiredActions.length !== 0) {
    throw new ForgePilotError('TrueForge turn failed or did not complete successfully. Pending proposals are invalid.');
  }
  if ('output' in state && state.output !== null && state.output !== undefined) {
    const output = state.output;
    if (typeof output !== 'object'
      || 'finishReason' in output && output.finishReason != null && output.finishReason !== 'stop'
      || 'refusal' in output && typeof output.refusal === 'string' && output.refusal.trim()) {
      throw new ForgePilotError('TrueForge final model output is incomplete or refused. Pending proposals are invalid.');
    }
  }
}
