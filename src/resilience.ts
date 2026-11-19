import { Bridge, type BridgeOptions } from './bridge';
import { PatchStore } from './patch';
import type { BatchPatch, BatchStore } from './batch';
import { classifyFailure, RequestFailure } from './failure';
import { ForgePilotError } from './log';

export type AgentConnection = Pick<Bridge, 'sessionId' | 'modelName' | 'lastTurnMetrics' | 'ask' | 'propose' | 'autonomous' | 'cancel' | 'stop'>;
export interface RecoveryOptions { enabled: boolean; agentName: string; notify?: (message: string) => void }
export interface RecoveryTrace { agent: string; sessionId?: string; model?: string; connector?: string; metrics?: Bridge['lastTurnMetrics']; outcome: 'ready' | 'succeeded' | 'failed'; failure?: string }

/** Coordinates at most two TrueForge sessions; all inference and tool execution stay inside TrueForge. */
export class ResilientBridge implements AgentConnection {
  private current?: Bridge;
  private busy = false;
  private stopped = false;
  private request?: AbortController;
  private cleanup?: Promise<void>;
  private prepared = false;
  private traces: RecoveryTrace[] = [];
  get sessionId() { return this.current?.sessionId; }
  get modelName() { return this.current?.modelName; }
  get lastTurnMetrics() { return this.current?.lastTurnMetrics; }
  get evidence(): RecoveryTrace[] { return structuredClone(this.traces); }
  constructor(private readonly options: BridgeOptions, private readonly recovery: RecoveryOptions,
    private readonly factory: (options: BridgeOptions) => Bridge = options => new Bridge(options)) {
    if (recovery.enabled && (!recovery.agentName.trim() || recovery.agentName === options.agentName)) throw new ForgePilotError('Configure a distinct fallbackAgentName before enabling fallback.');
  }
  async start(): Promise<string> {
    const id = await this.execute(async bridge => bridge.sessionId!, () => {});
    this.prepared = this.traces.length === 1; return id;
  }
  private check(signal: AbortSignal): void { if (signal.aborted || this.stopped) throw new RequestFailure('cancelled', 'local'); }
  private async closeCurrent(): Promise<void> {
    const selected = this.current;
    if (!selected) return;
    // Bridge.stop revokes the companion even when registry cleanup fails. Do not switch if cleanup fails.
    await selected.stop();
    if (this.current === selected) this.current = undefined;
  }
  private async execute<T>(operation: (bridge: Bridge, signal: AbortSignal) => Promise<T>, invalidate: () => void): Promise<T> {
    if (this.stopped) throw new ForgePilotError('Start a new ForgePilot session.');
    if (this.busy) throw new ForgePilotError('A request is already running. Cancel it before starting another.');
    this.busy = true; const controller = new AbortController(); this.request = controller; this.traces = [];
    let succeeded = false;
    let primaryFailure: RequestFailure | undefined;
    try {
      // Each user request gets fresh execution state, including after a failed previous request.
      const prepared = this.prepared ? this.current : undefined; this.prepared = false;
      if (!prepared) await this.closeCurrent(); this.check(controller.signal);
      for (let attempt = 0; attempt < 2; attempt++) {
        this.check(controller.signal);
        const agent = attempt === 0 ? this.options.agentName : this.recovery.agentName;
        const selected = attempt === 0 && prepared ? prepared : this.factory({ ...this.options, agentName: agent, isolated: true });
        this.current = selected;
        const trace: RecoveryTrace = { agent, outcome: 'ready' }; this.traces.push(trace);
        try {
          if (selected !== prepared) await selected.start(); this.check(controller.signal);
          trace.sessionId = selected.sessionId; trace.model = selected.modelName; trace.connector = selected.connectorName;
          this.options.log('request.session', { sessionId: trace.sessionId, model: trace.model, agent, attempt });
          const result = await operation(selected, controller.signal); this.check(controller.signal);
          trace.metrics = selected.lastTurnMetrics; trace.outcome = 'succeeded'; succeeded = true; return result;
        } catch (error) {
          const failure = controller.signal.aborted ? new RequestFailure('cancelled', 'local', error) : classifyFailure(error);
          trace.sessionId = selected.sessionId; trace.model = selected.modelName; trace.connector = selected.connectorName; trace.metrics = selected.lastTurnMetrics; trace.outcome = 'failed'; trace.failure = failure.kind;
          this.options.log('request.failed', { kind: failure.kind, status: failure.httpStatus, attempt, sessionId: trace.sessionId });
          // Operation-local stores are cancelled before this point; no failed state is adopted by the UI.
          await this.closeCurrent(); this.check(controller.signal);
          if (attempt !== 0) {
            const exhausted = new RequestFailure(failure.kind, 'local', new AggregateError([primaryFailure, failure], 'Both configured agents failed.'), failure.httpStatus);
            exhausted.message = `Primary and configured fallback failed (${primaryFailure?.kind}; ${failure.kind}). ${failure.message}`;
            throw exhausted;
          }
          if (!this.recovery.enabled || !failure.fallbackEligible) throw failure;
          primaryFailure = failure;
          this.options.log('fallback.preparing', { agent: this.recovery.agentName });
          this.recovery.notify?.(`Provider failure (${failure.kind}). Switching to configured agent ${this.recovery.agentName}; fresh staging and hunk approval will be required.`);
          this.check(controller.signal);
        }
      }
      throw new RequestFailure('unknown', 'local');
    } finally {
      if (!succeeded) invalidate();
      this.request = undefined; this.busy = false;
    }
  }
  async ask(...args: Parameters<Bridge['ask']>): Promise<void> {
    await this.execute((bridge, signal) => bridge.ask(args[0], text => { if (!signal.aborted) args[1](text); }, args[2]), () => {});
  }
  async propose(store: PatchStore, ...args: [string, Parameters<Bridge['propose']>[2], Parameters<Bridge['propose']>[3]]): Promise<void> {
    await this.execute(async (bridge, signal) => {
      const candidate = new PatchStore(store.workspace, store.snapshot);
      try {
        await bridge.propose(candidate, args[0], text => { if (!signal.aborted) args[1](text); }, args[2]);
        this.check(signal);
        if (!candidate.current) throw new RequestFailure('invalid_proposal', 'local');
        await store.stage(candidate.current.patch, true); this.check(signal);
      } finally { candidate.cancel(); }
    }, () => store.cancel());
  }
  async autonomous(store: BatchStore, ...args: [string, Parameters<Bridge['autonomous']>[2], Parameters<Bridge['autonomous']>[3], Parameters<Bridge['autonomous']>[4]?, Parameters<Bridge['autonomous']>[5]?, Parameters<Bridge['autonomous']>[6]?]): Promise<void> {
    await this.execute(async (bridge, signal) => {
      const candidate = store.fork(); let approved: BatchPatch | undefined;
      try {
        await bridge.autonomous(candidate, args[0], text => { if (!signal.aborted) args[1](text); }, async (patch, approvalSignal) => {
          const allow = await args[2](patch, approvalSignal);
          if (allow && !signal.aborted && !approvalSignal.aborted) approved = structuredClone(patch);
          return allow;
        }, event => { if (!signal.aborted) args[3]?.(event); }, args[4], args[5]);
        this.check(signal);
        if (!candidate.current && args[5]?.allowNoProposal) return;
        if (!candidate.current?.generationSucceeded || !approved) throw new RequestFailure('invalid_proposal', 'local');
        await store.stage(approved, true); this.check(signal); store.complete();
      } finally { candidate.cancel(); }
    }, () => store.cancel());
  }
  async cancel(): Promise<void> {
    this.request?.abort(); await this.current?.cancel();
  }
  stop(): Promise<void> {
    this.stopped = true; this.request?.abort();
    this.cleanup ??= this.closeCurrent(); return this.cleanup;
  }
}
