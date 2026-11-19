import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localBaseUrl } from '../src/config';
import { publicError } from '../src/log';

test('only local TrueForge URLs can receive requests', () => {
  for (const url of ['http://localhost:8790', 'http://127.0.0.1:8790/', 'http://[::1]:8790']) assert.ok(localBaseUrl(url));
  for (const url of ['https://example.com', 'http://127.0.0.1.attacker.com', 'http://user:secret@localhost', 'file:///tmp/x', 'http://localhost/path', 'http://localhost?key=secret']) assert.throws(() => localBaseUrl(url));
});

test('errors do not expose server bodies or credentials', () => {
  const error = Object.assign(new Error('credential secret-value'), { statusCode: 401, body: { token: 'secret-value' } });
  assert.match(publicError(error), /HTTP 401/);
  assert.ok(!publicError(error).includes('secret-value'));
  assert.ok(!publicError(new Error('secret-value')).includes('secret-value'));
});

test('fallback requires developer machine settings and has no automatic agent default', async () => {
  const { readFile } = await import('node:fs/promises');
  const { contributes: { configuration: { properties } } } = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal(properties['forgepilot.fallbackEnabled'].default, false);
  assert.equal(properties['forgepilot.fallbackAgentName'].default, '');
  for (const name of ['forgepilot.fallbackEnabled', 'forgepilot.fallbackAgentName']) assert.equal(properties[name].scope, 'machine');
});
