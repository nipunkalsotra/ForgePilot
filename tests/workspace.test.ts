import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, link, readFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Workspace, LIMITS } from '../src/workspace';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'forgepilot-workspace-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'forgepilot-outside-'));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src/main.ts'), 'hello workspace\nsecond hello\n');
  await writeFile(path.join(outside, 'outside.txt'), 'outside forbidden marker');
  const workspace = await Workspace.create(root);
  return { root, outside, workspace, async cleanup() { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); } };
}

test('lists, reads, and searches real files without changing them', async () => {
  const f = await fixture();
  try {
    const before = await readFile(path.join(f.root, 'src/main.ts'));
    assert.deepEqual((await f.workspace.listFiles()).files, ['src/main.ts']);
    assert.equal((await f.workspace.readFile('src/main.ts')).content, before.toString());
    assert.deepEqual((await f.workspace.search('hello')).matches.map(m => m.line), [1, 2]);
    assert.deepEqual(await readFile(path.join(f.root, 'src/main.ts')), before);
    assert.equal((await f.workspace.search('.*')).matches.length, 0, 'search is literal, not regex');
  } finally { await f.cleanup(); }
});

test('rejects traversal, absolute paths, alternate separators, hidden and sensitive paths', async () => {
  const f = await fixture();
  try {
    for (const input of ['../outside.txt', '/etc/passwd', 'src/../../etc/passwd', 'src/../src/main.ts', 'src\\main.ts', 'C:/key', 'src/main.ts\0', '.env', '.git/config', '.aws/credentials', '.npmrc', 'credentials.json', 'secrets/data.txt', 'server.pem', 'id_ed25519', 'terraform.tfstate', 'node_modules/pkg/index.js', 'src//main.ts']) {
      await assert.rejects(f.workspace.readFile(input), { name: 'WorkspaceError' }, input);
    }
    for (const name of ['.env', 'credentials.json', 'server.key', 'production.secrets.json']) await writeFile(path.join(f.root, name), 'forbidden');
    assert.deepEqual((await f.workspace.listFiles()).files, ['src/main.ts']);
    assert.equal((await f.workspace.search('forbidden')).matches.length, 0);
    await assert.rejects(f.workspace.listFiles('../'));
    await assert.rejects(f.workspace.search(''));
    await assert.rejects(f.workspace.search('a\nb'));
  } finally { await f.cleanup(); }
});

test('rejects external and internal symlinks, directory symlinks, hardlinks and special files', async () => {
  const f = await fixture();
  try {
    await symlink(path.join(f.outside, 'outside.txt'), path.join(f.root, 'escape.txt'));
    await symlink(path.join(f.root, 'src/main.ts'), path.join(f.root, 'alias.ts'));
    await symlink(f.outside, path.join(f.root, 'escape-dir'));
    await link(path.join(f.outside, 'outside.txt'), path.join(f.root, 'hardlink.txt'));
    for (const input of ['escape.txt', 'alias.ts', 'escape-dir/outside.txt', 'hardlink.txt', 'src']) await assert.rejects(f.workspace.readFile(input));
    assert.deepEqual((await f.workspace.listFiles()).files, ['src/main.ts']);
    await assert.rejects(f.workspace.listFiles('escape-dir'));
  } finally { await f.cleanup(); }
});

test('bounds reads, file traversal, matches and binary decoding', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.root, 'big.txt'), Buffer.alloc(LIMITS.fileBytes + 1, 65));
    await writeFile(path.join(f.root, 'binary.bin'), Buffer.from([1, 0, 3]));
    await writeFile(path.join(f.root, 'invalid.txt'), Buffer.from([255, 254]));
    for (const name of ['big.txt', 'binary.bin', 'invalid.txt']) await assert.rejects(f.workspace.readFile(name));
    await writeFile(path.join(f.root, 'many.txt'), 'find me\n'.repeat(200));
    const result = await f.workspace.search('find me');
    assert.equal(result.matches.length, LIMITS.matches);
    assert.equal(result.truncated, true);
    await Promise.all(Array.from({ length: 205 }, (_, i) => writeFile(path.join(f.root, `file-${i}.txt`), 'sample')));
    const list = await f.workspace.listFiles();
    assert.equal(list.files.length, LIMITS.files);
    assert.equal(list.truncated, true);
  } finally { await f.cleanup(); }
});

test('rejects sensitive directories as authorized roots', async () => {
  const f = await fixture();
  try {
    await mkdir(path.join(f.root, '.aws', 'nested'), { recursive: true });
    await assert.rejects(Workspace.create(path.join(f.root, '.aws', 'nested')), /cannot be a workspace root/);
  } finally { await f.cleanup(); }
});

test('ancestor symlink replacement races never disclose outside file contents', async () => {
  const f = await fixture();
  await writeFile(path.join(f.outside, 'main.ts'), 'outside forbidden marker');
  const src = path.join(f.root, 'src');
  const parked = path.join(f.root, 'parked');
  let running = true;
  const attacker = (async () => {
    while (running) {
      await rename(src, parked);
      await symlink(f.outside, src);
      await new Promise<void>(resolve => setImmediate(resolve));
      await rm(src);
      await rename(parked, src);
    }
  })();
  try {
    for (let i = 0; i < 200; i++) {
      try {
        const read = await f.workspace.readFile('src/main.ts');
        assert.equal(read.content, 'hello workspace\nsecond hello\n');
      } catch (error) { assert.equal((error as Error).name, 'WorkspaceError'); }
    }
  } finally { running = false; await attacker; await f.cleanup(); }
});
