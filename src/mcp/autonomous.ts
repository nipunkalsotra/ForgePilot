import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ContextEngine } from '../context';
import { BatchStore, batchSchema } from '../batch';
import { DraftStore, checkBatch } from '../drafts';
import type { Workspace } from '../workspace';

export const AUTONOMOUS_TOOLS = ['discover_files', 'search_code', 'lookup_symbol', 'read_range', 'context_query', 'check_batch', 'propose_batch', 'draft_file', 'check_drafts', 'propose_drafts', 'check_anchor', 'list_drafts'];
type Run = (tool: string, fn: () => Promise<unknown>) => Promise<{ isError?: boolean; content: { type: 'text'; text: string }[] }>;
export function autonomousTools(mcp: McpServer, workspace: Workspace, run: Run, budget: number, drafts: DraftStore): void {
  const engine = new ContextEngine(workspace, budget);
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const scope = z.string().max(1024).default('.');
  mcp.registerTool('discover_files', { description: 'Discover permitted tracked and untracked paths (excluding Git-ignored paths), or bounded fallback inventory, including files beyond the legacy 200-file list. Literal filename/path filtering and pagination. Inspect nextCursor/truncated.',
    inputSchema: { query: z.string().max(200).default(''), scope, cursor: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(200).default(100) }, annotations },
  args => run('discover_files', () => engine.discover(args.query, args.scope, args.cursor, args.limit)));
  mcp.registerTool('search_code', { description: 'Case-insensitive literal keyword/identifier/reference search across the bounded full inventory, scoped by directory. Returns line locations, bounded snippets and scan/truncation evidence.',
    inputSchema: { query: z.string().min(1).max(200), scope }, annotations }, args => run('search_code', () => engine.search(args.query, args.scope)));
  mcp.registerTool('lookup_symbol', { description: 'Find named Python/JavaScript/TypeScript declarations by identifier. Heuristic structural lookup; returns exact declaration locations and source evidence.',
    inputSchema: { name: z.string().min(1).max(200), scope }, annotations }, args => run('lookup_symbol', () => engine.search(args.name, args.scope, true)));
  mcp.registerTool('read_range', { description: 'Secure paginated UTF-8 source read: 1-based start, at most 200 lines from a file up to 1 MiB. Returns full-file SHA-256 hash for baseHash, identity, line count and truncation. Proposals currently edit files up to 64 KiB.',
    inputSchema: { path: z.string().min(1).max(1024), start: z.number().int().min(1), count: z.number().int().min(1).max(200) }, annotations },
  args => run('read_range', () => workspace.readRange(args.path, args.start, args.count)));
  mcp.registerTool('context_query', { description: 'Retrieve ranked structural/lexical source context for a natural-language task without filenames. Finds implementation/test/documentation evidence, import relationships and useful snippets. Supports @file:path and @symbol:name references. Reports estimated token budget, omissions and actual reasons. Start here, then inspect chosen locations with deferred repository tools.',
    inputSchema: { query: z.string().min(1).max(16000), scope }, annotations }, args => run('context_query', () => engine.retrieve(args.query, args.scope)));
  mcp.registerTool('check_batch', { description: 'READ-ONLY preflight of a draft batch. Validates exact original anchors, hashes, paths, variant fields and overlaps. Returns per-file validation feedback so the TrueForge agent can correct its own draft before asking for staging permission. Does NOT stage, approve or apply anything. Use before propose_batch; send the same corrected payload to propose_batch only after every file passes.',
    inputSchema: { plan: z.string().min(1).max(6000), files: z.array(z.unknown()).min(1).max(12) }, annotations }, args => run('check_batch', () => checkBatch(workspace, args)));
  const retained = { plan: z.string().min(1).max(6000), draftIds: z.array(z.string().uuid()).min(1).max(12) };
  mcp.registerTool('list_drafts', { description: 'Recover current retained draft IDs and paths after context compaction without regenerating source edits. No writes or approval. Run check_drafts to revalidate their current hashes before final staging.', inputSchema: {}, annotations }, () => run('list_drafts', async () => drafts.list()));
  mcp.registerTool('draft_file', { description: 'Validate and retain ONE complete file draft in memory. No writes or approval. Replacing a draft for the same path supersedes its old ID: include all edits for that file together. Returns a short draftId or typed correction guidance. Use exact original anchors and full-file baseHash; never empty oldText. Use check_drafts then propose_drafts with IDs to avoid retransmitting patches.',
    inputSchema: { operation: z.enum(['modify', 'create']).describe('modify: replace text in an existing file using baseHash/edits. create: absent new file with content only.'), path: z.string().min(1).max(1024),
      baseHash: z.string().regex(/^[a-f0-9]{64}$/).optional().describe('For modify only: exact full-file hash returned by read_range/context_query. Never invent a hash.'),
      edits: z.array(z.object({ oldText: z.string().min(1).max(65536).describe('Exact original source anchor; one unique match, never empty.'), newText: z.string().max(65536) })).min(1).max(64).optional().describe('For modify only: all disjoint replacements for this one existing file.'),
      content: z.string().min(1).max(65536).optional().describe('For create only: complete content of an absent new file. Never combine with baseHash or edits.') },
    annotations: { ...annotations, idempotentHint: false } }, file => run('draft_file', () => drafts.put(drafts.requestId(), file)));
  mcp.registerTool('check_drafts', { description: 'Revalidate the selected retained file drafts against current workspace hashes/anchors and report independent errors. No writes, staging or permission. Send all required file IDs, including tests and documentation when requested.',
    inputSchema: retained, annotations }, args => run('check_drafts', () => drafts.check(drafts.requestId(), args.plan, args.draftIds)));
  mcp.registerTool('check_anchor', { description: 'Read-only exact original snippet validation. Reports unique match line or typed hash/anchor error without disclosing other contents. Whitespace/newlines/quotes must match; never fuzzy matches.',
    inputSchema: { path: z.string().min(1).max(1024), baseHash: z.string().regex(/^[a-f0-9]{64}$/), oldText: z.string().min(1).max(65536) }, annotations },
  args => run('check_anchor', () => drafts.anchor(args.path, args.baseHash, args.oldText)));
  mcp.registerTool('propose_drafts', { description: 'Stage ONE final complete batch assembled from previously validated draft IDs. Revalidates every file. No writes. Requires genuine TrueForge staging permission and separate developer file/hunk review and application. Finish the turn after a successful proposal response.',
    inputSchema: retained, annotations: { ...annotations, readOnlyHint: false, idempotentHint: false } }, args => run('propose_drafts', async () => {
    const patch = drafts.assemble(drafts.requestId(), args.plan, args.draftIds);
    await new BatchStore(workspace).stage(patch, true);
    return { kind: 'forgepilot.batch', patch };
  }));
  mcp.registerTool('propose_batch', { description: 'Propose ONE final batch of at most 12 existing-file replacements or explicitly reviewed new files, with a short plan. No writes. Each modify has operation=modify, path, full original baseHash, unique oldText/newText edits. Create has operation=create, path, content; parent must exist and target must not exist. Requires TrueForge staging approval, separate developer hunk review and explicit editor application.',
    inputSchema: batchSchema.shape, annotations: { ...annotations, readOnlyHint: false, idempotentHint: false } }, args => run('propose_batch', async () => {
    const store = new BatchStore(workspace); await store.stage(args, true);
    return { kind: 'forgepilot.batch', patch: args };
  }));
}
