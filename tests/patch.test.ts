import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/workspace';
import { PatchStore, captureSelection, diffHunks, hash, parseJson, parsePatch, renderPatch } from '../src/patch';

const before = 'alpha\nkeep\nbeta\n';
const patch = { path: 'sample.ts', baseHash: hash(before), edits: [{ oldText: 'alpha', newText: 'ALPHA' }, { oldText: 'beta', newText: 'BETA' }] };
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'forgepilot-patch-'));
  await writeFile(path.join(root, patch.path), before);
  const workspace = await Workspace.create(root);
  const snapshot = { path: patch.path, content: before, version: 1, start: 0, end: before.length };
  const store = new PatchStore(workspace, snapshot);
  return { root, store, snapshot, cleanup: () => rm(root, { recursive: true, force: true }) };
}
test('selection capture preserves offsets, metadata and immutable snapshot', () => {
  const input = { path: 'source.py', content: 'one\nselected\nthree', version: 7, start: 4, end: 12 };
  const result = captureSelection(input); input.version++;
  assert.equal(result.version, 7); assert.equal(result.content.slice(result.start, result.end), 'selected');
  for (const [start, end] of [[0, 0], [-1, 3], [0, 999], [5, 4], [0.5, 4]]) assert.throws(() => captureSelection({ ...input, start: start!, end: end! }));
});
test('valid strict patch parsing and generation; no prose fallback', () => {
  assert.equal(renderPatch(before, parsePatch(patch)), 'ALPHA\nkeep\nBETA\n');
  for (const value of [null, '```json {} ```', {}, { ...patch, extra: true }, { ...patch, edits: [] }, { ...patch, baseHash: 'x' }, { ...patch, edits: [{ oldText: '', newText: '' }] }]) assert.throws(() => parsePatch(value));
  assert.throws(() => parseJson('{broken'), /Malformed model output/);
  assert.throws(() => parseJson(' '.repeat(256 * 1024 + 1)), /budget/);
});
test('rejects ambiguous, overlapping, out-of-selection and incorrect-base edits', () => {
  assert.throws(() => renderPatch(before, { ...patch, baseHash: '0'.repeat(64) }));
  assert.throws(() => renderPatch(before, patch, 6, before.length));
  assert.throws(() => renderPatch(before, { ...patch, edits: [{ oldText: 'alpha', newText: 'a' }, { oldText: 'pha', newText: 'b' }] }));
  assert.throws(() => renderPatch('x x', { ...patch, baseHash: hash('x x'), edits: [{ oldText: 'x', newText: 'y' }] }));
});
test('line hunks cover independent changes, additions, deletions, CRLF and EOF', () => {
  assert.equal(diffHunks(before, renderPatch(before, patch)).length, 2);
  for (const [a, b] of [['', 'new\n'], ['old\n', ''], ['a\r\nb\r\n', 'a\r\nB\r\n'], ['a', 'a\n'], ['a\nx\nb\n', 'a\ny\nz\nb\n']]) {
    const hunks = diffHunks(a!, b!); let result = a!;
    for (const h of hunks.reverse()) result = result.slice(0, h.start) + h.newText + result.slice(h.end);
    assert.equal(result, b);
  }
  assert.deepEqual(diffHunks(before, before), []);
});
test('staging never mutates disk; records hashes, identity and independent decisions', async () => {
  const f = await fixture(); try {
    const p = await f.store.stage(patch, true);
    assert.ok(p.id); assert.equal(p.originalHash, patch.baseHash); assert.equal(p.diskHash, patch.baseHash);
    assert.equal(p.snapshot.version, 1); assert.equal(p.status, 'staged'); assert.equal(p.toolApproved, true);
    assert.ok(p.hunks.every(h => h.decision === 'pending'));
    assert.equal(await readFile(path.join(f.root, patch.path), 'utf8'), before);
    p.hunks[0]!.decision = 'accepted'; assert.equal(f.store.current!.hunks[0]!.decision, 'pending');
    assert.throws(() => f.store.accepted(p.id), /Review every/);
  } finally { await f.cleanup(); }
});
test('accept all renders all changes and keeps original file untouched', async () => {
  const f = await fixture(); try {
    const p = await f.store.stage(patch, true); f.store.review(p.id, 'accepted');
    assert.equal(f.store.accepted(p.id), 'ALPHA\nkeep\nBETA\n');
    assert.equal(await readFile(path.join(f.root, patch.path), 'utf8'), before);
  } finally { await f.cleanup(); }
});
test('reject all is terminal and cannot subsequently commit or approve', async () => {
  const f = await fixture(); try {
    const p = await f.store.stage(patch, true); f.store.review(p.id, 'rejected');
    assert.equal(f.store.current!.status, 'rejected');
    assert.throws(() => f.store.accepted(p.id)); assert.throws(() => f.store.review(p.id, 'accepted'));
    await assert.rejects(f.store.validate(p.id, { content: before, version: 1 }));
  } finally { await f.cleanup(); }
});
test('mixed acceptance applies only accepted hunks', async () => {
  const f = await fixture(); try {
    const p = await f.store.stage(patch, true);
    f.store.review(p.id, 'accepted', p.hunks[0]!.id); f.store.review(p.id, 'rejected', p.hunks[1]!.id);
    assert.equal(f.store.accepted(p.id), 'ALPHA\nkeep\nbeta\n');
    assert.throws(() => f.store.review(p.id, 'accepted', 'unknown'));
  } finally { await f.cleanup(); }
});
test('stale versions and changed content rejected; external file conflicts detected', async () => {
  const f = await fixture(); try {
    const p = await f.store.stage(patch, true);
    await f.store.validate(p.id, { content: before, version: 1 });
    await assert.rejects(f.store.validate(p.id, { content: before, version: 2 }), /Stale/);
    await assert.rejects(f.store.validate(p.id, { content: before + 'user', version: 1 }), /Stale/);
    await writeFile(path.join(f.root, patch.path), 'external');
    await assert.rejects(f.store.validate(p.id, { content: before, version: 1 }), /externally/);
  } finally { await f.cleanup(); }
});
test('staging rejects missing tool approval, wrong targets, traversal and symlink escapes', async () => {
  const f = await fixture(); try {
    await assert.rejects(f.store.stage(patch, false), /approval/);
    for (const target of ['../outside.py', '/etc/passwd', 'alias.ts']) {
      if (target === 'alias.ts') await symlink('/etc/passwd', path.join(f.root, target));
      const store = new PatchStore(f.store.workspace, { ...f.snapshot, path: target });
      await assert.rejects(store.stage({ ...patch, path: target }, true));
    }
    await assert.rejects(f.store.stage({ ...patch, path: 'other.ts' }, true), /selected file/);
  } finally { await f.cleanup(); }
});
test('cancellation before approval, after staging, and delayed staging is terminal', async () => {
  const f = await fixture(); try {
    f.store.cancel(); await assert.rejects(f.store.stage(patch, true));
    const second = new PatchStore(f.store.workspace, f.snapshot);
    const pending = second.stage(patch, true); second.cancel(); await assert.rejects(pending, /Late/);
    const third = new PatchStore(f.store.workspace, f.snapshot);
    const p = await third.stage(patch, true); third.review(p.id, 'accepted'); third.cancel();
    assert.equal(third.current!.status, 'cancelled'); assert.throws(() => third.accepted(p.id));
    assert.equal(await readFile(path.join(f.root, patch.path), 'utf8'), before);
  } finally { await f.cleanup(); }
});
test('failed application cannot be retried with the same proposal', async () => {
  const f = await fixture(); try {
    const p = await f.store.stage(patch, true); f.store.review(p.id, 'accepted');
    f.store.beginApply(p.id); f.store.finishApply(false);
    assert.equal(f.store.current!.status, 'failed'); assert.throws(() => f.store.accepted(p.id));
  } finally { await f.cleanup(); }
});
test('path revalidation blocks symlink replacement after approval', async () => {
  const f = await fixture(); try {
    const p = await f.store.stage(patch, true); f.store.review(p.id, 'accepted');
    await rm(path.join(f.root, patch.path)); await symlink('/etc/passwd', path.join(f.root, patch.path));
    await assert.rejects(f.store.validate(p.id, { content: before, version: 1 }), /Symbolic links/);
  } finally { await f.cleanup(); }
});
