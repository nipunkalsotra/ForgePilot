import { randomBytes } from 'node:crypto';
import { TrueForge, type TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { Companion } from './companion';
import { localBaseUrl } from './config';
import { EventRenderer } from './events';
import { ForgePilotError, type Logger } from './log';

export interface BridgeOptions {
  baseUrl: string;
  agentName: string;
  root: string;
  childPath: string;
  token?: string;
  turnTimeoutSeconds?: number;
  log: Logger;
}

export class Bridge {
  readonly client: TrueForge;
  readonly companion: Companion;
  readonly connectorName = `forgepilot-${randomBytes(8).toString('hex')}`;
  sessionId?: string;
  modelName?: string;
  private agentId?: string;
  private registered = false;
  private attached = false;
  private active?: { controller: AbortController; done: Promise<void> };
  private stopping?: Promise<void>;
  private started = false;
  private cancelling?: Promise<void>;
  private readonly deadline: number;

  constructor(private readonly options: BridgeOptions) {
    this.deadline = options.turnTimeoutSeconds ?? 180;
    if (!Number.isFinite(this.deadline) || this.deadline < 10 || this.deadline > 600) throw new ForgePilotError('Turn timeout must be 10–600 seconds.');
    this.client = new TrueForge({ baseUrl: localBaseUrl(options.baseUrl), token: options.token,
      timeoutInSeconds: 10, maxRetries: 0 });
    this.companion = new Companion(options.childPath, options.log);
  }

  private validateAgent(manifest: TrueForgeApi.AgentSpec): void {
    if ((manifest.mcpServers ?? []).some(s => s.name !== this.connectorName)
      || manifest.skills?.length || manifest.config?.sandbox?.enabled !== false
      || manifest.config?.dynamicSubAgents?.enabled !== false || manifest.config?.webSearch?.enabled !== false
      || manifest.config?.memory?.enabled !== false || manifest.config?.generativeUi?.enabled !== false) {
      throw new ForgePilotError('Phase 1 needs a dedicated agent: explicitly disable sandbox, dynamic subagents, web search, memory and generative UI, remove skills and other MCP connectors. Stop other ForgePilot sessions first. See README.');
    }
  }

  async start(): Promise<string> {
    if (this.started || this.stopping) throw new ForgePilotError('Create a new bridge to start another session.');
    this.started = true;
    try {
      const agents = await this.client.agents.list({ agentName: this.options.agentName });
      for await (const agent of agents) {
        if (agent.name === this.options.agentName) { this.agentId = agent.id; break; }
      }
      if (!this.agentId) throw new ForgePilotError(`Saved agent '${this.options.agentName}' was not found. Create it in TrueForge first (README).`);
      const { data: agent } = await this.client.agents.get(this.agentId);
      this.validateAgent(agent.manifest);
      this.modelName = agent.manifest.model.name;
      const url = await this.companion.start(this.options.root);
      // Mark before writes so an ambiguous response/timeout still attempts rollback.
      this.registered = true;
      await this.client.settings.mcpServers.create({ manifest: {
        type: 'remote', name: this.connectorName, description: 'ForgePilot bounded read-only workspace tools (temporary local connector)', url,
        auth: { type: 'header', headers: { Authorization: `Bearer ${this.companion.token}` } },
      } });
      const tools = await this.client.mcpServers.listTools(this.connectorName);
      const expected = ['list_files', 'read_file', 'search_workspace'];
      if (!expected.every(name => tools.data.some(t => t.name === name)) || tools.data.length !== 3) {
        throw new ForgePilotError('TrueForge did not discover exactly the three read-only workspace tools.');
      }
      // Re-read before replacing the manifest to reduce lost updates. TrueForge has no conditional-update API.
      const { data: fresh } = await this.client.agents.get(this.agentId);
      this.validateAgent(fresh.manifest);
      this.attached = true;
      await this.client.agents.update(this.agentId, { manifest: { ...fresh.manifest, mcpServers: [{
        name: this.connectorName, enableTools: expected, preload: true, requireApprovalForTools: [],
      }] } });
      const { data: session } = await this.client.sessions.create({ agent: { name: this.options.agentName }, metadata: { client: 'ForgePilot', phase: '1' } });
      this.sessionId = session.id;
      this.options.log('session.created', { sessionId: session.id, agent: this.options.agentName, model: this.modelName, connector: this.connectorName });
      return session.id;
    } catch (error) { await this.stop(); throw error; }
  }

  async ask(prompt: string, write: (text: string) => void, onEvent?: (event: TrueForgeApi.TurnStreamingEvent) => void): Promise<void> {
    if (this.stopping || !this.sessionId || !this.agentId || !this.companion.url) throw new ForgePilotError('Start a ForgePilot session first.');
    if (this.active) throw new ForgePilotError('A turn is already running. Cancel it before starting another.');
    if (!prompt.trim() || prompt.length > 16_000) throw new ForgePilotError('Enter an instruction of 1–16,000 characters.');
    const sessionId = this.sessionId;
    const agentId = this.agentId;
    const controller = new AbortController();
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    this.active = { controller, done };
    const timer = setTimeout(() => controller.abort(), this.deadline * 1000);
    const renderer = new EventRenderer(write, this.options.log);
    try {
      const { data: current } = await this.client.agents.get(agentId, { abortSignal: controller.signal });
      this.validateAgent(current.manifest);
      if (!current.manifest.mcpServers?.some(s => s.name === this.connectorName)) throw new ForgePilotError('Workspace connector was detached. Stop and start the session again.');
      const stream = await this.client.sessions.createTurnStream(sessionId, {
        input: [{ type: 'user.message', content: prompt }],
      }, { abortSignal: controller.signal, timeoutInSeconds: this.deadline, maxRetries: 0 });
      for await (const event of stream) { onEvent?.(event); renderer.accept(event); }
      if (!renderer.terminal) throw new ForgePilotError('TrueForge stream ended without a terminal turn event. Inspect the session before retrying.');
    } catch (error) {
      // Closing a socket alone does not stop TrueForge's agent. Always request backend cancellation.
      await this.cancelBackend();
      if (controller.signal.aborted) throw new ForgePilotError('Turn cancelled or its deadline expired. Workspace files were not modified.');
      throw error;
    } finally {
      clearTimeout(timer);
      this.active = undefined;
      finish();
    }
  }

  private cancelBackend(): Promise<void> {
    this.cancelling ??= this.performCancellation().finally(() => { this.cancelling = undefined; });
    return this.cancelling;
  }

  private async performCancellation(): Promise<void> {
    if (!this.sessionId) return;
    try {
      await this.client.sessions.cancel(this.sessionId, { timeoutInSeconds: 5, maxRetries: 0 });
      this.options.log('session.cancelled', { sessionId: this.sessionId });
    } catch {
      this.options.log('session.cancel.failed', { sessionId: this.sessionId });
      // Closing the companion revokes workspace access if TrueForge cannot acknowledge cancellation.
      await this.companion.stop();
    }
  }

  async cancel(): Promise<void> {
    const active = this.active;
    if (!active) return;
    active.controller.abort();
    await this.cancelBackend();
    await active.done;
  }

  stop(): Promise<void> {
    this.stopping ??= this.cleanup();
    return this.stopping;
  }

  private async cleanup(): Promise<void> {
    try {
      await this.cancel();
      if (this.attached && this.agentId) {
        const { data: agent } = await this.client.agents.get(this.agentId);
        if (agent.manifest.mcpServers?.some(s => s.name === this.connectorName)) {
          await this.client.agents.update(this.agentId, { manifest: { ...agent.manifest,
            mcpServers: agent.manifest.mcpServers.filter(s => s.name !== this.connectorName) } });
        }
        this.attached = false;
      }
      if (this.registered) {
        try { await this.client.settings.mcpServers.delete(this.connectorName); }
        catch (error) {
          if (!(typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 404)) throw error;
        }
        this.registered = false;
      }
    } catch {
      this.options.log('registration.cleanup.failed', { connector: this.connectorName });
      throw new ForgePilotError(`Local MCP access is closed, but TrueForge registry cleanup failed. Remove '${this.connectorName}' from the agent and Settings → Connectors manually.`);
    } finally {
      await this.companion.stop();
      this.options.log('bridge.stopped', { sessionId: this.sessionId });
    }
  }
}
