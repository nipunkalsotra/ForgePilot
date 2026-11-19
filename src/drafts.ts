import { Script } from 'node:vm';
import Module from 'node:module';
import { randomUUID } from 'node:crypto';
import { BatchStore, parseBatch, type BatchPatch } from './batch';
import { hash, PatchValidationError } from './patch';
import { ForgePilotError } from './log';
import { Workspace, WorkspaceError } from './workspace';

type FilePatch = BatchPatch['files'][number];
export interface DraftDiagnostic { path?: string; valid: boolean; code?: string; guidance?: string; editIndex?: number }
const guidance: Record<string, string> = {
  DUPLICATE_PATH: 'Group all disjoint edits for this exact path into one file entry. Correct duplicates before final staging.',
  BASE_HASH_MISMATCH: 'Read a current source range and use its full-file SHA-256. Rebuild edits against that original.',
  ANCHOR_NOT_FOUND: 'Read the original short range again. Match decoded whitespace, newlines and quotes exactly; no fuzzy substitution is performed.',
  ANCHOR_NOT_UNIQUE: 'Extend the original anchor with adjacent unchanged text until it occurs exactly once.',
  OVERLAPPING_EDITS: 'Combine overlapping replacements into one exact original anchor, or use disjoint original anchors.',
  FILE_NOT_FOUND: 'Discover the exact existing path, or explicitly use create only for an absent file with an existing permitted parent.',
  CREATION_TARGET_EXISTS: 'Use modify with the current full-file hash for an existing target. Creation never overwrites.',
  INVALID_OPERATION: 'Specify operation=modify with path/baseHash/edits, or operation=create with path/content.',
  SCHEMA_INVALID: 'Use only the required variant fields, a 64-character lowercase SHA-256 and 1–64 nonempty oldText replacements; keep text and batch within limits.',
  WORKSPACE_FORBIDDEN: 'Choose a permitted workspace-relative UTF-8 single-link regular file. Hidden, sensitive and linked paths remain forbidden.',
  DRAFT_EXISTS: 'This path already has a retained draft. Use extend_draft with its current ID for additional disjoint edits. To replace the entire draft intentionally, pass replaceDraftId to draft_file with ALL file edits. Recover IDs with list_drafts.',
  STALE_DRAFT: 'Recover current IDs with list_drafts. Use only an ID returned in this request; never invent IDs or reuse superseded IDs.',
};
function diagnostic(error: unknown, path?: string): DraftDiagnostic {
  const code = error instanceof PatchValidationError || error instanceof WorkspaceError ? error.code : 'SCHEMA_INVALID';
  return { path, valid: false, code, guidance: guidance[code] ?? guidance.SCHEMA_INVALID, ...(error instanceof PatchValidationError && error.editIndex !== undefined ? { editIndex: error.editIndex } : {}) };
}
export async function checkFile(workspace: Workspace, value: unknown): Promise<DraftDiagnostic> {
  const file = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const path = typeof file.path === 'string' ? file.path.slice(0, 1024) : undefined;
  if (file.operation !== 'modify' && file.operation !== 'create') return { path, valid: false, code: 'INVALID_OPERATION', guidance: guidance.INVALID_OPERATION };
  if (file.operation === 'create' && ('baseHash' in file || 'edits' in file)) return { path, valid: false, code: 'INVALID_OPERATION', guidance: 'baseHash/edits describe an existing-file replacement: use operation=modify and omit content. Create accepts only path/content for an absent target.' };
  if (file.operation === 'modify' && (!('baseHash' in file) || !('edits' in file) || 'content' in file)) return { path, valid: false, code: 'SCHEMA_INVALID', guidance: 'Modify requires path, baseHash and edits. Omit content; it is only valid for a new-file creation.' };
  try {
    const candidate = await new BatchStore(workspace).stage({ plan: 'Read-only draft validation', files: [value] }, true);
    const proposed = candidate.files[0]!.proposed;
    // Parse data and CommonJS only. Never execute source or resolve/import repository modules.
    try {
      if (path?.endsWith('.json') && !/(^|\/)(tsconfig|jsconfig)(\.[^/]+)?\.json$/i.test(path)) JSON.parse(proposed);
      if (path?.endsWith('.cjs')) new Script(Module.wrap(proposed.replace(/^\uFEFF/, '').replace(/^#![^\r\n]*/, '')));
    } catch { return { path, valid: false, code: 'SYNTAX_INVALID', guidance: 'Proposed JSON/CommonJS syntax is invalid. Inspect and correct the retained replacements. No code was executed; behavioral verification remains required.' }; }
    return { path, valid: true };
  }
  catch (error) { return diagnostic(error, path); }
}
export async function checkBatch(workspace: Workspace, value: { plan: string; files: unknown[] }) {
  const counts = new Map<string, number>();
  for (const file of value.files) if (file && typeof file === 'object' && 'path' in file && typeof file.path === 'string') counts.set(file.path.toLowerCase(), (counts.get(file.path.toLowerCase()) ?? 0) + 1);
  const files = await Promise.all(value.files.map(async file => {
    const result = await checkFile(workspace, file);
    const duplicate = result.path && (counts.get(result.path.toLowerCase()) ?? 0) > 1;
    return { ...result, ...(duplicate ? { valid: false, duplicate: { code: 'DUPLICATE_PATH', guidance: guidance.DUPLICATE_PATH }, ...(result.valid ? { code: 'DUPLICATE_PATH', guidance: guidance.DUPLICATE_PATH } : {}) } : {}) };
  }));
  let batchValid = true;
  try { parseBatch(value); } catch { batchValid = false; }
  return { kind: 'forgepilot.check', valid: batchValid && files.every(f => f.valid), ...(batchValid ? {} : { batchCode: 'SCHEMA_INVALID', guidance: guidance.SCHEMA_INVALID }), files, approval: 'none: validation only' };
}

/** One active request scope, bounded validated file drafts, no workspace writes or edit approval. */
export class DraftStore {
  private active?: string;
  private retired = new Set<string>();
  private files = new Map<string, { id: string; file: FilePatch }>();
  private closed = false;
  constructor(private readonly workspace: Workspace) {}
  begin(requestId: string): void { this.scope(requestId); }
  requestId(): string { if (this.closed || !this.active) throw new ForgePilotError('No active draft request.'); return this.active; }
  list() { this.requestId(); return { kind: 'forgepilot.drafts', checkpoint: { scope: this.active, authority: 'none', restore: 'unsupported; current metadata only, fresh source validation and approvals required' }, drafts: [...this.files.values()].map(v => ({ draftId: v.id, path: v.file.path, operation: v.file.operation, ...(v.file.operation === 'modify' ? { baseHash: v.file.baseHash, edits: v.file.edits.length } : {}) })), validation: 'Last validated when retained; use check_drafts before staging. extend_draft adds disjoint edits; draft_file with replaceDraftId replaces ALL edits. Final propose_drafts needs every requested file ID.' }; }
  invalidate(): void { if (this.active) this.retired.add(this.active); this.active = undefined; this.files.clear(); }
  close(): void { this.closed = true; this.files.clear(); this.active = undefined; this.retired.clear(); }
  private scope(requestId: string): void {
    if (this.closed || !/^[a-f0-9-]{36}$/.test(requestId)) throw new ForgePilotError('Draft request is closed or invalid.');
    if (this.active === requestId) return;
    if (this.retired.has(requestId) || this.retired.size >= 64) throw new ForgePilotError('Draft request expired; start a fresh session.');
    if (this.active) this.retired.add(this.active);
    this.active = requestId; this.files.clear();
  }
  async put(requestId: string, value: unknown, replaceDraftId?: string) {
    this.scope(requestId);
    const result = await checkFile(this.workspace, value);
    if (this.closed || this.active !== requestId) throw new ForgePilotError('Delayed draft ignored.');
    const key = result.path?.toLowerCase();
    const previous = key ? this.files.get(key) : undefined;
    if (replaceDraftId && previous?.id !== replaceDraftId) return { kind: 'forgepilot.draft', requestId, path: result.path, valid: false, code: 'STALE_DRAFT', guidance: guidance.STALE_DRAFT, retainedDraftId: previous?.id };
    if (result.valid && previous && !replaceDraftId) return { kind: 'forgepilot.draft', requestId, path: result.path, valid: false, code: 'DRAFT_EXISTS', guidance: guidance.DRAFT_EXISTS, retainedDraftId: previous.id };
    // A failed replacement cannot leave an older file draft available for final staging.
    if (key) this.files.delete(key);
    if (!result.valid) return { kind: 'forgepilot.draft', requestId, ...result };
    const file = parseBatch({ plan: 'Validated file draft', files: [value] }).files[0]!;
    const next = [...this.files.values()].map(v => v.file).concat(file);
    try { parseBatch({ plan: 'Draft budget', files: next }); }
    catch { return { kind: 'forgepilot.draft', requestId, ...diagnostic(undefined, result.path) }; }
    const id = randomUUID(); this.files.set(key!, { id, file });
    return { kind: 'forgepilot.draft', requestId, ...result, draftId: id, retainedFiles: this.files.size, approval: 'none: validation only' };
  }
  async extend(requestId: string, draftId: string, edits: unknown[]) {
    this.scope(requestId);
    const previous = [...this.files.values()].find(v => v.id === draftId);
    if (!previous) return { kind: 'forgepilot.draft', requestId, valid: false, code: 'STALE_DRAFT', guidance: guidance.STALE_DRAFT };
    if (previous.file.operation !== 'modify') return { kind: 'forgepilot.draft', requestId, path: previous.file.path, valid: false, code: 'INVALID_OPERATION', guidance: 'Only modify drafts can be extended. To revise a new file, use draft_file with replaceDraftId and complete content.', retainedDraftId: previous.id };
    return this.put(requestId, { ...previous.file, edits: [...previous.file.edits, ...edits] }, draftId);
  }
  assemble(requestId: string, plan: string, ids: string[]): BatchPatch {
    this.scope(requestId);
    if (!ids.length || new Set(ids).size !== ids.length) throw new ForgePilotError('Choose distinct current draft IDs.');
    const retained = [...this.files.values()];
    const files = ids.map(id => { const found = retained.find(v => v.id === id); if (!found) throw new ForgePilotError('Unknown, superseded or expired draft ID.'); return found.file; });
    return parseBatch({ plan, files: structuredClone(files) });
  }
  async check(requestId: string, plan: string, ids: string[]) { return checkBatch(this.workspace, this.assemble(requestId, plan, ids)); }
  async anchor(path: string, baseHash: string, oldText: string): Promise<DraftDiagnostic & { line?: number }> {
    const file = await this.workspace.readFile(path);
    try {
      if (hash(file.content) !== baseHash) throw new PatchValidationError('BASE_HASH_MISMATCH', 'Hash mismatch.');
      const at = file.content.indexOf(oldText);
      if (at < 0) throw new PatchValidationError('ANCHOR_NOT_FOUND', 'Anchor not found.');
      if (file.content.indexOf(oldText, at + 1) >= 0) throw new PatchValidationError('ANCHOR_NOT_UNIQUE', 'Anchor not unique.');
      return { path, valid: true, line: file.content.slice(0, at).split('\n').length };
    } catch (error) { return diagnostic(error, path); }
  }
}
