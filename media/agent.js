/* Runs only in the isolated VS Code webview. Model/repository text is textContent. */
(() => {
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  let sessionId = '', requestId = null, busy = false, followOutput = true;
  const bubbles = new Map(), tools = new Map();
  const send = (type, fields = {}) => vscode.postMessage({ type, sessionId, requestId, ...fields });
  const scroll = () => { const el = $('scroll'); if (followOutput) el.scrollTop = el.scrollHeight; };
  $('scroll').addEventListener('scroll', () => { const el = $('scroll'); followOutput = el.scrollHeight - el.scrollTop - el.clientHeight < 140; });
  const message = value => {
    const article = document.createElement('article'); article.className = `message ${value.role}`;
    const label = document.createElement('small'); label.textContent = value.role === 'user' ? 'You' : 'TrueForge';
    const content = document.createElement('div'); content.textContent = value.text;
    article.append(label, content); $('conversation').append(article); bubbles.set(value.id, content); $('welcome').hidden = true; scroll();
  };
  const tool = value => {
    let el = tools.get(value.id);
    if (!el) { el = document.createElement('details'); const summary = document.createElement('summary'), pre = document.createElement('pre'); el.append(summary, pre); $('tools').append(el); tools.set(value.id, el); }
    el.firstChild.textContent = `${value.name} · ${value.phase}`; el.lastChild.textContent = value.detail; el.dataset.phase = value.phase; scroll();
  };
  const status = (state, error = '') => {
    const wasBusy = busy;
    busy = state === 'running' || state === 'awaiting approval'; $('state').textContent = state; $('state').dataset.state = state;
    $('send').disabled = busy; $('stop').disabled = !busy; $('prompt').disabled = busy;
    $('error').textContent = error; $('error').hidden = !error;
    $('review').disabled = busy; $('apply').disabled = busy || $('proposal').dataset.status !== 'staged'; $('undo').disabled = busy;
    if (wasBusy && !busy && document.hasFocus()) $('prompt').focus();
  };
  const proposal = value => {
    $('proposal').hidden = !value; $('files').replaceChildren(); if (!value) return;
    $('proposal').dataset.status = value.status; $('proposal-title').textContent = `${value.files.length} files · ${value.status}`;
    $('proposal-note').textContent = value.status === 'staged' ? 'Staged only. Review every hunk; Apply uses accepted hunks.' : value.status === 'partially applied' ? 'Accepted hunks applied; rejected hunks were excluded.' : `Batch ${value.status}. Editor buffers require normal saving.`;
    for (const file of value.files) {
      const button = document.createElement('button'); button.className = 'file'; button.textContent = `${file.path} · ${file.operation}`;
      button.title = `Open native diff · ${file.accepted} accepted / ${file.rejected} rejected / ${file.pending} pending`;
      button.addEventListener('click', () => send('diff', { fileId: file.id })); $('files').append(button);
    }
    $('apply').disabled = busy || value.status !== 'staged' || value.files.some(f => f.pending) || !value.files.some(f => f.accepted);
  };
  const usage = value => {
    $('usage').hidden = !value; if (!value) return;
    const a = value.actual;
    $('usage').textContent = `CONFIGURED task: ${value.configuredTaskTokens ?? 'UNKNOWN'} · ${value.mode}\nACTUAL total: ${a.total ?? 'UNKNOWN'}${value.actualComplete ? '' : ' (partial/unknown)'} (input ${a.input ?? '?'}, output ${a.output ?? '?'}, cache ${a.cachedInput ?? '?'}, reasoning ${a.reasoning ?? '?'})\nESTIMATED spend: ${value.estimatedTokens} · remaining ${value.estimatedRemaining ?? 'UNKNOWN'} · tools ${value.toolCalls}\nContext: ${value.contextStatus}${value.contextPackage ? ` · retrieval ~${value.contextPackage.estimatedTokens}/${value.contextPackage.budget} ESTIMATED` : ''} · provider quota UNKNOWN · pacing ${value.pacingMs ? 'active' : value.pacingStatus ?? 'UNKNOWN limits'}${value.warning ? '\n' + value.warning : ''}`;
    $('usage').title = value.methodology;
  };
  const identity = value => { $('model').textContent = value.model; $('backend').textContent = value.backendSession ? `Session ${value.backendSession}` : ''; };
  const snapshot = value => {
    if (!value.messages.length) followOutput = true;
    sessionId = value.sessionId; requestId = value.requestId;
    $('conversation').replaceChildren(); $('tools').replaceChildren(); bubbles.clear(); tools.clear(); $('welcome').hidden = value.messages.length > 0;
    for (const item of value.messages) message(item); for (const item of value.tools) tool(item);
    usage(value.usage); identity(value); status(value.state, value.error); proposal(value.proposal);
  };
  const update = event => {
    if (event.type === 'snapshot') { snapshot(event.value); return; }
    if (event.sessionId !== sessionId || event.requestId !== requestId) return;
    if (event.type === 'append') { const el = bubbles.get(event.id); if (el) el.append(document.createTextNode(event.text)); scroll(); }
    if (event.type === 'message') message(event.value);
    if (event.type === 'tool') tool(event.value);
    if (event.type === 'status') status(event.state, event.error);
    if (event.type === 'identity') identity(event);
    if (event.type === 'usage') usage(event.value);
    if (event.type === 'proposal') proposal(event.value);
  };
  window.addEventListener('message', ({ data }) => { if (data.type === 'snapshot') snapshot(data.value); if (data.type === 'events') for (const event of data.events) update(event); });
  $('composer').addEventListener('submit', event => { event.preventDefault(); const text = $('prompt').value.trim(); if (!busy && text) { send('submit', { text }); $('prompt').value = ''; } });
  $('prompt').addEventListener('keydown', event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); $('composer').requestSubmit(); } });
  $('stop').addEventListener('click', () => send('cancel')); $('new').addEventListener('click', () => send('newSession'));
  $('context').addEventListener('click', () => send('context')); $('review').addEventListener('click', () => send('review'));
  $('apply').addEventListener('click', () => send('apply')); $('undo').addEventListener('click', () => send('undo'));
  vscode.postMessage({ type: 'ready', viewId: document.body.dataset.viewId }); $('prompt').focus();
})();
