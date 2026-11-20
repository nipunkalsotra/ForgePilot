import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BatchStore, parseBatch, batchSchema, type DocumentBaseline } from '../src/batch';
import { EditCoordinator, type EditorHost, type EditorChange } from '../src/coordinator';
import { Workspace } from '../src/workspace';
import { hash } from '../src/patch';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'forgepilot-batch-')), before = 'alpha\nkeep\nbeta\n';
  const documents = new Map<string, DocumentBaseline>();
  for (const file of ['a.py', 'b.py', 'c.py']) { await writeFile(path.join(root, file), before); documents.set(file, { content: before, version: 1 }); }
  const workspace = await Workspace.create(root);
  const input = { plan: 'Update related sources', files: ['a.py', 'b.py', 'c.py'].map(file => ({ operation: 'modify' as const, path: file, baseHash: hash(before), edits: [{ oldText: 'alpha', newText: 'ALPHA' }, { oldText: 'beta', newText: 'BETA' }] })) };
  let fail = false, userChange = false;
  const host: EditorHost = {
    async snapshot(p, op) { return { ...(documents.get(p) ?? (op === 'create' ? { content: '', version: 0 } : (() => { throw new Error('missing document'); })())) }; },
    current(p) { const d = documents.get(p); return d && { ...d }; },
    async apply(changes: EditorChange[]) {
      for (const change of changes) {
        if (change.operation === 'delete') { await rm(path.join(root, change.path)); documents.delete(change.path); }
        else { if (change.operation === 'create') await writeFile(path.join(root, change.path), ''); documents.set(change.path, { content: change.content, version: (documents.get(change.path)?.version ?? 0) + 1 }); }
        if (fail) { fail = false; if (userChange) documents.set(change.path, { content: 'user change', version: documents.get(change.path)!.version + 1 }); return false; }
      }
      return true;
    },
  };
  const makeStore = () => new BatchStore(workspace, (p, op) => host.snapshot(p, op));
  const store = makeStore(), coordinator = new EditCoordinator(host);
  return { root, before, workspace, input, store, host, documents, coordinator, makeStore, fail(user = false) { fail = true; userChange = user; }, cleanup: () => rm(root, { recursive: true, force: true }) };
}
test('batch staging is no-write, independent and requires terminal success before review', async () => {
  const f = await fixture(); try {
    const p = await f.store.stage(f.input, true); assert.equal(p.files.length, 3); assert.throws(() => f.store.review('accepted'));
    f.store.complete();
    for (const file of p.files) assert.equal(await readFile(path.join(f.root, file.path), 'utf8'), f.before);
    f.store.review('accepted', p.files[0]!.id, p.files[0]!.hunks[0]!.id);
    f.store.review('rejected', undefined, undefined, true);
    const accepted = f.store.accepted(); assert.equal(accepted.length, 1); assert.equal(accepted[0]!.content, 'ALPHA\nkeep\nbeta\n');
  } finally { await f.cleanup(); }
});
test('coordinated multi-file application and exact undo preserve unrelated user edits', async () => {
  const f = await fixture(); try {
    await f.store.stage(f.input, true); f.store.complete(); f.store.review('accepted'); await f.coordinator.apply(f.store);
    assert.ok([...f.documents.values()].every(d => d.content === 'ALPHA\nkeep\nBETA\n'));
    await f.coordinator.undo(); assert.ok([...f.documents.values()].every(d => d.content === f.before));
    const next = f.makeStore(); await next.stage(f.input, true); next.complete(); next.review('accepted'); await f.coordinator.apply(next);
    f.documents.set('b.py', { content: 'user change', version: 5 });
    await assert.rejects(f.coordinator.undo(), /blocked/); assert.equal(f.documents.get('b.py')!.content, 'user change');
  } finally { await f.cleanup(); }
});
test('conflict or missing target blocks entire batch before any application', async () => {
  for (const fault of ['external', 'deleted', 'symlink', 'version'] as const) {
    const f = await fixture(); try {
      await f.store.stage(f.input, true); f.store.complete(); f.store.review('accepted');
      if (fault === 'external') await writeFile(path.join(f.root, 'b.py'), 'external');
      if (fault === 'deleted' || fault === 'symlink') await rm(path.join(f.root, 'b.py'));
      if (fault === 'symlink') await symlink('/etc/passwd', path.join(f.root, 'b.py'));
      if (fault === 'version') f.documents.set('b.py', { content: f.before, version: 2 });
      await assert.rejects(f.coordinator.apply(f.store)); assert.equal(f.documents.get('a.py')!.content, f.before); assert.equal(f.store.current!.status, 'failed');
    } finally { await f.cleanup(); }
  }
});
test('partial editor failure restores only safe modifications and reports unsafe portions', async () => {
  for (const user of [false, true]) {
    const f = await fixture(); try {
      await f.store.stage(f.input, true); f.store.complete(); f.store.review('accepted'); f.fail(user);
      await assert.rejects(f.coordinator.apply(f.store), user ? /could not be safely restored/ : /were restored/);
      assert.equal(f.documents.get('a.py')!.content, user ? 'user change' : f.before); assert.equal(f.store.current!.status, 'failed');
    } finally { await f.cleanup(); }
  }
});
test('new files need explicit creation state, approval and guarded undo', async () => {
  const f = await fixture(); try {
    const input = { plan: 'Create a helper', files: [{ operation: 'create', path: 'new.py', content: 'new code\n' }] };
    await assert.rejects(f.store.stage(input, false)); await f.store.stage(input, true); f.store.complete(); f.store.review('accepted');
    await assert.rejects(readFile(path.join(f.root, 'new.py')));
    await f.coordinator.apply(f.store); assert.equal(f.documents.get('new.py')?.content, 'new code\n'); await f.coordinator.undo();
    await assert.rejects(readFile(path.join(f.root, 'new.py')));
    const collision = f.makeStore(); await collision.stage(input, true); collision.complete(); collision.review('accepted');
    await writeFile(path.join(f.root, 'new.py'), 'external creation');
    await assert.rejects(f.coordinator.apply(collision), /exists/); assert.equal(await readFile(path.join(f.root, 'new.py'), 'utf8'), 'external creation');
    await assert.rejects(f.makeStore().stage({ ...input, files: [{ ...input.files[0], path: 'a.py' }] }, true), /exists/);
    await assert.rejects(f.makeStore().stage({ ...input, files: [{ ...input.files[0], path: '../escape.py' }] }, true));
  } finally { await f.cleanup(); }
});
test('invalid, rejected, failed or cancelled batches cannot later apply', async () => {
  const f = await fixture(); try {
    assert.throws(() => parseBatch({ ...f.input, extra: true }));
    assert.equal(batchSchema.safeParse({ ...f.input, files: [{ operation: 'modify', path: 'a.py', content: 'wrong variant' }] }).success, false);
    assert.equal(batchSchema.safeParse({ ...f.input, files: [{ operation: 'create', path: 'new.py', content: 'new', baseHash: hash('') }] }).success, false);
    assert.throws(() => parseBatch({ ...f.input, files: [f.input.files[0], f.input.files[0]] }));
    await f.store.stage(f.input, true); f.store.complete(); f.store.review('rejected'); await assert.rejects(f.coordinator.apply(f.store));
    const second = f.makeStore(), pending = second.stage(f.input, true); second.cancel(); await assert.rejects(pending, /cancelled/);
    const third = f.makeStore(); await third.stage(f.input, true); third.complete(); third.review('accepted'); third.cancel(); await assert.rejects(f.coordinator.apply(third));
  } finally { await f.cleanup(); }
});

