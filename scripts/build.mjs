import { build, context } from 'esbuild';

const options = {
  entryPoints: { extension: 'src/extension.ts', 'mcp-child': 'src/mcp/child.ts', 'extension-test': 'tests/extension-host.ts' },
  outdir: 'dist', outExtension: { '.js': '.cjs' }, bundle: true,
  platform: 'node', format: 'cjs', target: 'node22', external: ['vscode'], sourcemap: true,
};
if (process.argv.includes('--watch')) {
  await (await context(options)).watch();
} else {
  await build(options);
}
