/**
 * Remote MCP server — the hosted Streamable-HTTP endpoint founders connect their
 * AI client to (no local files to install).
 *
 *   Cursor:          { "url": "https://matcap.vc/mcp", "headers": { "Authorization": "Bearer mcp_…" } }
 *   Claude Desktop:  npx mcp-remote https://matcap.vc/mcp --header "Authorization: Bearer mcp_…"
 *
 * Auth is a header token (Authorization: Bearer <mcp token>) resolved to a single
 * founderId; every tool runs scoped to that founder through the pipeline DAL —
 * the same tenancy chokepoint the rest of the app uses. Stateless transport: a
 * fresh server is built per request (tools-only, no server-initiated streams),
 * which keeps this trivially horizontally-scalable and session-free.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import { verifyToken } from '../services/mcp-tokens.js';
import { getFounderAccess, CRM_GATE_ENFORCED } from './founder-access.js';
import {
  listInvestors, getInvestor, createInvestor, updateInvestor,
  archiveInvestor, logTouch, bulkUpsertInvestors, getPipelineSummary,
} from '../services/pipeline-dao.js';

type Bindings = { incoming: IncomingMessage; outgoing: ServerResponse };
const app = new Hono<{ Bindings: Bindings }>();

const SOURCE = z.enum(['self_added', 'cold_inbound']);
const SELF_STATUS = z.enum(['self_outreach', 'first_meeting_complete', 'follow_up_questions', 'passed', 'invested']);
const recordShape = {
  firm: z.string().nullish(), role: z.string().nullish(), email: z.string().nullish(),
  geography: z.string().nullish(), source: SOURCE.optional(), status: SELF_STATUS.optional(),
  nextActionText: z.string().nullish(), nextActionDate: z.string().nullish(),
  checkSize: z.string().nullish(), notes: z.string().nullish(),
};

function text(data: unknown) {
  return { content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] };
}
function errResult(e: unknown) {
  return { content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
}
const wrap = (fn: () => Promise<unknown>) => fn().then(text).catch(errResult);
function denyWrite() {
  return errResult(new Error('Your pipeline is read-only right now (trial ended). This action is not allowed.'));
}

/** Build a per-founder MCP server. `canWrite` reflects the trial gate. */
function buildServer(founderId: number, canWrite: boolean): McpServer {
  const server = new McpServer({ name: 'matcap-pipeline', version: '0.1.0' });

  server.tool('list_investors',
    "List the founder's investor pipeline (MatCap intros + self-added). Filter and search.",
    {
      status: z.string().optional(),
      source: z.enum(['matcap', 'self_added', 'cold_inbound']).optional(),
      kind: z.enum(['matcap_intro', 'self_record']).optional(),
      search: z.string().optional(),
      needsAttention: z.boolean().optional(),
      includeArchived: z.boolean().optional(),
      limit: z.number().int().positive().optional(),
      offset: z.number().int().nonnegative().optional(),
    },
    (args) => wrap(() => listInvestors(founderId, args as any)));

  server.tool('get_investor',
    'Get one pipeline item by its id (e.g. "self_record:42" or "matcap_intro:7").',
    { id: z.string() },
    ({ id }) => wrap(() => getInvestor(founderId, id)));

  server.tool('get_pipeline_summary',
    'Counts by stage: total, active, needs-follow-up, self-added, closed, and by status.',
    {},
    () => wrap(() => getPipelineSummary(founderId)));

  server.tool('create_investor',
    'Add a self-managed pipeline record (a MatCap intro cannot be created here).',
    { name: z.string(), ...recordShape },
    (args) => canWrite ? wrap(() => createInvestor(founderId, args as any)) : Promise.resolve(denyWrite()));

  server.tool('update_investor',
    'Update a pipeline item by id. For a MatCap intro, only nextActionText/nextActionDate/checkSize/notes are allowed.',
    { id: z.string(), name: z.string().optional(), ...recordShape },
    ({ id, ...patch }) => canWrite ? wrap(() => updateInvestor(founderId, id, patch as any)) : Promise.resolve(denyWrite()));

  server.tool('archive_investor',
    'Archive (soft-delete, reversible) a self-managed record. MatCap intros cannot be archived.',
    { id: z.string() },
    ({ id }) => canWrite ? wrap(() => archiveInvestor(founderId, id)) : Promise.resolve(denyWrite()));

  server.tool('log_touch',
    'Record an interaction on a pipeline item. Optionally advance a self-record status.',
    {
      id: z.string(),
      interactionType: z.enum(['meeting', 'email', 'call', 'note', 'intro_sent']),
      occurredAt: z.string().nullish(),
      content: z.string().nullish(),
      advanceStatusTo: SELF_STATUS.optional(),
    },
    ({ id, ...body }) => canWrite ? wrap(() => logTouch(founderId, id, body as any)) : Promise.resolve(denyWrite()));

  server.tool('bulk_upsert_investors',
    'Idempotently create/update many self-managed records. Natural key is name+firm, so re-running makes no duplicates.',
    { items: z.array(z.object({ name: z.string(), ...recordShape })).min(1) },
    ({ items }) => canWrite ? wrap(() => bulkUpsertInvestors(founderId, items as any)) : Promise.resolve(denyWrite()));

  return server;
}

// POST /mcp — the Streamable HTTP endpoint. (GET/DELETE session ops aren't used
// in stateless mode; clients only POST JSON-RPC.)
app.post('/', async (c) => {
  const header = c.req.header('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const founderId = await verifyToken(token);
  if (!founderId) return c.json({ error: 'Invalid or expired MCP token' }, 401);

  let canWrite = true;
  if (CRM_GATE_ENFORCED) {
    const access = await getFounderAccess(founderId);
    if (access === 'none') return c.json({ error: 'Pipeline access requires an active MatCap trial' }, 403);
    canWrite = access !== 'readonly';
  }

  const body = await c.req.json().catch(() => undefined);
  const server = buildServer(founderId, canWrite);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  c.env.outgoing.on('close', () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(c.env.incoming, c.env.outgoing, body);
  return RESPONSE_ALREADY_SENT;
});

export default app;
