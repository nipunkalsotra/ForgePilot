import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { estimatedTokens } from './context';
import { ForgePilotError } from './log';

export const budgetSchema = z.strictObject({
  mode: z.enum(['off', 'advisory', 'conservative', 'strict']).default('off'),
  taskTokens: z.number().int().min(2000).max(10000000).optional(),
  maxValidationFailures: z.number().int().min(1).max(20).default(4),
  maxRepeatedSearches: z.number().int().min(1).max(10).default(3),
  maxToolCalls: z.number().int().min(10).max(500).default(100),
  provider: z.strictObject({
    model: z.string().min(1).max(200), contextWindow: z.number().int().min(2000).max(2000000).optional(), maxOutputTokens: z.number().int().min(1).max(200000).optional(),
    inputTokensPerMinute: z.number().int().min(1).max(100000000).optional(), requestsPerMinute: z.number().int().min(1).max(10000).optional(),
    safetyMargin: z.number().min(0.05).max(0.5).default(0.2),
  }).refine(p => !p.contextWindow || !p.maxOutputTokens || p.maxOutputTokens < p.contextWindow, 'Output allowance must be below configured context window.').optional(),
});
export type BudgetConfig = z.infer<typeof budgetSchema>;
export type ActualUsage = Partial<Record<'input' | 'output' | 'cachedInput' | 'cacheWrite' | 'reasoning' | 'total', number>>;
export class BudgetStop extends ForgePilotError { constructor(message: string) { super(`Resource policy stopped this task: ${message}. Validations, staging and cleanup remain available; no draft was applied.`); } }
const fields = { input: 'totalInputTokens', output: 'totalOutputTokens', cachedInput: 'totalCacheReadTokens', cacheWrite: 'totalCacheWriteTokens', reasoning: 'totalReasoningTokens', total: 'totalTokens' } as const;
const essential = new Set(['check_drafts', 'check_batch', 'check_anchor', 'list_drafts', 'propose_drafts', 'propose_batch', 'run_command']);
const searchTools = new Set(['context_query', 'discover_files', 'list_files', 'search_workspace', 'search_code', 'lookup_symbol']);

