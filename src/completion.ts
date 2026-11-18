import { ForgePilotError } from './log';

/** Treat SDK types as an interoperability hint, not proof that the server succeeded. */
export function requireSuccessfulCompletion(state: unknown): void {
  if (!state || typeof state !== 'object' || !('status' in state) || state.status !== 'done'
    || !('requiredActions' in state) || !Array.isArray(state.requiredActions) || state.requiredActions.length !== 0) {
    throw new ForgePilotError('TrueForge turn failed or did not complete successfully. Pending proposals are invalid.');
  }
}
