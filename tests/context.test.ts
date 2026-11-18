import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, link, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { Workspace } from '../src/workspace';
import { ContextEngine, estimatedTokens } from '../src/context';

test('discovery and targeted content/symbol queries find files beyond 200 with secure Git inventory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'forgepilot-discovery-'));
  try {
    await mkdir(path.join(root, 'src'));
    await Promise.all(Array.from({ length: 280 }, (_, i) => writeFile(path.join(root, `src/item-${String(i).padStart(3, '0')}.py`), 'ordinary = 1\n')));
    await writeFile(path.join(root, 'src/zzz_target.py'), 'def unique_identifier():\n    return "needle_marker"\n');
    await symlink('/etc/passwd', path.join(root, 'src/escape.py'));
    await link(path.join(root, 'src/item-000.py'), path.join(root, 'src/hardlink.py'));
    await writeFile(path.join(root, '.env'), 'needle_marker=hidden');
    execFileSync('git', ['init', '-q', root]); execFileSync('git', ['-C', root, 'add', '.']);
    const engine = new ContextEngine(await Workspace.create(root));
    await writeFile(path.join(root, 'src/new-untracked.py'), 'new_source = 1\n');
    assert.deepEqual((await engine.discover('new-untracked')).files, ['src/new-untracked.py']);
    const result = await engine.discover('zzz'); assert.deepEqual(result.files, ['src/zzz_target.py']); assert.equal(result.source, 'git');
    const search = await engine.search('needle_marker'); assert.equal(search.matches[0]?.path, 'src/zzz_target.py');
    assert.equal((await engine.search('unique_identifier', 'src', true)).matches[0]?.symbol, 'unique_identifier');
    assert.equal((await engine.search('needle_marker', 'src/zzz_target.py')).matches[0]?.path, 'src/zzz_target.py');
    const names = await engine.workspace.inventory();
    assert.ok(!names.files.includes('src/escape.py') && !names.files.includes('src/hardlink.py') && !names.files.includes('.env'));
    const page = await engine.discover('', 'src', 0, 20); assert.equal(page.nextCursor, 20); assert.equal(page.truncated, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('context ranks evidence, resolves explicit references and enforces measured estimate budget', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'forgepilot-context-'));
  try {
    await mkdir(path.join(root, 'tests')); await mkdir(path.join(root, 'docs'));
    await writeFile(path.join(root, 'commands.py'), 'import serialization\ndef render_config():\n    """Output masked settings as JSON."""\n    return {}\n');
    await writeFile(path.join(root, 'unrelated.py'), 'def unrelated():\n    pass\n');
    await writeFile(path.join(root, 'tests/test_commands.py'), 'from commands import render_config\ndef test_config_json():\n    assert render_config() == {}\n');
    await writeFile(path.join(root, 'docs/commands.rst'), 'Commands\n========\nJSON configuration output\n');
    const engine = new ContextEngine(await Workspace.create(root), 3000);
    const result = await engine.retrieve('JSON config output @symbol:render_config @file:commands.py');
    assert.ok(result.selected.some(s => s.path === 'commands.py'));
    assert.ok(result.selected.some(s => s.path === 'tests/test_commands.py'));
    assert.ok(result.selected.some(s => s.path === 'docs/commands.rst'));
    assert.ok(result.candidates[0]!.reasons.length); assert.ok(result.selected.some(s => s.reasons.some(r => r.startsWith('import/reference'))));
    assert.ok(result.estimatedTokens + result.reserved <= 3000);
    assert.ok(Math.abs(result.estimatedTokens - estimatedTokens(JSON.stringify(result))) <= 1);
    await assert.rejects(engine.retrieve('@file:../outside.py'));
    await assert.rejects(engine.retrieve('@symbol:absent'), /not resolved/);
    await writeFile(path.join(root, 'long.py'), 'render_config = "config JSON"\n'.repeat(2000));
    const small = await new ContextEngine(engine.workspace, 2000).retrieve('config JSON');
    assert.ok(small.truncated); assert.ok(small.estimatedTokens + small.reserved <= 2000);
    assert.ok(small.selected.some(s => s.truncated));
    await writeFile(path.join(root, 'long-line.py'), 'config JSON ' + 'x'.repeat(70000));
    const bounded = await engine.retrieve('config JSON');
    assert.ok(bounded.truncated); assert.ok(!bounded.selected.some(s => s.path === 'long-line.py'));
    assert.ok(bounded.estimatedTokens + bounded.reserved <= bounded.budget);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('range reads paginate large files while retaining ordinary read bounds and containment', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'forgepilot-range-'));
  try {
    await writeFile(path.join(root, 'large.py'), 'x'.repeat(100) + '\n' + 'line\n'.repeat(15000));
    const workspace = await Workspace.create(root);
    await assert.rejects(workspace.readFile('large.py'));
    const range = await workspace.readRange('large.py', 14000, 4);
    assert.equal(range.start, 14000); assert.equal(range.end, 14003); assert.equal(range.content, 'line\nline\nline\nline'); assert.ok(range.truncated); assert.match(range.hash, /^[a-f0-9]{64}$/);
    await assert.rejects(workspace.readRange('large.py', 0)); await assert.rejects(workspace.readRange('../large.py'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('workspace disposal kills an in-flight Git metadata subprocess', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'forgepilot-git-lifecycle-'));
  const originalPath = process.env.PATH;
  const workspace = await Workspace.create(root);
  try {
    const bin = path.join(root, 'bin'), pidFile = path.join(root, 'child.pid');
    await mkdir(bin);
    await writeFile(path.join(bin, 'git'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);\n`, { mode: 0o755 });
    process.env.PATH = bin;
    const pending = workspace.inventory();
    const rejected = assert.rejects(pending, /closed/);
    let pid = 0;
    for (let i = 0; i < 100 && !pid; i++) {
      try { pid = Number(await readFile(pidFile, 'utf8')); } catch { await new Promise(resolve => setTimeout(resolve, 10)); }
    }
    assert.ok(pid, 'The fixture metadata process must actually start');
    workspace.dispose(); await rejected;
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally {
    workspace.dispose();
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    await rm(root, { recursive: true, force: true });
  }
});
