import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';
import type { BatchProposal } from './batch';
import { sanitizeCommandOutput } from './terminal';
import type { ContextPackage } from './context';

export type SessionState = 'idle' | 'running' | 'awaiting approval' | 'completed' | 'failed' | 'cancelled';
export interface ConversationMessage { id: string; role: 'user' | 'assistant'; text: string }
export interface ToolActivity { id: string; name: string; phase: string; detail: string }
export interface ProposalSummary { id: string; status: string; files: { id: string; path: string; operation: string; accepted: number; rejected: number; pending: number }[] }
export const panelMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('ready'), viewId: z.string().uuid() }),
  z.strictObject({ type: z.enum(['cancel', 'newSession', 'context', 'review', 'apply', 'undo']), sessionId: z.string().uuid(), requestId: z.string().uuid().nullable() }),
  z.strictObject({ type: z.literal('submit'), sessionId: z.string().uuid(), requestId: z.string().uuid().nullable(), text: z.string().trim().min(1).max(16000) }),
  z.strictObject({ type: z.literal('diff'), sessionId: z.string().uuid(), requestId: z.string().uuid().nullable(), fileId: z.string().uuid() }),
]);

/** Presentation state only. No approvals or editor authority live here. */
export class PanelState {
  sessionId = randomUUID();
  requestId: string | null = null;
  state: SessionState = 'idle';
  model = 'Saved TrueForge agent';
  backendSession = '';
  messages: ConversationMessage[] = [];
  tools: ToolActivity[] = [];
  proposal: ProposalSummary | null = null;
  error = '';
  private assistant?: ConversationMessage;
  private deltaThreads = new Set<string>();
  private listeners = new Set<(event: object) => void>();
  subscribe(listener: (event: object) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(event: object): void { for (const listener of this.listeners) listener({ ...event, sessionId: this.sessionId, requestId: this.requestId }); }
  snapshot() { return structuredClone({ sessionId: this.sessionId, requestId: this.requestId, state: this.state, model: this.model, backendSession: this.backendSession, messages: this.messages, tools: this.tools, proposal: this.proposal, error: this.error }); }
  get busy() { return this.state === 'running' || this.state === 'awaiting approval'; }
  reset(): void { this.sessionId = randomUUID(); this.requestId = null; this.state = 'idle'; this.messages = []; this.tools = []; this.proposal = null; this.error = ''; this.assistant = undefined; this.backendSession = ''; this.model = 'Saved TrueForge agent'; this.deltaThreads.clear(); this.emit({ type: 'snapshot', value: this.snapshot() }); }
  begin(text: string): string {
    this.requestId = randomUUID(); this.error = ''; this.proposal = null; this.assistant = undefined; this.tools = []; this.deltaThreads.clear();
    if (this.messages.length >= 40) this.messages.splice(0, this.messages.length - 38);
    this.messages.push({ id: randomUUID(), role: 'user', text }); this.state = 'running';
    this.emit({ type: 'snapshot', value: this.snapshot() }); return this.requestId;
  }
  current(id: string): boolean { return id === this.requestId; }
  status(state: SessionState, error = ''): void {
    this.state = state; this.error = error;
    if (['cancelled', 'failed'].includes(state)) {
      this.proposal = null;
      for (const tool of [...this.tools]) if (['running', 'approved', 'awaiting approval', 'requested'].includes(tool.phase)) this.tool(tool.id, tool.name, state, tool.detail);
    }
    this.emit({ type: 'status', state, error });
  }
  cancel(): void { this.status('cancelled'); this.requestId = null; this.emit({ type: 'snapshot', value: this.snapshot() }); }
  private text(text: string): void {
    if (!text) return;
    if (!this.assistant) { this.assistant = { id: randomUUID(), role: 'assistant', text: '' }; this.messages.push(this.assistant); this.emit({ type: 'message', value: this.assistant }); }
    const addition = text.slice(0, Math.max(0, 48000 - this.assistant.text.length));
    this.assistant.text += addition; if (addition) this.emit({ type: 'append', id: this.assistant.id, text: addition });
  }
  stream(event: TrueForgeApi.TurnStreamingEvent, identity: { sessionId?: string; modelName?: string }): void {
    const changed = identity.sessionId !== this.backendSession || identity.modelName !== this.model;
    if (identity.sessionId !== this.backendSession) {
      this.assistant = undefined; this.deltaThreads.clear();
      if (this.backendSession) for (const tool of [...this.tools]) if (['running', 'approved', 'awaiting approval', 'requested'].includes(tool.phase)) this.tool(tool.id, tool.name, 'cancelled', 'Prior TrueForge session closed; approval was revoked before fallback.');
    }
    this.backendSession = identity.sessionId ?? ''; this.model = identity.modelName ?? this.model;
    if (changed) this.emit({ type: 'identity', model: this.model, backendSession: this.backendSession });
    if (event.type === 'model.message.delta' && event.content) { this.deltaThreads.add(event.threadId); this.text(event.content); }
    if (event.type === 'model.message') {
      if (!this.deltaThreads.delete(event.threadId) && typeof event.content === 'string') this.text(event.content);
      for (const call of event.toolCalls ?? []) {
        let name = call.toolInfo.name;
        if (call.function.name === 'call_tool') { try { const input = JSON.parse(call.function.arguments) as { tool_name?: unknown }; if (typeof input.tool_name === 'string') name = input.tool_name; } catch { /* Arguments remain untrusted. */ } }
        this.tool(call.id, name, 'requested', 'TrueForge tool call');
      }
      this.assistant = undefined;
    }
    if (event.type === 'tool.approval_required' || event.type === 'tool.response_required') this.status('awaiting approval');
    if (event.type === 'tool.response') this.status('running');
  }
  tool(id: string, name: string, phase: string, detail = ''): void {
    let activity = this.tools.find(t => t.id === id);
    if (!activity) { if (this.tools.length >= 150) return; activity = { id, name, phase, detail: '' }; this.tools.push(activity); }
    activity.name = name.slice(0, 150); activity.phase = phase; activity.detail = sanitizeCommandOutput(detail).slice(0, 14000);
    this.emit({ type: 'tool', value: activity });
  }
  observation(event: { tool: string; callId: string; result: unknown; responseBytes: number; context?: ContextPackage }): void {
    const result = event.result as { kind?: string; exitCode?: number; termination?: string; stdout?: string; stderr?: string; truncated?: boolean; valid?: boolean; error?: unknown } | null;
    if (event.tool === 'run_command') {
      if (this.tools.find(t => t.id === event.callId)?.phase === 'rejected' || result?.termination === 'denied') {
        this.tool(event.callId, event.tool, 'rejected', 'Developer denied this command. No execution was authorized.'); return;
      }
      if (result?.kind !== 'forgepilot.command') { this.tool(event.callId, event.tool, 'failed', 'No verified command execution result was received.'); return; }
      this.tool(event.callId, event.tool, result.termination === 'cancelled' ? 'cancelled' : result.exitCode === 0 && result.termination === 'exited' ? 'completed' : 'failed',
        `Exit: ${result.exitCode ?? 'none'} · ${result.termination}${result.truncated ? ' · OUTPUT TRUNCATED' : ''}\nstdout:\n${result.stdout ?? ''}\nstderr:\n${result.stderr ?? ''}`); return;
    }
    this.tool(event.callId, event.tool, result?.valid === false || result?.error ? 'failed' : 'completed',
      event.context ? `Repository context: ~${event.context.estimatedTokens}/${event.context.budget} tokens. Inspect Context for selected files and reasons.` : `${event.responseBytes} response bytes`);
  }
  proposalChanged(proposal?: BatchProposal): void {
    this.proposal = !proposal || proposal.status === 'cancelled' || !proposal.generationSucceeded ? null : {
      id: proposal.id, status: proposal.status === 'applied' && proposal.files.some(f => f.hunks.some(h => h.decision === 'rejected')) ? 'partially applied' : proposal.status,
      files: proposal.files.map(f => ({ id: f.id, path: f.path, operation: f.operation, accepted: f.hunks.filter(h => h.decision === 'accepted').length,
        rejected: f.hunks.filter(h => h.decision === 'rejected').length, pending: f.hunks.filter(h => h.decision === 'pending').length })) };
    this.emit({ type: 'proposal', value: this.proposal });
  }
}
