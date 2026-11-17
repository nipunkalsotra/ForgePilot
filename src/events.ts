import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { ForgePilotError, type Logger } from './log';

/** Render provider text deltas immediately; final messages are not printed twice. */
export class EventRenderer {
  terminal = false;
  private deltas = new Set<string>();
  constructor(private readonly write: (text: string) => void, private readonly log: Logger) {}

  accept(event: TrueForgeApi.TurnStreamingEvent): void {
    switch (event.type) {
      case 'model.message.delta':
        if (event.content) { this.deltas.add(event.threadId); this.write(event.content); }
        break;
      case 'model.message':
        if (!this.deltas.delete(event.threadId) && typeof event.content === 'string') this.write(event.content);
        if (event.toolCalls?.length) {
          for (const tool of event.toolCalls) {
            this.log('agent.tool_call', { tool: tool.function.name, callId: tool.id });
            this.write(`\n[tool: ${tool.function.name}]\n`);
          }
        }
        break;
      case 'tool.response':
        this.log('agent.tool_response', { callId: event.toolCallId });
        this.write('\n[tool response received]\n');
        break;
      case 'turn.done':
        this.terminal = true;
        this.log('turn.done', { status: event.state.status });
        this.write(`\n[turn ${event.state.status}]\n`);
        if (event.state.status === 'error') throw new ForgePilotError('TrueForge turn failed. Check the session and model provider in TrueForge.');
        break;
      case 'tool.approval_required':
      case 'tool.response_required':
      case 'mcp.auth_required':
        throw new ForgePilotError(`TrueForge paused (${event.type}). Phase 1 cannot answer interactive requests. Review the session in TrueForge; this turn will be cancelled.`);
    }
  }
}
