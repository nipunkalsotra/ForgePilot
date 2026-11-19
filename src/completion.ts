import { ForgePilotError } from './log';
import { classifyFailure, RequestFailure } from './failure';

/** Treat SDK types as an interoperability hint, not proof that the server succeeded. */
export function requireSuccessfulCompletion(state: unknown): void {
  if (state && typeof state === 'object' && 'status' in state && state.status === 'error') {
    throw classifyFailure(state, 'provider');
  }
  if (state && typeof state === 'object' && 'status' in state && state.status === 'cancelled') throw new RequestFailure('cancelled', 'local', state);
  if (!state || typeof state !== 'object' || !('status' in state) || state.status !== 'done'
    || !('requiredActions' in state) || !Array.isArray(state.requiredActions) || state.requiredActions.length !== 0) {
    throw new RequestFailure('sdk_stream', 'local', state);
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
