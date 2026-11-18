import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { LIMITS, Workspace } from './workspace';
import { ForgePilotError } from './log';

export const patchSchema = z.strictObject({
  path: z.string().min(1).max(1024), baseHash: z.string().regex(/^[a-f0-9]{64}$/),
  edits: z.array(z.strictObject({ oldText: z.string().min(1).max(LIMITS.fileBytes).describe('Exact non-empty original text, unique in the target. For an insertion, use an existing unique anchor and include it unchanged in newText; never use an empty oldText.'), newText: z.string().max(LIMITS.fileBytes) })).min(1).max(64),
});
export type Patch = z.infer<typeof patchSchema>;
export const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const fail = (message: string): never => { throw new ForgePilotError(message); };
export class PatchValidationError extends ForgePilotError {
  constructor(readonly code: 'BASE_HASH_MISMATCH' | 'ANCHOR_NOT_FOUND' | 'ANCHOR_NOT_UNIQUE' | 'OVERLAPPING_EDITS', message: string, readonly editIndex?: number) { super(message); }
}
export function parseJson(text: string): unknown {
  if (Buffer.byteLength(text) > 256 * 1024) fail('Model output exceeds the patch budget.');
  try { return JSON.parse(text); } catch { return fail('Malformed model output: expected structured patch JSON.'); }
}
export function parsePatch(value: unknown): Patch {
  const result = patchSchema.safeParse(value);
  return result.success ? result.data : fail('Malformed patch proposal. Expected path, baseHash and bounded oldText/newText edits.');
}
export interface Snapshot { path: string; version: number; content: string; start: number; end: number }
export function captureSelection(input: Snapshot): Snapshot {
  if (!Number.isSafeInteger(input.version) || input.version < 1 || !Number.isSafeInteger(input.start) || !Number.isSafeInteger(input.end)
    || input.start < 0 || input.end > input.content.length || input.start >= input.end || !input.content.slice(input.start, input.end).trim()) fail('Select a non-empty region of code first.');
  if (Buffer.byteLength(input.content) > LIMITS.fileBytes || input.content.includes('\0')) fail('Inline editing requires a UTF-8 text document up to 64 KiB.');
  return { ...input };
}
export function renderPatch(original: string, patch: Patch, start = 0, end = original.length): string {
  if (hash(original) !== patch.baseHash) throw new PatchValidationError('BASE_HASH_MISMATCH', 'Patch base hash does not match the original document.');
  const edits = patch.edits.map((edit, index) => {
    const selected = original.slice(start, end);
    const offset = selected.indexOf(edit.oldText);
    if (offset < 0) throw new PatchValidationError('ANCHOR_NOT_FOUND', 'Patch text must match uniquely inside the selection: original anchor not found.', index);
    if (selected.indexOf(edit.oldText, offset + 1) !== -1) throw new PatchValidationError('ANCHOR_NOT_UNIQUE', 'Patch text must match uniquely inside the selection: anchor has multiple matches.', index);
    const at = start + offset;
    return { ...edit, start: at, end: at + edit.oldText.length };
  }).sort((a, b) => a.start - b.start);
  for (let i = 1; i < edits.length; i++) if (edits[i]!.start < edits[i - 1]!.end) throw new PatchValidationError('OVERLAPPING_EDITS', 'Overlapping edits are forbidden.');
  let result = original;
  for (const edit of edits.reverse()) result = result.slice(0, edit.start) + edit.newText + result.slice(edit.end);
  if (Buffer.byteLength(result) > LIMITS.fileBytes || result.includes('\0')) fail('Proposed content exceeds the text budget.');
  return result;
}
export interface Hunk { id: string; start: number; end: number; newText: string; line: number; decision: 'pending' | 'accepted' | 'rejected' }
/** Bounded line LCS; unchanged lines separate independently reviewable hunks. Preserve CRLF and EOF. */
export function diffHunks(before: string, after: string): Hunk[] {
  const lines = (s: string) => s.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const a = lines(before), b = lines(after), width = b.length + 1;
  if ((a.length + 1) * width > 4_000_000) fail('Diff is too large to review safely. Select a smaller file.');
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--)
    table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
  const hunks: Hunk[] = [];
  let i = 0, j = 0, offset = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { offset += a[i++]!.length; j++; continue; }
    const start = offset, line = i;
    let newText = '';
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) break;
      if (j < b.length && (i === a.length || table[i * width + j + 1]! > table[(i + 1) * width + j]!)) newText += b[j++]!;
      else offset += a[i++]!.length;
    }
    hunks.push({ id: randomUUID(), start, end: offset, newText, line, decision: 'pending' });
  }
  return hunks;
}
export type ProposalStatus = 'staged' | 'cancelled' | 'rejected' | 'applying' | 'applied' | 'failed';
export interface Proposal {
  id: string; snapshot: Snapshot; originalHash: string; diskHash: string; patch: Patch; proposed: string;
  hunks: Hunk[]; status: ProposalStatus; toolApproved: boolean;
}
export class PatchStore {
  private cancelled = false;
  private proposal?: Proposal;
  constructor(readonly workspace: Workspace, readonly snapshot: Snapshot) { this.snapshot = captureSelection(snapshot); }
  get current(): Proposal | undefined { return this.proposal ? structuredClone(this.proposal) : undefined; }
  cancel(): void { this.cancelled = true; if (this.proposal?.status === 'staged') this.proposal.status = 'cancelled'; }
  async stage(value: unknown, toolApproved: boolean): Promise<Proposal> {
    if (this.cancelled || this.proposal) fail('This request is cancelled or already has a proposal.');
    const patch = parsePatch(value);
    if (!toolApproved || patch.path !== this.snapshot.path) fail('The proposal needs TrueForge tool approval and must target the selected file.');
    const disk = await this.workspace.readFile(patch.path);
    if (this.cancelled || this.proposal) fail('Late proposal ignored.');
    if (disk.content !== this.snapshot.content) fail('File changed externally or has unsaved edits. Save and select again.');
    const proposed = renderPatch(this.snapshot.content, patch, this.snapshot.start, this.snapshot.end);
    const hunks = diffHunks(this.snapshot.content, proposed);
    if (!hunks.length) fail('The agent proposed no changes.');
    this.proposal = { id: randomUUID(), snapshot: { ...this.snapshot }, originalHash: hash(this.snapshot.content), diskHash: hash(disk.content), patch,
      proposed, hunks, status: 'staged', toolApproved };
    return this.current!;
  }
  review(id: string, decision: 'accepted' | 'rejected', hunkId?: string): void {
    const p = this.require(id);
    const hunks = hunkId ? p.hunks.filter(h => h.id === hunkId) : p.hunks;
    if (!hunks.length) fail('Unknown hunk.');
    for (const h of hunks) h.decision = decision;
    if (p.hunks.every(h => h.decision === 'rejected')) p.status = 'rejected';
  }
  private require(id: string): Proposal {
    const p = this.proposal;
    if (this.cancelled || !p || p.id !== id || p.status !== 'staged') fail('Proposal is no longer reviewable.');
    return p!;
  }
  accepted(id: string): string {
    const p = this.require(id);
    if (!p.toolApproved || p.hunks.some(h => h.decision === 'pending')) fail('Review every hunk before applying.');
    let text = p.snapshot.content;
    for (const h of [...p.hunks].reverse()) if (h.decision === 'accepted') text = text.slice(0, h.start) + h.newText + text.slice(h.end);
    return text;
  }
  async validate(id: string, document: { content: string; version: number }): Promise<void> {
    const p = this.require(id);
    if (document.version !== p.snapshot.version || hash(document.content) !== p.originalHash) fail('Stale document. Generate a new proposal.');
    const disk = await this.workspace.readFile(p.snapshot.path);
    this.require(id);
    if (hash(disk.content) !== p.diskHash) fail('File changed externally. Generate a new proposal.');
  }
  beginApply(id: string): void { this.require(id).status = 'applying'; }
  finishApply(success: boolean): void { if (this.proposal?.status === 'applying') this.proposal.status = success ? 'applied' : 'failed'; }
}
