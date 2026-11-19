import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { TrueForge } from '@truefoundry/trueforge-sdk';
import { hash } from '../src/patch';
import { publicError } from '../src/log';

// Disposable providers and agents only. Never list/read/write real provider manifests or credentials.
const c = new TrueForge({ baseUrl: 'http://localhost:8790', timeoutInSeconds: 10, maxRetries: 0 });
const suffix = randomBytes(5).toString('hex');
const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
const address = probe.address(); assert.ok(address && typeof address === 'object'); const refusedPort = address.port;
await new Promise<void>(resolve => probe.close(() => resolve()));
const names = [`forgepilot-c-auth-${suffix}`, `forgepilot-c-net-${suffix}`];
const createdProviders: string[] = [], createdAgents: string[] = [];
const originals = new Map<string, string>();
const summary: Record<string, unknown> = { timestamp: new Date().toISOString(), test: 'isolated Task C through actual extension host', providers: names, realProvidersModified: false };
try {
  assert.ok(process.env.FORGEPILOT_FLASK_ROOT, 'Set FORGEPILOT_FLASK_ROOT to a fresh clean pinned checkout.');
  const git = promisify(execFile);
  assert.equal((await git('git', ['rev-parse', 'HEAD'], { cwd: process.env.FORGEPILOT_FLASK_ROOT })).stdout.trim(), '22d924701a6ae2e4cd01e9a15bbaf3946094af65');
  assert.equal((await git('git', ['status', '--porcelain'], { cwd: process.env.FORGEPILOT_FLASK_ROOT })).stdout.trim(), '');
  const found = [];
  for await (const agent of await c.agents.list()) if (['forge-coder', 'forge-coder-openrouter'].includes(agent.name)) found.push((await c.agents.get(agent.id)).data);
  const generic = found.find(a => a.name === 'forge-coder-openrouter'); assert.ok(generic);
  for (const agent of found) originals.set(agent.id, hash(JSON.stringify(agent.manifest)));
  for (const [index, name] of names.entries()) {
    await c.settings.modelProviders.create({ manifest: { type: 'custom', name,
      baseUrl: index === 0 ? 'https://openrouter.ai/api/v1' : `http://127.0.0.1:${refusedPort}/v1`,
      auth: { apiKey: 'forgepilot-intentionally-invalid-nonsecret-test-key' },
      models: [{ name: 'test-model', modelId: 'nvidia/nemotron-3-ultra-550b-a55b:free', properties: { contextLength: 100000, maxOutputTokens: 4096 } }],
    } }); createdProviders.push(name);
    const model = (await c.models.list()).data.find(m => m.provider.name === name); assert.ok(model);
    const { data } = await c.agents.create({ name, description: 'Disposable ForgePilot Phase 4 failure test; not a production agent',
      manifest: { ...generic.manifest, model: { name: model.name }, mcpServers: [], skills: [] } });
    createdAgents.push(data.id);
  }
  const child = await promisify(execFile)('node', ['--import', 'tsx', 'scripts/verify-extension.ts'], {
    env: { ...process.env, FORGEPILOT_TASKC: '1', FORGEPILOT_TASKC_AUTH: names[0], FORGEPILOT_TASKC_NET: names[1] },
    timeout: 420000, maxBuffer: 2 * 1024 * 1024,
  });
  process.stdout.write(child.stdout); process.stderr.write(child.stderr);
  summary.result = 'PASS';
} catch (error) {
  summary.result = 'FAIL'; summary.error = publicError(error);
  // Child logs contain only sanitized ForgePilot diagnostics and fixture assertions, never provider config.
  if (error && typeof error === 'object' && 'stdout' in error && typeof error.stdout === 'string') process.stdout.write(error.stdout.slice(-20000));
  if (error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string') process.stderr.write(error.stderr.slice(-10000));
  process.exitCode = 1;
} finally {
  const cleanup: string[] = [];
  for (const id of createdAgents.reverse()) try { await c.agents.delete(id); } catch { cleanup.push('agent cleanup failed'); }
  for (const name of createdProviders.reverse()) try { await c.settings.modelProviders.delete(name); } catch { cleanup.push('disposable provider cleanup failed'); }
  for (const [id, before] of originals) if (hash(JSON.stringify((await c.agents.get(id)).data.manifest)) !== before) cleanup.push('saved production agent changed');
  summary.cleanup = cleanup.length ? cleanup : 'PASS'; if (cleanup.length) process.exitCode = 1;
  const prefix = process.env.FORGEPILOT_TASKC_REPORT_PREFIX ?? 'phase4-taskc';
  assert.match(prefix, /^[a-z0-9-]{1,80}$/);
  await mkdir('artifacts', { recursive: true }); await writeFile(`artifacts/${prefix}-setup.json`, JSON.stringify(summary, null, 2));
  await writeFile(`artifacts/${prefix}-setup-${suffix}.json`, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
}
