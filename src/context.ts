import { Workspace } from './workspace';
import { ForgePilotError } from './log';
import { hash } from './patch';
import type { TokenBudgetManager } from './budget';

export const estimatedTokens = (text: string): number => Math.ceil(Buffer.byteLength(text, 'utf8') / 3);
const stop = new Set('a an the add new built in to of and or is as be by for that it with from should must this all well include update implement'.split(' '));
export interface Candidate { path: string; score: number; reasons: string[]; line: number; symbols: string[] }
export interface ContextPackage {
  kind: 'forgepilot.context'; omissions?: { path: string; reason: string }[]; retrievalReduced?: boolean; query: string; source: string; discovered: number; scannedBytes: number;
  candidates: Candidate[]; selected: (Candidate & { content: string; start: number; end: number; baseHash: string; truncated: boolean })[];
  omitted: number; truncated: boolean; budget: number; reserved: number; estimatedTokens: number; methodology: string;
}
const declarations = /(?:^|\s)(?:export\s+)?(?:async\s+)?(?:def|class|function|interface|type|const|let|var)\s+([A-Za-z_$][\w$]*)/;
export class ContextEngine {
  private delivered = new Set<string>();
  reset(): void { this.delivered.clear(); }
  async range(path: string, start: number, count: number) {
    const requestedCount = count;
    if (this.reduced()) count = Math.min(count, 20);
    const read = { ...await this.workspace.readRange(path, start, count), ...(requestedCount > count ? { requestedCount, omission: 'Budget reduced this read to 20 lines; remaining lines omitted. Use targeted follow-up ranges.' } : {}) };
    const key = `${this.workspace.root}:${path}:${read.hash}:${start}:${count}`;
    const duplicate = { path: read.path, content: '', start: read.start, end: read.end, hash: read.hash, identity: read.identity, duplicate: true, omission: 'Unchanged range; freshly verified.' };
    if (this.delivered.has(key) && Buffer.byteLength(JSON.stringify(duplicate)) < Buffer.byteLength(JSON.stringify(read))) return duplicate;
    if (this.delivered.size >= 128) this.delivered.clear();
    this.delivered.add(key); return read;
  }
  constructor(readonly workspace: Workspace, readonly budget = 12000, private readonly resources?: TokenBudgetManager) {
    if (!Number.isSafeInteger(budget) || budget < 2000 || budget > 32000) throw new ForgePilotError('Context budget must be 2,000–32,000 estimated tokens.');
  }
  reduced(): boolean { return (this.resources?.retrievalBudget(this.budget) ?? this.budget) < this.budget; }
  async outline(path: string) {
    const file = await this.workspace.readFile(path, 1024 * 1024), lines = file.content.split('\n');
    const symbols: { line: number; name: string }[] = [];
    let truncated = false;
    for (const [i, text] of lines.entries()) {
      const name = declarations.exec(text)?.[1];
      const heading = i > 0 && /^[=~^#*+-]{3,}$/.test(text.trim()) && lines[i - 1]!.trim() ? lines[i - 1]!.trim() : undefined;
      if (!name && !heading) continue;
      if (symbols.length >= (this.reduced() ? 25 : 100)) { truncated = true; break; }
      symbols.push({ line: name ? i + 1 : i, name: (name ?? heading!).slice(0, 120) });
    }
    return { path, baseHash: hash(file.content), totalLines: lines.length, symbols, truncated, methodology: 'Heuristic declarations and underlined headings, not a parser. Read targeted ranges around relevant locations; do not read a long file sequentially.' };
  }
  async discover(query = '', scope = '.', cursor = 0, limit = 100) {
    if (query.length > 200 || !Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new ForgePilotError('Invalid discovery query or page.');
    const listing = await this.workspace.inventory(scope);
    const names = listing.files.filter(p => p.toLowerCase().includes(query.toLowerCase()));
    return { ...listing, files: names.slice(cursor, cursor + limit), matched: names.length, nextCursor: cursor + limit < names.length ? cursor + limit : null,
      truncated: listing.truncated || cursor + limit < names.length };
  }
  async search(query: string, scope = '.', symbol = false) {
    if (!query.trim() || query.length > 200 || /[\r\n\0]/.test(query)) throw new ForgePilotError('Search requires a bounded single-line literal.');
    const listing = await this.workspace.inventory(scope), deadline = Date.now() + 5000;
    const matches: { path: string; line: number; text: string; symbol?: string }[] = [];
    let scannedBytes = 0, skipped = 0, truncated = listing.truncated;
    for (const file of listing.files) {
      if (Date.now() > deadline || scannedBytes >= 8 * 1024 * 1024 || matches.length >= 100) { truncated = true; break; }
      try {
        const read = await this.workspace.readFile(file, 1024 * 1024);
        if (scannedBytes + read.bytes > 8 * 1024 * 1024) { truncated = true; break; }
        scannedBytes += read.bytes;
        for (const [i, line] of read.content.split('\n').entries()) {
          const name = declarations.exec(line)?.[1];
          if (symbol ? name === query : line.toLowerCase().includes(query.toLowerCase())) matches.push({ path: file, line: i + 1, text: line.slice(0, 400), symbol: name });
          if (matches.length >= 100) break;
        }
      } catch { skipped++; }
    }
    return { matches, scannedBytes, skipped, truncated };
  }
  async retrieve(query: string, scope = '.'): Promise<ContextPackage> {
    if (!query.trim() || query.length > 16000) throw new ForgePilotError('Enter a context query of 1–16,000 characters.');
    const budget = this.resources?.retrievalBudget(this.budget) ?? this.budget;
    const fileRefs = [...query.matchAll(/@file(?:\(([^)]+)\)|:([^\s]+))/g)].map(m => (m[1] ?? m[2])!);
    const symbolRefs = [...query.matchAll(/@symbol(?:\(([^)]+)\)|:([\w$]+))/g)].map(m => (m[1] ?? m[2])!);
    // Also support @path/to/file and @Identifier shorthand; explicit syntax disambiguates.
    for (const match of query.matchAll(/(?:^|\s)@([\w./-]+)(?=\s|$)/g)) {
      if (match[1]!.includes('/') || match[1]!.includes('.')) fileRefs.push(match[1]!); else symbolRefs.push(match[1]!);
    }
    if (fileRefs.length + symbolRefs.length > 16) throw new ForgePilotError('Use at most 16 explicit references.');
    const explicit = new Map<string, Awaited<ReturnType<Workspace['readFile']>>>();
    for (const file of new Set(fileRefs)) explicit.set(file, await this.workspace.readFile(file, 1024 * 1024));
    const words = [...new Set((query.toLowerCase().match(/[a-z_][a-z0-9_]{1,}/g) ?? []).filter(w => !stop.has(w)))].slice(0, 40);
    const listing = await this.workspace.inventory(scope);
    const paths = [...new Set([...fileRefs, ...listing.files])];
    const ranked: Candidate[] = [];
    const deadline = Date.now() + 8000;
    let scannedBytes = 0, truncated = listing.truncated;
    // Filename scores prioritize the scanning order; bounded full-text scanning still covers late files.
    paths.sort((a, b) => words.filter(w => b.toLowerCase().includes(w)).length - words.filter(w => a.toLowerCase().includes(w)).length || a.localeCompare(b));
    const texts = new Map<string, string>();
    for (const file of paths) {
      if (Date.now() > deadline || scannedBytes >= 8 * 1024 * 1024) { truncated = true; break; }
      try {
        const read = explicit.get(file) ?? await this.workspace.readFile(file, 1024 * 1024);
        if (scannedBytes + read.bytes > 8 * 1024 * 1024) { truncated = true; break; }
        scannedBytes += read.bytes;
        const lines = read.content.split('\n'), reasons: string[] = [], symbols: string[] = [];
        let score = 0, bestLine = 1, bestHits = 0;
        if (fileRefs.includes(file)) { score += 1000; reasons.push('explicit file reference'); }
        for (const word of words) if (file.toLowerCase().includes(word)) { score += 12; reasons.push(`path matches ${word}`); }
        for (const [i, line] of lines.entries()) {
          const name = declarations.exec(line)?.[1];
          if (name) { if (symbols.length < 8) symbols.push(name); if (symbolRefs.includes(name)) { score += 1000; bestLine = i + 1; reasons.push(`explicit symbol ${name}`); } }
          const hits = words.filter(w => line.toLowerCase().includes(w)).length;
          if (hits > bestHits && !reasons.some(r => r.startsWith('explicit symbol'))) { bestHits = hits; bestLine = i + 1; }
          score += Math.min(hits, 3) * 0.15;
        }
        if (bestHits) { score += bestHits * 8; reasons.push(`lexical evidence (${bestHits} terms near line ${bestLine})`); }
        if (score > 0) { ranked.push({ path: file, score: Math.round(score * 10) / 10, reasons, line: bestLine, symbols }); texts.set(file, read.content); }
      } catch { /* Forbidden/binary files cannot supply snippets. */ }
    }
    for (const ref of symbolRefs) if (!ranked.some(c => c.reasons.includes(`explicit symbol ${ref}`))) throw new ForgePilotError(`Symbol reference '${ref}' was not resolved within the search budget.`);
    // Lexical import evidence: candidate imports of another candidate's module strengthen that relationship.
    for (const candidate of ranked.slice(0, 100)) {
      const module = candidate.path.split('/').at(-1)!.replace(/\.[^.]+$/, '');
      if (module.length < 3) continue;
      const related = ranked.slice(0, 100).find(other => other !== candidate && texts.get(other.path)!.split('\n').some(line => /\b(import|from|require)\b/.test(line) && line.includes(module)));
      if (related) { candidate.score += 5; candidate.reasons.push(`import/reference in ${related.path}`); }
    }
    ranked.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    const result: ContextPackage = { kind: 'forgepilot.context', ...(budget < this.budget ? { retrievalReduced: true } : {}), query, source: listing.source, discovered: listing.files.length, scannedBytes,
      candidates: ranked.slice(0, 20), selected: [], omitted: ranked.length, truncated, budget,
      reserved: Math.min(budget - 500, Math.max(1000, estimatedTokens(query) + 1000)), estimatedTokens: 0,
      methodology: 'estimate: ceil(UTF-8 bytes / 3); JSON metadata included; reserve for instructions/output, SDK tool schemas excluded' };
    while (estimatedTokens(JSON.stringify(result.candidates)) > (budget - result.reserved) / 3 && result.candidates.length) { result.candidates.pop(); result.truncated = true; }
    // Avoid a repository full of same-role files crowding out implementation/tests/docs evidence.
    const role = (p: string) => /(^|\/)(tests?|specs?)(\/|[._-])|[._-](test|spec)\./i.test(p) ? 'tests' : /(^|\/)(docs?|documentation)(\/|$)|\.(rst|md)$/i.test(p) ? 'documentation' : 'implementation';
    const implementation = ranked.find(c => role(c.path) === 'implementation');
    if (implementation) {
      const stem = implementation.path.split('/').at(-1)!.replace(/\.[^.]+$/, '');
      for (const candidate of ranked) if (candidate !== implementation && candidate.path.split('/').at(-1)!.includes(stem)) { candidate.score += 15; candidate.reasons.push(`parallel path/name to ${implementation.path}`); }
      ranked.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
      result.candidates = ranked.slice(0, result.candidates.length);
    }
    const selectedOrder: Candidate[] = [];
    for (const kind of ['implementation', 'tests', 'documentation']) { const found = ranked.find(c => role(c.path) === kind); if (found) selectedOrder.push(found); }
    for (const c of ranked) if (!selectedOrder.includes(c)) selectedOrder.push(c);
    // Cache only this retrieval's verified snapshots; one re-read validates each selected hash.
    // No source survives the request and every use compares a fresh authorized full-file hash.
    for (const candidate of selectedOrder.slice(0, budget < this.budget ? 4 : 12)) {
      const cached = texts.get(candidate.path)!;
      let current: Awaited<ReturnType<Workspace['readFile']>>;
      try { current = await this.workspace.readFile(candidate.path, 1024 * 1024); }
      catch { result.truncated = true; (result.omissions ??= []).push({ path: candidate.path, reason: 'Source unavailable during hash revalidation; no cached content returned.' }); continue; }
      if (hash(current.content) !== hash(cached)) { result.truncated = true; (result.omissions ??= []).push({ path: candidate.path, reason: 'Source changed after scan; read a fresh targeted range.' }); continue; }
      const lines = cached.split('\n');
      const start = Math.max(1, candidate.line - 15);
      for (let count = budget < this.budget ? 20 : 80; count >= 5; count = Math.floor(count / 2)) {
        let range: Awaited<ReturnType<Workspace['readRange']>>;
        try {
          const content = lines.slice(start - 1, start - 1 + count).join('\n');
          if (Buffer.byteLength(content) > 65536) throw new ForgePilotError('Range exceeds read limit.');
          range = { path: candidate.path, content, start, end: Math.min(lines.length, start - 1 + count), totalLines: lines.length, truncated: start > 1 || start - 1 + count < lines.length, hash: hash(cached), identity: current.identity };
        }
        catch { result.truncated = true; continue; }
        const item = { ...candidate, content: range.content, start, end: range.end, baseHash: range.hash, truncated: range.truncated };
        result.selected.push(item);
        if (estimatedTokens(JSON.stringify(result)) <= budget - result.reserved && JSON.stringify(result).length <= 20000) break;
        result.selected.pop(); result.truncated = true;
      }
    }
    result.omitted = ranked.length - result.selected.length;
    while (estimatedTokens(JSON.stringify(result)) > budget - result.reserved && result.candidates.length) { result.candidates.pop(); result.truncated = true; }
    result.truncated ||= result.omitted > 0;
    while (JSON.stringify(result).length > 20000 && result.selected.length) { result.selected.pop(); result.truncated = true; }
    while (JSON.stringify(result).length > 20000 && result.candidates.length) { result.candidates.pop(); result.truncated = true; }
    result.omitted = ranked.length - result.selected.length;
    result.estimatedTokens = estimatedTokens(JSON.stringify(result));
    result.estimatedTokens = estimatedTokens(JSON.stringify(result));
    if (result.estimatedTokens + result.reserved > budget) throw new ForgePilotError('Context metadata exceeds budget. Shorten the query.');
    return result;
  }
}
