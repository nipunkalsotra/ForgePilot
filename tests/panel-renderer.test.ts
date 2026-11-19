import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

/** Minimal deterministic DOM fixture for the actual shipped script; not a browser/physical-click claim. */
class Element {
  dataset: Record<string, string> = {}; children: Element[] = []; events = new Map<string, (event: Record<string, unknown>) => void>();
  hidden = false; disabled = false; value = ''; title = ''; className = ''; scrollHeight = 1000; scrollTop = 800; clientHeight = 200; focused = false;
  private ownText = '';
  constructor(readonly tag = 'div') {}
  get textContent(): string { return this.ownText + this.children.map(c => c.textContent).join(''); }
  set textContent(text: string) { this.ownText = text; this.children = []; }
  get firstChild() { return this.children[0]!; } get lastChild() { return this.children.at(-1)!; }
  append(...nodes: Element[]) { this.children.push(...nodes); }
  replaceChildren() { this.children = []; this.ownText = ''; }
  addEventListener(name: string, handler: (event: Record<string, unknown>) => void) { this.events.set(name, handler); }
  fire(name: string, event: Record<string, unknown> = {}) { this.events.get(name)?.(event); }
  focus() { this.focused = true; }
  requestSubmit() { this.fire('submit', { preventDefault() {} }); }
}
async function renderer() {
  const elements = new Map<string, Element>(), posted: Record<string, unknown>[] = [], window = new Element();
  const get = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!; };
  const body = new Element(); body.dataset.viewId = 'test-view';
  runInNewContext(await readFile('media/agent.js', 'utf8'), {
    acquireVsCodeApi: () => ({ postMessage: (message: Record<string, unknown>) => posted.push(message) }), window,
    document: { getElementById: get, body, hasFocus: () => true, createElement: (tag: string) => new Element(tag), createTextNode: (text: string) => { const node = new Element('#text'); node.textContent = text; return node; } },
  });
  const update = (data: object) => window.fire('message', { data });
  update({ type: 'snapshot', value: { sessionId: 'session', requestId: 'request', state: 'idle', model: 'actual/model', backendSession: 'backend', messages: [], tools: [], proposal: null, error: '' } });
  return { get, posted, update, event: (event: object) => update({ type: 'events', events: [{ sessionId: 'session', requestId: 'request', ...event }] }) };
}
test('shipped renderer appends stream text in place, suppresses stale events and treats model HTML as literal data', async () => {
  const r = await renderer(); r.event({ type: 'message', value: { id: 'assistant', role: 'assistant', text: '' } });
  const article = r.get('conversation').firstChild, content = article.lastChild;
  r.event({ type: 'append', id: 'assistant', text: 'live ' }); r.event({ type: 'append', id: 'assistant', text: '<script>attack()</script>' });
  assert.equal(r.get('conversation').firstChild, article); assert.equal(article.lastChild, content); assert.equal(content.textContent, 'live <script>attack()</script>');
  assert.ok(content.children.every(node => node.tag === '#text'));
  r.event({ type: 'append', id: 'assistant', text: 'stale', requestId: 'old' }); assert.doesNotMatch(content.textContent, /stale/);
  assert.equal(r.get('model').textContent, 'actual/model'); assert.equal(r.get('backend').textContent, 'Session backend');
});
test('shipped renderer sends typed prompt/keyboard/cancel/context messages and respects running controls', async () => {
  const r = await renderer(); r.get('prompt').value = '  inspect @file:sample.ts  ';
  r.get('prompt').fire('keydown', { key: 'Enter', ctrlKey: true, preventDefault() {} });
  const submitted = r.posted.at(-1)!; assert.equal(submitted.type, 'submit'); assert.equal(submitted.text, 'inspect @file:sample.ts'); assert.equal(submitted.sessionId, 'session');
  r.event({ type: 'status', state: 'running', error: '' }); assert.equal(r.get('send').disabled, true); assert.equal(r.get('stop').disabled, false);
  r.get('stop').fire('click'); assert.equal(r.posted.at(-1)?.type, 'cancel'); r.get('context').fire('click'); assert.equal(r.posted.at(-1)?.type, 'context');
  r.event({ type: 'status', state: 'completed', error: '' }); assert.equal(r.get('prompt').disabled, false); assert.equal(r.get('prompt').focused, true);
});
test('shipped renderer distinguishes staged/partial application and keeps Apply disabled for pending decisions', async () => {
  const r = await renderer(), file = { id: 'file', path: '<img onerror=attack()>', operation: 'modify', accepted: 0, rejected: 0, pending: 1 };
  r.event({ type: 'proposal', value: { id: 'proposal', status: 'staged', files: [file] } }); assert.equal(r.get('apply').disabled, true); assert.match(r.get('proposal-note').textContent, /Staged only/);
  assert.equal(r.get('files').firstChild.tag, 'button'); assert.match(r.get('files').firstChild.textContent, /<img/);
  r.get('files').firstChild.fire('click'); assert.equal(r.posted.at(-1)?.type, 'diff');
  r.event({ type: 'proposal', value: { id: 'proposal', status: 'staged', files: [{ ...file, accepted: 1, pending: 0 }] } }); assert.equal(r.get('apply').disabled, false);
  r.event({ type: 'proposal', value: { id: 'proposal', status: 'partially applied', files: [file] } }); assert.match(r.get('proposal-note').textContent, /rejected hunks were excluded/);
});
test('shipped renderer updates collapsible tool rows and preserves a user scroll position', async () => {
  const r = await renderer(); r.get('scroll').scrollTop = 0; r.get('scroll').fire('scroll');
  r.event({ type: 'tool', value: { id: 'call', name: 'run_command', phase: 'awaiting approval', detail: 'git status' } });
  const row = r.get('tools').firstChild; assert.equal(row.tag, 'details');
  r.event({ type: 'tool', value: { id: 'call', name: 'run_command', phase: 'failed', detail: 'Exit 7\n<script>output</script>' } });
  assert.equal(r.get('tools').firstChild, row); assert.match(row.firstChild.textContent, /failed/); assert.equal(row.lastChild.tag, 'pre'); assert.equal(r.get('scroll').scrollTop, 0);
});
