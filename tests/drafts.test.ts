import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Workspace } from '../src/workspace';
import { DraftStore, checkBatch, checkFile } from '../src/drafts';
import { hash } from '../src/patch';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'forgepilot-draft-'));
  const content = 'alpha\nrepeat\nrepeat\nbeta\n';
  for (const name of ['calculator.py', 'test_calculator.py', 'guide.md']) await writeFile(path.join(root, name), content);
  const workspace = await Workspace.create(root), drafts = new DraftStore(workspace);
  const file = { operation: 'modify', path: 'calculator.py', baseHash: hash(content), edits: [{ oldText: 'alpha', newText: 'ALPHA' }] };
  return { root, content, workspace, drafts, file, async close() { drafts.close(); workspace.dispose(); await rm(root, { recursive: true, force: true }); } };
}
test('draft diagnostics distinguish malformed variants, hashes, missing and repeated anchors, overlaps and targets', async () => {
  const f = await fixture(); try {
    for (const [file, expected] of [
      [{ ...f.file, operation: 'rename' }, 'INVALID_OPERATION'],
      [{ ...f.file, operation: 'create' }, 'INVALID_OPERATION'],
      [{ ...f.file, extra: true }, 'SCHEMA_INVALID'],
      [{ ...f.file, baseHash: '0'.repeat(64) }, 'BASE_HASH_MISMATCH'],
      [{ ...f.file, edits: [{ oldText: '', newText: 'x' }] }, 'SCHEMA_INVALID'],
      [{ ...f.file, edits: [{ oldText: 'absent', newText: 'x' }] }, 'ANCHOR_NOT_FOUND'],
      [{ ...f.file, edits: [{ oldText: 'repeat', newText: 'x' }] }, 'ANCHOR_NOT_UNIQUE'],
      [{ ...f.file, edits: [{ oldText: 'alpha', newText: 'x' }, { oldText: 'alpha\n', newText: 'y' }] }, 'OVERLAPPING_EDITS'],
      [{ ...f.file, path: 'absent.py' }, 'FILE_NOT_FOUND'],
      [{ operation: 'create', path: f.file.path, content: 'new' }, 'CREATION_TARGET_EXISTS'],
      [{ ...f.file, path: '../outside.py' }, 'WORKSPACE_FORBIDDEN'],
    ] as const) {
      const result = await checkFile(f.workspace, file); assert.equal(result.valid, false); assert.equal(result.code, expected); assert.ok(result.guidance); assert.ok(!JSON.stringify(result).includes(f.content));
    }
    assert.match((await checkFile(f.workspace, { ...f.file, operation: 'create' })).guidance!, /use operation=modify/);
    const report = await checkBatch(f.workspace, { plan: 'Independent feedback', files: [f.file, { ...f.file, edits: [{ oldText: 'absent', newText: 'new' }] }, { ...f.file, path: 'guide.md', operation: 'invalid' }] });
    assert.equal(report.valid, false); assert.equal(report.files[0]!.code, 'DUPLICATE_PATH'); assert.equal(report.files[1]!.code, 'ANCHOR_NOT_FOUND'); assert.equal(report.files[1]!.duplicate?.code, 'DUPLICATE_PATH'); assert.equal(report.files[2]!.code, 'INVALID_OPERATION');
  } finally { await f.close(); }
});
test('three independent retained drafts assemble without writes; corrections supersede IDs and stale hashes fail', async () => {
  const f = await fixture(); try {
    const requestId = randomUUID(), ids: string[] = [];
    for (const name of ['calculator.py', 'test_calculator.py', 'guide.md']) {
      const result = await f.drafts.put(requestId, { ...f.file, path: name }); assert.ok(result.valid && 'draftId' in result); ids.push(result.draftId);
      assert.equal(await readFile(path.join(f.root, name), 'utf8'), f.content);
    }
    assert.equal((await f.drafts.check(requestId, 'Three-file change', ids)).valid, true);
    assert.deepEqual(f.drafts.list().drafts.map(d => d.draftId), ids);
    assert.equal(f.drafts.assemble(requestId, 'Three-file change', ids).files.length, 3);
    await f.drafts.put(requestId, { ...f.file, edits: [{ oldText: 'wrong', newText: 'x' }] });
    assert.throws(() => f.drafts.assemble(requestId, 'No obsolete drafts', ids), /superseded/);
    const corrected = await f.drafts.put(requestId, { ...f.file, edits: [...f.file.edits, { oldText: 'beta', newText: 'BETA' }] });
    assert.ok('draftId' in corrected); ids[0] = corrected.draftId;
    const patch = f.drafts.assemble(requestId, 'Grouped edits', ids); assert.equal(patch.files.filter(f => f.path === 'calculator.py').length, 1);
    assert.equal((await f.drafts.check(requestId, 'Corrected', ids)).valid, true);
    await writeFile(path.join(f.root, 'guide.md'), 'external');
    const conflict = await f.drafts.check(requestId, 'Conflicting', ids); assert.equal(conflict.files[2]!.code, 'BASE_HASH_MISMATCH');
  } finally { await f.close(); }
});
test('draft scopes, limits, links, anchor checks and cleanup reject obsolete or unsafe results', async () => {
  const f = await fixture(); try {
    const oldScope = randomUUID(), nextScope = randomUUID();
    await f.drafts.put(oldScope, f.file); await f.drafts.put(nextScope, f.file);
    await assert.rejects(f.drafts.put(oldScope, f.file), /expired/);
    assert.equal((await f.drafts.anchor(f.file.path, f.file.baseHash, 'alpha')).valid, true);
    assert.equal((await f.drafts.anchor(f.file.path, f.file.baseHash, 'repeat')).code, 'ANCHOR_NOT_UNIQUE');
    assert.equal((await f.drafts.anchor(f.file.path, f.file.baseHash, 'not here')).code, 'ANCHOR_NOT_FOUND');
    await symlink(path.join(f.root, f.file.path), path.join(f.root, 'linked.py'));
    assert.equal((await f.drafts.put(nextScope, { ...f.file, path: 'linked.py' })).code, 'WORKSPACE_FORBIDDEN');
    await link(path.join(f.root, 'guide.md'), path.join(f.root, 'hard.md'));
    assert.equal((await f.drafts.put(nextScope, { ...f.file, path: 'hard.md' })).valid, false);
    for (let i = 0; i < 11; i++) assert.equal((await f.drafts.put(nextScope, { operation: 'create', path: `new-${i}.py`, content: 'x' })).valid, true);
    assert.equal((await f.drafts.put(nextScope, { operation: 'create', path: 'thirteenth.py', content: 'x' })).valid, false);
    f.drafts.close(); await assert.rejects(f.drafts.put(nextScope, f.file), /closed/);
  } finally { await f.close(); }
});
test('runtime cancellation invalidates in-flight validation and cannot revive a retired scope', async () => {
  const f = await fixture(); try {
    const scope = randomUUID(); f.drafts.begin(scope);
    const pending = f.drafts.put(scope, f.file); f.drafts.invalidate();
    await assert.rejects(pending, /Delayed draft/);
    assert.throws(() => f.drafts.requestId(), /No active/);
    assert.throws(() => f.drafts.list(), /No active/);
    await assert.rejects(f.drafts.put(scope, f.file), /expired/);
  } finally { await f.close(); }
});
