import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PatchStore, patchSchema, diffHunks, hash, type Hunk, type ProposalStatus } from './patch';
import { Workspace } from './workspace';
import { ForgePilotError } from './log';

const modify = patchSchema.extend({ operation: z.literal('modify') });
const create = z.strictObject({ operation: z.literal('create'), path: z.string().min(1).max(1024), content: z.string().min(1).max(65536) });
const validatedBatchSchema = z.strictObject({ plan: z.string().min(1).max(6000), files: z.array(z.discriminatedUnion('operation', [modify, create])).min(1).max(12) });
export type BatchPatch = z.infer<typeof validatedBatchSchema>;
// A flat advertised schema avoids provider-specific anyOf/discriminator handling.
// Both transport validation and the domain parser still enforce the exact variants.
const advertisedFile = z.strictObject({
  operation: z.enum(['modify', 'create']).describe('REQUIRED: modify for existing files; create only for a new file.'),
  path: z.string().min(1).max(1024),
  baseHash: patchSchema.shape.baseHash.optional().describe('Required for modify: original full-file SHA-256 from read_range/context_query.'),
  edits: patchSchema.shape.edits.optional().describe('Required for modify: all replacements for this path. No empty oldText; include an existing unique anchor for insertions.'),
  content: z.string().min(1).max(65536).optional().describe('Only for create: entire content of a new file.'),
}).superRefine((value, context) => {
  const valid = value.operation === 'modify' ? modify.safeParse(value) : create.safeParse(value);
  if (!valid.success) context.addIssue({ code: 'custom', message: 'Modify requires baseHash and edits only; create requires content only.' });
});
export const batchSchema = z.strictObject({ plan: z.string().min(1).max(6000), files: z.array(advertisedFile).min(1).max(12) });
export function parseBatch(value: unknown): BatchPatch {
  const result = validatedBatchSchema.safeParse(value);
  if (!result.success || Buffer.byteLength(JSON.stringify(value)) > 90000) throw new ForgePilotError('Malformed or oversized patch batch. Use at most 12 bounded file proposals.');
  const paths = result.data.files.map(f => f.path.toLowerCase());
  if (new Set(paths).size !== paths.length) throw new ForgePilotError('Duplicate batch target paths are forbidden.');
  return result.data;
}
export interface DocumentBaseline { content: string; version: number }
export interface BatchFile {
  id: string; path: string; operation: 'modify' | 'create'; before: string; proposed: string;
  version: number; baseHash: string; identity: string; hunks: Hunk[]; status: ProposalStatus; conflict?: string;
}
export interface BatchProposal { id: string; plan: string; files: BatchFile[]; status: ProposalStatus; toolApproved: boolean; generationSucceeded: boolean }
export class BatchStore {
  private proposal?: BatchProposal;
  private cancelled = false;
  constructor(readonly workspace: Workspace, private readonly baseline?: (path: string, operation: 'modify' | 'create') => Promise<DocumentBaseline>) {}
  get current(): BatchProposal | undefined { return this.proposal ? structuredClone(this.proposal) : undefined; }
  fork(): BatchStore { return new BatchStore(this.workspace, this.baseline); }
  cancel(): void { this.cancelled = true; if (this.proposal?.status === 'staged') { this.proposal.status = 'cancelled'; for (const file of this.proposal.files) if (file.status === 'staged') file.status = 'cancelled'; } }
  private live(): void { if (this.cancelled) throw new ForgePilotError('Batch request is cancelled.'); }
  async stage(value: unknown, toolApproved: boolean): Promise<BatchProposal> {
    this.live(); if (this.proposal || !toolApproved) throw new ForgePilotError('Batch requires genuine tool approval and may only be staged once.');
    const patch = parseBatch(value), files: BatchFile[] = [];
    for (const input of patch.files) {
      this.live();
      if (input.operation === 'create') {
        if (Buffer.byteLength(input.content) > 65536 || input.content.includes('\0')) throw new ForgePilotError('New file exceeds the text budget.');
        const location = await this.workspace.creationPath(input.path);
        const state = await this.baseline?.(input.path, 'create');
        if (state?.content || state && state.version !== 0) throw new ForgePilotError('New-file target has an existing editor buffer.');
        files.push({ id: randomUUID(), path: input.path, operation: 'create', status: 'staged', before: '', proposed: input.content, version: 0,
          baseHash: hash(''), identity: location.parentIdentity, hunks: diffHunks('', input.content) });
      } else {
        const disk = await this.workspace.readFile(input.path);
        const state = await this.baseline?.(input.path, 'modify') ?? { content: disk.content, version: 1 };
        const store = new PatchStore(this.workspace, { path: input.path, ...state, start: 0, end: state.content.length });
        const { operation: _operation, ...patch } = input;
        const p = await store.stage(patch, toolApproved);
        files.push({ id: p.id, path: input.path, operation: 'modify', status: 'staged', before: state.content, proposed: p.proposed, version: state.version,
          baseHash: p.originalHash, identity: disk.identity, hunks: p.hunks });
        void _operation;
      }
    }
    this.live(); if (this.proposal) throw new ForgePilotError('A batch was already staged.');
    this.proposal = { id: randomUUID(), plan: patch.plan, files, status: 'staged', toolApproved, generationSucceeded: false };
    return this.current!;
  }
  complete(): void { this.live(); if (!this.proposal || this.proposal.status !== 'staged') throw new ForgePilotError('No successful batch to complete.'); this.proposal.generationSucceeded = true; }
  private require(): BatchProposal {
    this.live();
    if (!this.proposal || this.proposal.status !== 'staged' || !this.proposal.generationSucceeded || !this.proposal.toolApproved) throw new ForgePilotError('Batch is incomplete or no longer reviewable.');
    return this.proposal;
  }
  review(decision: 'accepted' | 'rejected', fileId?: string, hunkId?: string, remaining = false): void {
    const p = this.require(), files = fileId ? p.files.filter(f => f.id === fileId) : p.files;
    if (!files.length) throw new ForgePilotError('Unknown batch file.');
    let matched = 0;
    for (const file of files) {
      if (file.status !== 'staged') { if (fileId) throw new ForgePilotError('File proposal is no longer reviewable.'); continue; }
      for (const h of file.hunks) if ((!hunkId || h.id === hunkId) && (!remaining || h.decision === 'pending')) { h.decision = decision; matched++; }
      if (file.hunks.every(h => h.decision === 'rejected')) file.status = 'rejected';
    }
    if (!matched && !remaining) throw new ForgePilotError('Unknown batch hunk.');
    if (p.files.every(f => f.hunks.every(h => h.decision === 'rejected'))) p.status = 'rejected';
  }
  accepted(): { file: BatchFile; content: string }[] {
    const p = this.require();
    if (p.files.some(f => f.hunks.some(h => h.decision === 'pending'))) throw new ForgePilotError('Review every hunk in every file before applying.');
    return p.files.filter(f => f.hunks.some(h => h.decision === 'accepted')).map(file => ({ file: structuredClone(file), content: this.render(file) }));
  }
  render(file: BatchFile, includePending = false): string {
    let content = file.before;
    for (const h of [...file.hunks].reverse()) if (h.decision === 'accepted' || includePending && h.decision === 'pending') content = content.slice(0, h.start) + h.newText + content.slice(h.end);
    return content;
  }
  async validate(states: Map<string, DocumentBaseline>): Promise<void> {
    const p = this.require();
    try {
      for (const file of p.files) {
        const state = states.get(file.path);
        if (file.operation === 'create') {
          const location = await this.workspace.creationPath(file.path);
          if (location.parentIdentity !== file.identity || state && (state.version !== 0 || state.content !== '')) throw new ForgePilotError('New-file target changed.');
        } else {
          const disk = await this.workspace.readFile(file.path);
          if (disk.identity !== file.identity || hash(disk.content) !== file.baseHash) throw new ForgePilotError('External file conflict.');
          if (!state || state.version !== file.version || hash(state.content) !== file.baseHash) throw new ForgePilotError('Stale document conflict.');
        }
      }
      this.require();
    } catch (error) {
      for (const file of p.files) { file.conflict = 'Batch validation failed; generate a new proposal.'; file.status = 'failed'; }
      p.status = 'failed'; throw error;
    }
  }
  beginApply(): void { const p = this.require(); p.status = 'applying'; for (const file of p.files) if (file.status === 'staged') file.status = 'applying'; }
  finishApply(success: boolean): void { if (this.proposal?.status === 'applying') { this.proposal.status = success ? 'applied' : 'failed'; for (const file of this.proposal.files) if (file.status === 'applying') file.status = this.proposal.status; } }
}
