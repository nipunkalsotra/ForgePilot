import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ContextEngine } from '../context';
import { BatchStore, batchSchema, parseBatch } from '../batch';
import type { Workspace } from '../workspace';
import { publicError } from '../log';

export const AUTONOMOUS_TOOLS = ['discover_files', 'search_code', 'lookup_symbol', 'read_range', 'context_query', 'check_batch', 'propose_batch'];
type Run = (tool: string, fn: () => Promise<unknown>) => Promise<{ isError?: boolean; content: { type: 'text'; text: string }[] }>;
export function autonomousTools(mcp: McpServer, workspace: Workspace, run: Run, budget: number): void {
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
    inputSchema: batchSchema.shape, annotations }, args => run('check_batch', async () => {
    const patch = parseBatch(args), files: { path: string; valid: boolean; error?: string }[] = [];
    for (const file of patch.files) {
      try { await new BatchStore(workspace).stage({ plan: patch.plan, files: [file] }, true); files.push({ path: file.path, valid: true }); }
      catch (error) {
        const escaping = file.operation === 'modify' && file.edits.some(e => e.oldText.includes('\\"'))
          ? ' Check literal backslash-quote sequences: oldText must match decoded source, not JSON-escaped source. Read the exact short anchor again.' : '';
        files.push({ path: file.path, valid: false, error: publicError(error) + escaping });
      }
    }
    return { kind: 'forgepilot.check', valid: files.every(f => f.valid), files, approval: 'none: validation only' };
  }));
  mcp.registerTool('propose_batch', { description: 'Propose ONE final batch of at most 12 existing-file replacements or explicitly reviewed new files, with a short plan. No writes. Each modify has operation=modify, path, full original baseHash, unique oldText/newText edits. Create has operation=create, path, content; parent must exist and target must not exist. Requires TrueForge staging approval, separate developer hunk review and explicit editor application.',
    inputSchema: batchSchema.shape, annotations: { ...annotations, readOnlyHint: false, idempotentHint: false } }, args => run('propose_batch', async () => {
    const store = new BatchStore(workspace); await store.stage(args, true);
    return { kind: 'forgepilot.batch', patch: args };
  }));
}
