import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { ContextEngine as Baseline } from './context-baseline';
import { ContextEngine, estimatedTokens } from '../src/context';
import { Workspace } from '../src/workspace';

const rows = [];
for (const [name, irrelevant, long] of [['small-python', 4, 0], ['large-python', 320, 2000], ['mixed-nested', 90, 500]] as const) {
  const root = await mkdtemp(path.join(tmpdir(), 'forgepilot-benchmark-'));
  try {
    const prefix = name === 'mixed-nested' ? 'projects/billing/' : '';
    for (const dir of ['src', 'tests', 'docs', 'irrelevant']) await mkdir(path.join(root, prefix, dir), { recursive: true });
    const relevant = [`${prefix}src/invoice.py`, `${prefix}tests/test_invoice.py`, `${prefix}docs/invoice.rst`];
    await writeFile(path.join(root, relevant[0]!), 'def render_invoice(total):\n    """Invoice rounding renderer."""\n    return round(total, 2)\n' + ('\n# unrelated padding ' + 'x'.repeat(60) + '\n').repeat(long));
    await writeFile(path.join(root, relevant[1]!), 'from invoice import render_invoice\ndef test_invoice_rounding():\n    assert render_invoice(1.111) == 1.11\n');
    await writeFile(path.join(root, relevant[2]!), 'Invoice renderer\n================\nInvoice rounding uses two decimal places.\n');
    for (let i = 0; i < irrelevant; i++) await writeFile(path.join(root, prefix, 'irrelevant', `item_${i}.py`), 'def repeated_identifier():\n    return "unrelated"\n');
    await writeFile(path.join(root, '.env'), 'TOKEN=must-not-be-readable'); await symlink('/etc/passwd', path.join(root, 'escape.py'));
    const samples = [];
    for (const optimized of [false, true]) {
      const runs = [];
      for (let repeat = 0; repeat < 3; repeat++) {
        const workspace = await Workspace.create(root); let reads = 0, readBytes = 0;
        const original = workspace.readFile.bind(workspace);
        workspace.readFile = async (p, limit) => { const r = await original(p, limit); reads++; readBytes += r.bytes; return r; };
        const engine = optimized ? new ContextEngine(workspace, 3000) : new Baseline(workspace, 3000);
        const started = performance.now();
        const context = await engine.retrieve('Improve invoice renderer rounding with independent tests and documentation');
        const responses: unknown[] = [context, await engine.outline(relevant[0]!)];
        for (let i = 0; i < 3; i++) responses.push(optimized ? await (engine as ContextEngine).range(relevant[0]!, 1, 40) : await workspace.readRange(relevant[0]!, 1, 40));
        const responseBytes = responses.reduce<number>((n, r) => n + Buffer.byteLength(JSON.stringify(r)), 0);
        const discovered = relevant.filter(p => context.selected.some(c => c.path === p)); assert.deepEqual(discovered, relevant);
        await assert.rejects(workspace.readFile('.env')); await assert.rejects(workspace.readFile('escape.py')); await assert.rejects(workspace.readFile('../escape.py'));
        runs.push({ reads, readBytes, contextPackages: 1, toolCalls: 5, responseBytes, estimatedTokens: responses.reduce<number>((n, r) => n + estimatedTokens(JSON.stringify(r)), 0), duplicateResponses: responses.filter(r => r && typeof r === 'object' && 'duplicate' in r).length,
          relevantDiscovered: discovered.length, relevantExpected: relevant.length, securityChecks: 3, latencyMs: Math.round((performance.now() - started) * 100) / 100 });
        workspace.dispose();
      }
      samples.push({ implementation: optimized ? 'optimized' : '9c8df0e-baseline', deterministic: { ...runs[0], latencyMs: undefined }, latencyMs: runs.map(r => r.latencyMs).sort((a, b) => a - b)[1] });
    }
    rows.push({ fixture: name, files: irrelevant + 3, samples });
  } finally { await rm(root, { recursive: true, force: true }); }
}
const result = { baselineCommit: '9c8df0e0321d09a128587409e5ac59c8191a2ec6', method: 'Same fixture/task and 5 tool operations per variant; fresh workspace per repetition. Three runs, median latency. Response tokens are UTF-8 bytes/3 estimates, not provider usage. Repeated ranges deliberately exercise response deduplication. No inference or completion-rate comparison.', actualProviderTokens: 'UNKNOWN: deterministic retrieval benchmark only', rows };
await writeFile('docs/evidence/final-engineering/context-benchmark.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
