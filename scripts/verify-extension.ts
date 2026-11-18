import { runTests } from '@vscode/test-electron';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';

const profile = await mkdtemp(path.join(tmpdir(), 'forgepilot-vscode-'));
const workspace = process.env.FORGEPILOT_FLASK_ROOT ?? await mkdtemp(path.join(tmpdir(), 'forgepilot-vscode-workspace-'));
const marker = `extension-host-${randomBytes(12).toString('hex')}`;
if (!process.env.FORGEPILOT_FLASK_ROOT) await writeFile(path.join(workspace, 'inspection.txt'), marker);
try {
  await runTests({
    extensionDevelopmentPath: process.cwd(), extensionTestsPath: path.resolve('dist/extension-test.cjs'),
    vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH,
    extensionTestsEnv: { FORGEPILOT_TEST_MARKER: marker, FORGEPILOT_ARTIFACTS: path.resolve('artifacts') },
    launchArgs: ['--disable-extensions', '--disable-gpu', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust',
      `--user-data-dir=${profile}`, workspace],
  });
} finally { await rm(profile, { recursive: true, force: true }); if (!process.env.FORGEPILOT_FLASK_ROOT) await rm(workspace, { recursive: true, force: true }); }
