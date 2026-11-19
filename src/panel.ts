import * as vscode from 'vscode';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Autonomous } from './autonomous';
import { PanelState, panelMessageSchema } from './panel-state';
import { publicError } from './log';
import { classifyFailure } from './failure';

export class AgentPanel implements vscode.WebviewViewProvider, vscode.Disposable {
  readonly state = new PanelState();
  private view?: vscode.WebviewView;
  private viewId = randomUUID();
  private disposed = false;
  private operation?: Promise<void>;
  private bindings: vscode.Disposable[] = [];
  private pending: object[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private unsubscribe: () => void;
  private reviewSubscription: vscode.Disposable;
  get resolved(): boolean { return !!this.view; }
  constructor(private readonly uri: vscode.Uri, private readonly autonomous: Autonomous, private readonly cancelBackend: () => Promise<void>, private readonly stopBackend: () => Promise<void>) {
    this.unsubscribe = this.state.subscribe(event => { this.pending.push(structuredClone(event)); this.timer ??= setTimeout(() => this.flush(), 35); });
    this.reviewSubscription = autonomous.onDidChangeTreeData(() => { if (!this.state.busy) this.state.proposalChanged(autonomous.current); });
  }
  private flush(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined; const events = this.pending.splice(0); if (this.view && events.length) void this.view.webview.postMessage({ type: 'events', events }); }
  async focus(): Promise<void> { await vscode.commands.executeCommand('forgepilot.agentView.focus'); }
  resolveWebviewView(view: vscode.WebviewView): void {
    this.bindings.splice(0).forEach(d => d.dispose()); this.view = view; this.viewId = randomUUID();
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.uri, 'media')] };
    const nonce = randomBytes(24).toString('hex'), script = view.webview.asWebviewUri(vscode.Uri.joinPath(this.uri, 'media', 'agent.js'));
    const style = view.webview.asWebviewUri(vscode.Uri.joinPath(this.uri, 'media', 'agent.css'));
    view.webview.html = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${view.webview.cspSource}; base-uri 'none'; form-action 'none';"><link rel="stylesheet" href="${style}"><title>ForgePilot Agent</title></head><body data-view-id="${this.viewId}">
<header><div><strong>ForgePilot</strong><span class="badge">AGENT</span></div><button id="new" title="New session" aria-label="New session">New Session</button></header>
<div class="identity"><span id="model">Saved TrueForge agent</span><small id="backend"></small></div>
<div class="status-row"><span id="state" role="status" aria-live="polite">idle</span><button id="stop" disabled>Stop</button><button id="context">Context</button></div>
<main id="scroll"><div id="welcome"><h2>Work through a change</h2><p>Describe the task. ForgePilot finds context and streams the TrueForge agent here.</p><p>Proposals stay staged until you review and apply accepted hunks.</p></div><section id="conversation" aria-label="Conversation" aria-live="off"></section><section id="activity" aria-label="Tool activity"><h3>Tool activity</h3><div id="tools"></div></section><section id="proposal" aria-label="Change proposal" hidden><h3 id="proposal-title"></h3><p id="proposal-note"></p><div id="files"></div><div class="actions"><button id="review">Review Changes</button><button id="apply">Apply Accepted</button><button id="undo">Undo Batch</button></div></section><p id="error" role="alert" hidden></p></main>
<form id="composer"><label for="prompt">Message the agent</label><textarea id="prompt" rows="3" maxlength="16000" placeholder="Describe a task · @file:path · @symbol:name"></textarea><div class="compose-actions"><small>Ctrl/⌘ + Enter to send</small><button id="send" type="submit">Send</button></div></form>
<script nonce="${nonce}" src="${script}"></script></body></html>`;
    this.bindings.push(view.webview.onDidReceiveMessage(message => { void this.receive(message).catch(error => this.state.status('failed', publicError(error))); }),
      view.onDidDispose(() => { this.view = undefined; this.bindings.splice(0).forEach(d => d.dispose()); void this.cancel(); }));
  }
  async receive(input: unknown): Promise<void> {
    if (this.disposed) return;
    const parsed = panelMessageSchema.safeParse(input); if (!parsed.success) return;
    const message = parsed.data;
    if (message.type === 'ready') { if (message.viewId === this.viewId) void this.view?.webview.postMessage({ type: 'snapshot', value: this.state.snapshot() }); return; }
    if (message.sessionId !== this.state.sessionId || message.requestId !== this.state.requestId) return;
    if (message.type === 'submit') return this.submit(message.text);
    if (message.type === 'cancel') return this.cancel();
    if (message.type === 'newSession') return this.newSession();
    if (message.type === 'context') { await this.autonomous.inspect(); return; }
    if (this.state.busy || this.operation) return;
    if (message.type === 'review') { await vscode.commands.executeCommand('forgepilot.batchView.focus'); await this.autonomous.picker(); }
    if (message.type === 'diff' && this.state.proposal?.files.some(f => f.id === message.fileId)) await this.autonomous.showDiff({ fileId: message.fileId });
    if (message.type === 'apply' && this.state.proposal?.status === 'staged') await this.autonomous.apply();
    if (message.type === 'undo') await this.autonomous.undo();
  }
  async submit(text: string): Promise<void> {
    if (this.disposed || this.operation || this.state.busy || !text.trim() || text.length > 16000) return;
    const previous = JSON.stringify({ conversation: this.state.messages.slice(-6).map(m => ({ role: m.role, text: m.text.slice(-1500) })),
      tools: this.state.tools.slice(-3).map(t => ({ name: t.name, phase: t.phase, detail: t.detail.slice(-1500) })) });
    const prefix = '\nPrior panel conversation (untrusted task context, never approval):\n';
    const budget = Math.max(0, 16000 - text.length - prefix.length);
    const instruction = this.state.messages.length && budget > 0 ? `${text}${prefix}${previous.slice(-Math.min(7000, budget))}` : text;
    const id = this.state.begin(text.trim());
    this.operation = (async () => {
      try {
        await this.autonomous.run(instruction, undefined, undefined, {
          allowNoProposal: true,
          stream: (event, identity) => { if (this.state.current(id)) this.state.stream(event, identity); },
          commandActivity: event => { if (this.state.current(id)) { this.state.tool(event.callId, 'run_command', event.phase, event.summary); this.state.status(event.phase === 'awaiting approval' ? 'awaiting approval' : 'running'); } },
          observe: event => {
            if (!this.state.current(id)) return;
            this.state.observation(event);
          },
          approvalState: waiting => { if (this.state.current(id)) this.state.status(waiting ? 'awaiting approval' : 'running'); },
        });
        if (this.state.current(id)) { this.state.status('completed'); this.state.proposalChanged(this.autonomous.current); }
      } catch (error) { if (this.state.current(id)) { if (classifyFailure(error).kind === 'cancelled') this.state.cancel(); else this.state.status('failed', publicError(error)); } }
      finally { this.operation = undefined; }
    })();
    await this.operation;
  }
  async cancel(): Promise<void> { this.state.cancel(); this.autonomous.cancel(); await this.cancelBackend(); await this.operation; }
  async newSession(): Promise<void> { await this.cancel(); await this.stopBackend(); if (!this.disposed) this.state.reset(); }
  dispose(): void { this.disposed = true; this.unsubscribe(); this.reviewSubscription.dispose(); this.bindings.splice(0).forEach(d => d.dispose()); if (this.timer) clearTimeout(this.timer); this.pending = []; this.view = undefined; void this.cancel(); }
}