test('partial undo is reported and subsequent retry cannot overwrite changes', async () => {
  const f = await fixture(); try {
    await f.store.stage(f.input, true); f.store.complete(); f.store.review('accepted'); await f.coordinator.apply(f.store);
    f.fail(); await assert.rejects(f.coordinator.undo(), /failed or was partial/);
    assert.equal(f.documents.get('a.py')!.content, f.before);
    assert.equal(f.documents.get('b.py')!.content, 'ALPHA\nkeep\nBETA\n');
    await assert.rejects(f.coordinator.undo(), /blocked/);
  } finally { await f.cleanup(); }
});

test('creation undo and rollback verify deletion even when the editor reports success', async () => {
  for (const hiddenFromEditor of [false, true]) {
    const f = await fixture(); try {
      await f.store.stage({ plan: 'Create a helper', files: [{ operation: 'create', path: 'new.py', content: 'new code\n' }] }, true);
      f.store.complete(); f.store.review('accepted'); await f.coordinator.apply(f.store);
      f.host.apply = async () => { if (hiddenFromEditor) f.documents.delete('new.py'); return true; };
      await assert.rejects(f.coordinator.undo(), /failed or was partial/);
      assert.equal(await readFile(path.join(f.root, 'new.py'), 'utf8'), '');
    } finally { await f.cleanup(); }
  }
  const f = await fixture(); try {
    await f.store.stage({ plan: 'Create helpers', files: ['new.py', 'other.py'].map(p => ({ operation: 'create', path: p, content: 'new code\n' })) }, true);
    f.store.complete(); f.store.review('accepted');
    const apply = f.host.apply.bind(f.host); let calls = 0;
    f.host.apply = async changes => { if (++calls === 1) return apply(changes); f.documents.delete('new.py'); return true; };
    f.fail(); await assert.rejects(f.coordinator.apply(f.store), /could not be safely restored/);
    assert.equal(await readFile(path.join(f.root, 'new.py'), 'utf8'), '');
  } finally { await f.cleanup(); }
});