/** Counts are cumulative per SDK turn, never deltas. Estimates never become provider quota. */
export class TokenBudgetManager {
  readonly config: BudgetConfig;
  private metricTimes = new Map<string, number>();
  private contextCompacted = false;
  private turns = new Map<string, ActualUsage>();
  private called = new Set<string>();
  private seen = new Set<string>();
  private searches = new Map<string, number>();
  private window: { at: number; input: number; requests: number }[] = [];
  private started: number;
  private estimate = 0;
  private context = 0;
  private outputBytes = 0;
  private responseBytes = 0;
  private calls = 0;
  private failures = 0;
  private validationFailures = 0;
  private malformed = false;
  private pacingUntil = 0;
  private lastContext?: { estimatedTokens: number; budget: number };
  private failure?: string;
  private retrievalReduced = false;
  private identity: { model?: string; sessionId?: string; turnId?: string } = {};
  constructor(value: unknown = {}, private readonly now: () => number = Date.now) {
    const result = budgetSchema.safeParse(value);
    if (!result.success) throw new ForgePilotError('Invalid token budget configuration; check bounded machine settings.');
    this.config = result.data; this.started = now();
  }
  get enabled() { return this.config.mode !== 'off'; }
  identify(identity: typeof this.identity) { this.identity = { ...this.identity, ...identity }; }
  profile() { return this.config.provider?.model === this.identity.model ? this.config.provider : undefined; }
  beginAttempt(prompt: string, carryEstimate = 0, carryTools = 0): void {
    this.contextCompacted = false; this.context = estimatedTokens(prompt); this.outputBytes = 0;
    this.estimate = Math.max(this.estimate, carryEstimate) + this.context;
    this.calls = Math.max(this.calls, carryTools);
  }
  actual(): ActualUsage {
    const result: ActualUsage = {}, overflow = new Set<string>();
    for (const value of this.turns.values()) for (const key of Object.keys(fields) as (keyof ActualUsage)[]) {
      if (value[key] !== undefined && !overflow.has(key)) {
        const total = (result[key] ?? 0) + value[key]!;
        if (!Number.isSafeInteger(total)) { delete result[key]; overflow.add(key); this.malformed = true; } else result[key] = total;
      }
    }
    return result;
  }
  metrics(sessionId: string, turnId: string, metrics: TrueForgeApi.TurnMetrics | undefined): void {
    const key = `${sessionId}:${turnId}`;
    if (!metrics) { if (!this.turns.has(key)) this.turns.set(key, {}); return; }
    const previous = this.turns.get(key) ?? {}, next = { ...previous };
    for (const name of Object.keys(fields) as (keyof ActualUsage)[]) {
      const value = metrics[fields[name]];
      if (value === undefined) continue;
      if (!Number.isSafeInteger(value) || value < 0 || value < (previous[name] ?? 0)) { this.malformed = true; continue; }
      next[name] = value;
    }
    this.turns.set(key, next); this.metricTimes.set(key, this.now());
    // totalTokens already includes output; cache/reasoning are separate reported dimensions.
  }
  private spent() { const a = this.actual(); return Math.max(this.estimate, a.total ?? (a.input ?? 0) + (a.output ?? 0)); }
  output(text: string): void { this.outputBytes += Buffer.byteLength(text); }
  beforeTool(tool: string, signature = ''): void {
    if (!this.enabled) return;
    if (searchTools.has(tool) && signature) {
      const key = `${tool}:${signature}`; this.searches.set(key, (this.searches.get(key) ?? 0) + 1);
      if (this.searches.get(key)! > this.config.maxRepeatedSearches && this.config.mode !== 'advisory') throw new BudgetStop('repeated identical discovery without new evidence');
    }
    if (essential.has(tool)) return;
    if (this.config.mode === 'strict' && this.malformed) throw new BudgetStop('provider metrics are malformed; remaining usage is unknown');
    if (this.config.mode === 'advisory') return;
    if (this.calls >= this.config.maxToolCalls) throw new BudgetStop('maximum tool calls reached');
    if (this.config.mode === 'strict' && this.config.taskTokens !== undefined && this.spent() >= this.config.taskTokens) throw new BudgetStop('configured task target exhausted');
    if (this.validationFailures >= this.config.maxValidationFailures) throw new BudgetStop('repeated unsuccessful validation; retain metadata and report failure');
  }
  call(id: string): void { if (!this.called.has(id)) { this.called.add(id); this.calls++; } }
  tool(id: string, tool: string, bytes: number, result?: unknown): void {
    if (this.seen.has(id)) return;
    this.seen.add(id); this.call(id);
    const safeBytes = Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : 0;
    this.responseBytes += safeBytes;
    this.context += Math.ceil((safeBytes + this.outputBytes) / 3); this.outputBytes = 0;
    // Repeated conversation input is estimated once per response boundary. SDK schemas/internal prompts are UNKNOWN.
    this.estimate = Math.min(Number.MAX_SAFE_INTEGER, this.estimate + this.context);
    this.window.push({ at: this.now(), input: this.context, requests: 1 });
    if (this.window.length > 500) this.window.shift();
    const data = result && typeof result === 'object' ? result as Record<string, unknown> : undefined;
    if (tool === 'context_query') this.retrievalReduced = data?.retrievalReduced === true;
    if (tool === 'context_query' && typeof data?.estimatedTokens === 'number' && typeof data.budget === 'number') this.lastContext = { estimatedTokens: data.estimatedTokens, budget: data.budget };
    if (['draft_file', 'extend_draft', 'check_drafts', 'check_batch'].includes(tool) && typeof data?.valid === 'boolean') {
      if (data.valid) this.validationFailures = 0; else { this.validationFailures++; this.failures++; }
    }
  }
  retrievalBudget(configured: number): number {
    if (!this.enabled || this.config.mode === 'advisory') return configured;
    const remaining = this.config.taskTokens === undefined ? Infinity : this.config.taskTokens - this.spent();
    const windowRemaining = this.profile()?.contextWindow === undefined ? Infinity : this.profile()!.contextWindow! - this.context - (this.profile()?.maxOutputTokens ?? 2000);
    return Math.max(2000, Math.min(configured, Math.floor(remaining / 4), Math.floor(windowRemaining / 3)));
  }
  compact(): void { this.context = 0; this.contextCompacted = true; /* TrueForge owns the replacement summary; its token size is unknown. */ }
  pacing(ms: number): void { this.pacingUntil = this.now() + Math.max(0, ms); }
  fail(category: string): void { this.failure = category; }
  pacingMs(): number {
    if (!this.enabled) return 0;
    const profile = this.profile(); if (!profile) return 0;
    const now = this.now(); this.window = this.window.filter(v => now - v.at < 60000);
    // Post-turn input counts are authoritative snapshots, not individual request timing.
    // Use the greater of actual and tool-response estimates, never add the two representations.
    const actualInput = [...this.turns.entries()].filter(([key]) => now - (this.metricTimes.get(key) ?? -Infinity) < 60000).reduce((n, [, value]) => n + (value.input ?? 0), 0);
    if (profile.inputTokensPerMinute && actualInput > profile.inputTokensPerMinute * (1 - profile.safetyMargin)) {
      const oldest = Math.min(...[...this.metricTimes.values()].filter(at => now - at < 60000));
      return Math.max(0, 60000 - (now - oldest));
    }
    let input = 0, requests = 0;
    for (let i = this.window.length - 1; i >= 0; i--) {
      const v = this.window[i]!; input += v.input; requests += v.requests;
      if (profile.inputTokensPerMinute && input > profile.inputTokensPerMinute * (1 - profile.safetyMargin)
        || profile.requestsPerMinute && requests >= Math.max(1, Math.floor(profile.requestsPerMinute * (1 - profile.safetyMargin)))) return Math.max(0, 60000 - (now - v.at));
    }
    return 0;
  }
  async pace(signal: AbortSignal, update: () => void = () => {}): Promise<void> {
    const ms = this.pacingMs(); if (!ms || this.config.mode === 'advisory') return;
    this.pacingUntil = this.now() + ms; update();
    try { await delay(ms, undefined, { signal }); } finally { this.pacingUntil = 0; update(); }
  }
  snapshot() {
    const spent = this.spent(), target = this.config.taskTokens, profile = this.profile();
    const remaining = target === undefined ? undefined : Math.max(0, target - spent);
    const warning = !this.enabled ? '' : this.failure ? `Provider/request failure: ${this.failure}` : this.config.provider && !profile ? 'Configured profile model does not match; limits UNKNOWN' : target !== undefined && spent >= target ? 'Configured task target exhausted; complete validation/staging or stop' : target !== undefined && spent >= target * 0.7 ? 'Validation/correction/completion reserve in use; reduce discovery' : '';
    return { ...this.identity, mode: this.config.mode, configuredTaskTokens: target, actual: this.actual(), estimatedTokens: this.estimate, policyTokens: spent,
      estimatedRemaining: remaining, providerQuota: 'UNKNOWN' as const, contextWindow: profile?.contextWindow,
      estimatedContextTokens: this.context, contextStatus: this.contextCompacted ? 'UNKNOWN after TrueForge compaction; re-read evidence' : profile?.contextWindow ? (this.context >= profile.contextWindow * 0.7 ? 'reduce retrieval' : 'within configured window') : 'UNKNOWN window',
      contextPackage: this.lastContext, toolCalls: this.calls, toolResponseBytes: this.responseBytes, validationFailures: this.failures,
      actualComplete: this.turns.size > 0 && [...this.turns.values()].every(v => v.total !== undefined || v.input !== undefined && v.output !== undefined),
      elapsedMs: this.now() - this.started, pacingMs: Math.max(0, this.pacingUntil - this.now()), warning: warning || (this.retrievalReduced ? 'Context retrieval reduced to protect remaining budget' : ''), retrievalReduced: this.retrievalReduced, malformedMetrics: this.malformed,
      pacingStatus: profile?.inputTokensPerMinute || profile?.requestsPerMinute ? this.pacingUntil > this.now() ? 'active' : 'configured local estimates' : 'UNKNOWN limits',
      configuredProvider: profile, methodology: 'ESTIMATED UTF-8 bytes/3 with repeated input per tool response; tool schemas, internal prompts and live provider usage UNKNOWN. ACTUAL replaces cumulative snapshots per turn; cache/reasoning not added to total.',
      allocation: { discovery: 'reduce after initial query', inspection: 'target missing evidence', implementation: remaining !== undefined && remaining < (target ?? 0) * 0.3 ? 'reserve in use' : 'available', validation: 'essential', correction: 'bounded', completion: 'essential' } };
  }
}
export type BudgetSnapshot = ReturnType<TokenBudgetManager['snapshot']>;
