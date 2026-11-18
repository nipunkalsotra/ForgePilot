import { createServer, type Server } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { autonomousTools } from './autonomous';
import { patchSchema, renderPatch } from '../patch';
import { LIMITS, Workspace } from '../workspace';
import { ForgePilotError, publicError, type Logger } from '../log';

function toolServer(workspace: Workspace, log: Logger, proposals: boolean, autonomous: boolean, contextBudget: number, pace: () => Promise<void>): McpServer {
  const mcp = new McpServer({ name: 'forgepilot-workspace', version: '0.1.0' });
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const run = async (tool: string, fn: () => Promise<unknown>) => {
    const start = Date.now();
    try {
      const text = JSON.stringify(await fn());
      if (Buffer.byteLength(text) > LIMITS.outputBytes) throw new ForgePilotError('Tool output exceeds the 96 KiB response budget. Use a narrower path or search.');
      await pace();
      log('tool.completed', { tool, durationMs: Date.now() - start, bytes: Buffer.byteLength(text) });
      return { content: [{ type: 'text' as const, text }] };
    } catch (error) {
      await pace();
      log('tool.failed', { tool, durationMs: Date.now() - start });
      return { isError: true, content: [{ type: 'text' as const, text: publicError(error) }] };
    }
  };
  mcp.registerTool('list_files', {
    description: 'List up to 200 permitted workspace files recursively. Excludes hidden, sensitive, generated and symlink paths. Check truncated.',
    inputSchema: { path: z.string().max(1024).default('.') }, annotations,
  }, ({ path }) => run('list_files', () => workspace.listFiles(path)));
  mcp.registerTool('read_file', {
    description: 'Read one permitted workspace-relative UTF-8 text file, maximum 64 KiB. Read-only; no absolute paths, hidden files, secrets or symlinks.',
    inputSchema: { path: z.string().min(1).max(1024) }, annotations,
  }, ({ path }) => run('read_file', async () => { const file = await workspace.readFile(path); return { path: file.path, content: file.content, bytes: file.bytes }; }));
  mcp.registerTool('search_workspace', {
    description: 'Case-sensitive literal text search in permitted workspace files. Returns at most 100 matches with 1-based line numbers. Check truncated and skippedFiles.',
    inputSchema: { query: z.string().min(1).max(200), path: z.string().max(1024).default('.') }, annotations,
  }, ({ query, path }) => run('search_workspace', () => workspace.search(query, path)));
  if (proposals) mcp.registerTool('propose_patch', {
    description: 'Propose bounded replacements in an existing file. Never writes files. Requires explicit TrueForge tool approval before staging, followed by separate editor hunk approval. oldText must match uniquely; baseHash is SHA-256 of original content.',
    inputSchema: patchSchema.shape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, args => run('propose_patch', async () => {
    const file = await workspace.readFile(args.path);
    renderPatch(file.content, args);
    return { kind: 'forgepilot.patch', patch: args };
  }));
  if (autonomous) autonomousTools(mcp, workspace, run, contextBudget);
  return mcp;
}

export interface RunningServer { url: string; close(): Promise<void> }

export async function startServer(root: string, token: string, log: Logger, proposals = false, autonomous = false, contextBudget = 12000, toolIntervalMs = 0): Promise<RunningServer> {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Expected a 256-bit random MCP token');
  if (!Number.isSafeInteger(toolIntervalMs) || toolIntervalMs < 0 || toolIntervalMs > 10000) throw new ForgePilotError('Invalid tool response interval.');
  const workspace = await Workspace.create(root);
  const pacing = new AbortController();
  let ready = Promise.resolve();
  const pace = () => {
    if (!autonomous || !toolIntervalMs) return Promise.resolve();
    const next = ready.catch(() => {}).then(() => delay(toolIntervalMs, undefined, { signal: pacing.signal }));
    ready = next; return next;
  };
  let active = 0;
  const transports = new Set<StreamableHTTPServerTransport>();
  const http: Server = createServer((req, res) => {
    const handle = async () => {
      const address = http.address();
      if (typeof address !== 'object' || !address) { res.writeHead(503).end(); return; }
      if (req.headers.host !== `127.0.0.1:${address.port}` || req.headers.origin) { res.writeHead(403).end(); return; }
      const provided = Buffer.from(req.headers.authorization ?? '');
      const expected = Buffer.from(`Bearer ${token}`);
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) { res.writeHead(401).end(); return; }
      if (req.url !== '/mcp') { res.writeHead(404).end(); return; }
      // Stateless Streamable HTTP: no long-lived GET stream or DELETE sessions.
      if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }).end(); return; }
      if (active >= 8) { res.writeHead(429).end(); return; }
      active++;
      const mcp = toolServer(workspace, log, proposals, autonomous, contextBudget, pace);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      transports.add(transport);
      res.once('close', () => { void transport.close(); });
      try {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
          size += buffer.length;
          if (size > (autonomous ? 1024 * 1024 : proposals ? 256 * 1024 : 16 * 1024)) { res.writeHead(413).end(); return; }
          chunks.push(buffer);
        }
        let body: unknown;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { res.writeHead(400).end(); return; }
        await mcp.connect(transport);
        await transport.handleRequest(req, res, body);
      } finally {
        active--;
        transports.delete(transport);
        await mcp.close();
      }
    };
    void handle().catch(() => {
      log('http.failed');
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  http.requestTimeout = autonomous ? 15000 : 5000;
  http.headersTimeout = 5000;
  http.timeout = autonomous ? Math.max(15000, toolIntervalMs * 10 + 10000) : 5000;
  http.maxConnections = 16;
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', () => { http.removeListener('error', reject); resolve(); });
  });
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('MCP server did not bind');
  log('mcp.listening', { port: address.port });
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    async close() {
      pacing.abort(); workspace.dispose();
      await Promise.allSettled([...transports].map(t => t.close()));
      await new Promise<void>(resolve => { http.close(() => resolve()); http.closeAllConnections(); });
      log('mcp.closed');
    },
  };
}
