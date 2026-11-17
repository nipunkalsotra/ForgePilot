import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';

export const LIMITS = Object.freeze({ fileBytes: 64 * 1024, outputBytes: 96 * 1024, entries: 4000,
  files: 200, depth: 12, matches: 100, lineChars: 500, searchBytes: 4 * 1024 * 1024, milliseconds: 3000 });

export class WorkspaceError extends Error { override name = 'WorkspaceError'; }
const deniedDirs = new Set(['node_modules', 'vendor', 'dist', 'build', 'coverage', '__pycache__', 'venv', 'env', 'target']);
const sensitive = /(^|[._-])(secret[s]?|credential[s]?|password[s]?|token[s]?|private[-_]?key|service[-_]?account)([._-]|$)|\.(pem|key|p12|pfx|p8|jks|keystore|kdbx|sqlite3?|db|log)$/i;
const sensitiveNames = /^(id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|authorized_keys|known_hosts|config\.json|application_default_credentials\.json|netrc|npmrc|yarnrc|pip\.conf|terraform\.tfstate.*)$/i;
const sensitiveRoots = new Set(['.ssh', '.aws', '.azure', '.gcloud', '.gnupg', '.git', '.codex', '.agents']);

export function permittedParts(parts: string[]): boolean {
  return parts.every(p => !p.startsWith('.') && !deniedDirs.has(p.toLowerCase()) && !sensitive.test(p) && !sensitiveNames.test(p));
}

export class Workspace {
  private constructor(readonly root: string) {}

  static async create(root: string): Promise<Workspace> {
    const resolved = await realpath(root);
    if (resolved.split(path.sep).some(part => sensitiveRoots.has(part.toLowerCase()))) {
      throw new WorkspaceError('A credential, Git metadata, or agent configuration directory cannot be a workspace root.');
    }
    if (!(await lstat(resolved)).isDirectory()) throw new WorkspaceError('Workspace root must be a directory.');
    return new Workspace(resolved);
  }

  private relative(input: string, directory = false): string[] {
    if (typeof input !== 'string' || input.length > 1024 || input.includes('\0') || input.includes('\\')
      || input.includes(':') || path.isAbsolute(input)) throw new WorkspaceError('Use a workspace-relative path with forward slashes.');
    if (directory && (input === '.' || input === '')) return [];
    const parts = input.split('/');
    if (parts.some(p => p === '..' || p === '.' || p === '') || !permittedParts(parts)) {
      throw new WorkspaceError('Path is outside the readable workspace policy.');
    }
    return parts;
  }

  private contained(candidate: string): boolean {
    const rel = path.relative(this.root, candidate);
    return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
  }

  private async resolve(input: string, directory = false): Promise<string> {
    const parts = this.relative(input, directory);
    let current = this.root;
    for (const part of parts) {
      current = path.join(current, part);
      if ((await lstat(current)).isSymbolicLink()) throw new WorkspaceError('Symbolic links are not readable.');
    }
    const canonical = await realpath(current);
    if (!this.contained(canonical) || !permittedParts(path.relative(this.root, canonical).split(path.sep).filter(Boolean))) {
      throw new WorkspaceError('Path is outside the readable workspace policy.');
    }
    return canonical;
  }

  async readFile(input: string): Promise<{ path: string; content: string; bytes: number }> {
    try {
      const canonical = await this.resolve(input);
      const pre = await lstat(canonical);
      if (!pre.isFile() || pre.nlink !== 1 || pre.size > LIMITS.fileBytes) {
        throw new WorkspaceError('Only regular, single-link text files up to 64 KiB are readable.');
      }
      const handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > LIMITS.fileBytes || stat.dev !== pre.dev || stat.ino !== pre.ino) {
          throw new WorkspaceError('File changed or is not a bounded regular file.');
        }
        // Verify the opened descriptor, not just a path checked before open (ancestor-symlink races).
        if (process.platform === 'linux') {
          const opened = await realpath(`/proc/self/fd/${handle.fd}`);
          if (!this.contained(opened) || !permittedParts(path.relative(this.root, opened).split(path.sep))) {
            throw new WorkspaceError('Opened file escaped the workspace policy.');
          }
        }
        const after = await this.resolve(input);
        const same = await lstat(after);
        if (same.ino !== stat.ino || same.dev !== stat.dev) throw new WorkspaceError('File changed while opening.');
        const buffer = Buffer.alloc(LIMITS.fileBytes + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > LIMITS.fileBytes) throw new WorkspaceError('File exceeds 64 KiB.');
        const data = buffer.subarray(0, bytesRead);
        if (data.includes(0)) throw new WorkspaceError('Binary files are not readable.');
        let content: string;
        try { content = new TextDecoder('utf-8', { fatal: true }).decode(data); }
        catch { throw new WorkspaceError('File must be UTF-8 text.'); }
        return { path: input, content, bytes: bytesRead };
      } finally { await handle.close(); }
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      throw new WorkspaceError('File is unavailable or forbidden.');
    }
  }

  private async walk(input: string): Promise<{ files: string[]; truncated: boolean }> {
    const files: string[] = [];
    let visited = 0;
    let truncated = false;
    const deadline = Date.now() + LIMITS.milliseconds;
    const visit = async (rel: string, depth: number): Promise<void> => {
      if (depth > LIMITS.depth || Date.now() > deadline || visited >= LIMITS.entries || files.length >= LIMITS.files) {
        truncated = true; return;
      }
      const dir = await opendir(await this.resolve(rel, true));
      for await (const entry of dir) {
        if (++visited > LIMITS.entries || files.length >= LIMITS.files || Date.now() > deadline) { truncated = true; break; }
        if (!permittedParts([entry.name]) || entry.isSymbolicLink()) continue;
        const next = rel === '.' ? entry.name : `${rel}/${entry.name}`;
        if (entry.isDirectory()) await visit(next, depth + 1);
        else if (entry.isFile()) {
          const info = await lstat(await this.resolve(next));
          if (info.nlink === 1) files.push(next);
        }
      }
    };
    try { await visit(input, 0); } catch { throw new WorkspaceError('Directory is unavailable, changed, or forbidden.'); }
    return { files, truncated };
  }

  async listFiles(input = '.'): Promise<{ files: string[]; truncated: boolean }> {
    this.relative(input, true);
    return this.walk(input || '.');
  }

  async search(query: string, input = '.'): Promise<{ matches: { path: string; line: number; text: string }[]; truncated: boolean; skippedFiles: number }> {
    if (!query.trim() || query.length > 200 || query.includes('\n') || query.includes('\r')) throw new WorkspaceError('Search must be a single-line literal of 1–200 characters.');
    const listing = await this.listFiles(input);
    const matches: { path: string; line: number; text: string }[] = [];
    let bytes = 0;
    let skippedFiles = 0;
    let truncated = listing.truncated;
    const deadline = Date.now() + LIMITS.milliseconds;
    outer: for (const file of listing.files) {
      if (Date.now() > deadline || bytes >= LIMITS.searchBytes) { truncated = true; break; }
      let read: Awaited<ReturnType<Workspace['readFile']>>;
      try { read = await this.readFile(file); } catch { skippedFiles++; continue; }
      bytes += read.bytes;
      const lines = read.content.split('\n');
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index]!;
        if (line.includes(query)) {
          const start = Math.max(0, line.indexOf(query) - 100);
          matches.push({ path: file, line: index + 1, text: line.slice(start, start + LIMITS.lineChars) });
          if (matches.length >= LIMITS.matches) { truncated = true; break outer; }
        }
      }
    }
    return { matches, truncated, skippedFiles };
  }
}
