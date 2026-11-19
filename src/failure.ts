import { ForgePilotError } from './errors';

export type FailureKind = 'budget' | 'credentials' | 'forbidden' | 'model_configuration' | 'agent_policy' | 'rate_limit' | 'daily_quota' | 'provider_unavailable' | 'network' | 'timeout' | 'sdk_stream' | 'invalid_proposal' | 'approval_denied' | 'cancelled' | 'conflict' | 'unknown';
const messages: Record<FailureKind, string> = {
  budget: 'Configured resource policy stopped this task. Pending draft authority was revoked; no unapproved changes were applied. Start a fresh authorized request after reviewing the budget.',
  credentials: 'Provider authentication failed (HTTP 401). Check the API key in TrueForge; no unapproved changes were applied.',
  forbidden: 'Provider access was denied (HTTP 403). Check model permissions in TrueForge.',
  model_configuration: 'The saved agent or model configuration is missing or invalid. Check the agent and registered model in TrueForge.',
  agent_policy: 'ForgePilot needs a dedicated agent: disable sandbox, dynamic subagents, web search, memory and generative UI; remove skills and other MCP connectors.',
  rate_limit: 'The provider rate limit was reached (HTTP 429). Wait for capacity or configure a fallback agent.',
  daily_quota: 'The provider daily quota is exhausted. Wait for the quota reset or configure a fallback agent.',
  provider_unavailable: 'The model provider is unavailable (HTTP 502/503/504). Try later or configure a fallback agent.',
  network: 'Could not reach TrueForge or the model provider. Check the local service, endpoint and network.',
  timeout: 'The request timed out. Pending proposals were invalidated; check provider availability before retrying.',
  sdk_stream: 'TrueForge turn failed or its stream did not complete successfully. Pending proposals are invalid.',
  invalid_proposal: 'The model returned an invalid proposal. Use the validation guidance and generate a fresh proposal.',
  approval_denied: 'Staging approval was rejected. No fallback was attempted.',
  cancelled: 'Request cancelled; generation failed. Pending proposals are invalid.',
  conflict: 'The document or workspace changed. Save and generate a fresh proposal; existing edits were preserved.',
  unknown: 'Operation failed. Check TrueForge and the workspace, then start a new request.',
};
export class RequestFailure extends ForgePilotError {
  readonly failureType = 'forgepilot.failure.v1';
  constructor(readonly kind: FailureKind, readonly origin: 'provider' | 'transport' | 'local', cause?: unknown, readonly httpStatus?: number) {
    super(kind === 'timeout' && origin === 'local' ? 'Waiting for developer approval timed out. Pending proposals were invalidated; no fallback was attempted.' : messages[kind], { cause });
  }
  get fallbackEligible(): boolean {
    return this.origin !== 'local' && ['credentials', 'forbidden', 'model_configuration', 'rate_limit', 'daily_quota', 'provider_unavailable', 'network', 'timeout'].includes(this.kind);
  }
}
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined;
/** Inspect only bounded error metadata, never serialize errors, headers, prompts or response bodies. */
export function httpStatus(error: unknown): number | undefined {
  let current = error;
  for (let i = 0; i < 4; i++) {
    const e = record(current); if (!e) break;
    for (const value of [e.statusCode, e.status, record(e.response)?.status]) {
      const n = typeof value === 'string' && /^\d{3}$/.test(value) ? Number(value) : value;
      if (typeof n === 'number' && Number.isInteger(n) && n >= 400 && n <= 599) return n;
    }
    current = e.cause;
  }
  return undefined;
}
export function classifyFailure(error: unknown, origin: 'provider' | 'transport' | 'local' = 'transport'): RequestFailure {
  if (error instanceof RequestFailure) return error;
  const e = record(error), cause = record(e?.cause);
  // VS Code loads the extension and test/client bundles in separate module graphs.
  if (e?.failureType === 'forgepilot.failure.v1' && typeof e.kind === 'string' && Object.hasOwn(messages, e.kind)
    && (e.origin === 'local' || e.origin === 'provider' || e.origin === 'transport')) {
    return new RequestFailure(e.kind as FailureKind, e.origin, error, httpStatus(error));
  }
  const text = [e?.message, e?.code, e?.name, cause?.message, cause?.code].filter(v => typeof v === 'string').map(v => (v as string).slice(0, 4096)).join(' ');
  // Domain errors must never switch models based on incidental HTTP-like text in a patch.
  if (error instanceof ForgePilotError || e?.name === 'WorkspaceError') {
    const kind = /cancelled|canceled/i.test(text) ? 'cancelled' : /approval rejected|staging.*reject/i.test(text) ? 'approval_denied'
      : /stale|conflict|changed externally|file changed|document changed/i.test(text) ? 'conflict'
      : /malformed|patch|anchor|proposal|batch|overlap/i.test(text) ? 'invalid_proposal' : 'unknown';
    return new RequestFailure(kind, 'local', error);
  }
  const status = httpStatus(error) ?? (origin === 'provider' ? Number(text.match(/\b(401|403|404|408|429|502|503|504)\b/)?.[1]) || undefined : undefined);
  let kind: FailureKind = 'unknown';
  if (status === 401 || origin === 'provider' && /invalid (?:api[ _-]?)?key|authentication (?:failed|error)|unauthorized/i.test(text)) kind = 'credentials';
  else if (status === 403) kind = 'forbidden';
  else if (/free-models-per-day|daily.{0,30}(?:quota|limit)|quota.{0,30}(?:daily|per.day)/i.test(text)) kind = 'daily_quota';
  else if (status === 429 || /rate.?limit|quota exceeded|resource.exhausted/i.test(text)) kind = 'rate_limit';
  else if (status && [502, 503, 504].includes(status) || origin === 'provider' && /provider.{0,20}(?:overload|unavailable)|high demand|service unavailable/i.test(text)) kind = 'provider_unavailable';
  else if (status === 408 || /timeout|timed out|ETIMEDOUT|UND_ERR_(?:CONNECT|HEADERS)_TIMEOUT/i.test(text)) kind = 'timeout';
  else if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|fetch failed|connection.?error|connection refused|network error|failed to connect|unable to connect|all connection attempts failed|cannot connect to API/i.test(text)) kind = 'network';
  else if (origin === 'provider' && (status === 404 || /model.{0,40}(?:not found|invalid|not configured|does not exist)|unknown model|bad port/i.test(text))) kind = 'model_configuration';
  else if (origin === 'provider' || /stream|TrueForgeError|parse|deserialize/i.test(text)) kind = 'sdk_stream';
  return new RequestFailure(kind, origin, error, status);
}
