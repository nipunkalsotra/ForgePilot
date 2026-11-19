import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Include the original notices for packages actually bundled into runtime files. */
export async function writeThirdPartyNotices(metafile) {
  const roots = new Map();
  const inputs = new Set(Object.entries(metafile.outputs)
    .filter(([name]) => /(?:extension|mcp-child)\.cjs$/.test(name))
    .flatMap(([, output]) => Object.keys(output.inputs)));
  for (const input of inputs) {
    if (!input.includes('node_modules/')) continue;
    let dir = path.dirname(path.resolve(input));
    while (dir.includes(`${path.sep}node_modules${path.sep}`)) {
      let metadata;
      try { metadata = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')); }
      catch { /* A source directory need not be a package root. */ }
      if (metadata?.name && metadata.version) { roots.set(dir, metadata); break; }
      dir = path.dirname(dir);
    }
  }
  const notices = ['ForgePilot bundled runtime dependencies',
    'Original third-party license and notice texts follow. ForgePilot itself is MIT licensed.\n'];
  for (const [dir, metadata] of [...roots].sort((a, b) => a[1].name.localeCompare(b[1].name, 'en'))) {
    const files = (await readdir(dir)).filter(name => /^(licen[sc]e|copying|notice)(\.|$)/i.test(name)).sort();
    if (!files.length) throw new Error(`Missing bundled license text: ${metadata.name}`);
    notices.push(`\n===== ${metadata.name}@${metadata.version} (${metadata.license}) =====\n`);
    for (const name of files) notices.push(await readFile(path.join(dir, name), 'utf8'));
  }
  await writeFile('dist/THIRD_PARTY_NOTICES.txt', notices.join('\n') + '\n');
}
