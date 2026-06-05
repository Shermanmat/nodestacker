#!/usr/bin/env node
/**
 * Matcap Pipeline MCP server.
 *
 * A thin, local connector: it runs inside the founder's AI client (Claude Desktop,
 * Cursor, …) and exposes their investor pipeline as MCP tools. It holds ONLY the
 * founder's MCP token — never any database credentials — and calls Matcap's
 * token-authenticated HTTPS API. All tenancy + permission enforcement lives
 * server-side (the token resolves to one founder; the pipeline DAL scopes every
 * operation). This process can't reach another founder's data even if it tried.
 *
 * Env:
 *   MATCAP_MCP_TOKEN  (required)  the founder's token, minted in the portal
 *   MATCAP_API_URL    (optional)  base URL, default https://matcap.vc
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const TOKEN = process.env.MATCAP_MCP_TOKEN;
const BASE = (process.env.MATCAP_API_URL || 'https://matcap.vc').replace(/\/$/, '');

if (!TOKEN) {
  console.error('MATCAP_MCP_TOKEN is not set. Mint one in the Matcap portal and set it in your MCP client config.');
  process.exit(1);
}

/** Call the Matcap MCP API with the founder's bearer token. */
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}/api/mcp${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data?.error ? (typeof data.error === 'string' ? data.error : JSON.stringify(data.error)) : `HTTP ${res.status}`;
    throw new Error(`${msg}${data?.code ? ` (${data.code})` : ''}`);
  }
  return data;
}

/** Standard MCP tool result: a human line + the structured JSON. */
function ok(summary, data) {
  return { content: [{ type: 'text', text: `${summary}\n\n${JSON.stringify(data, null, 2)}` }] };
}
function err(e) {
  return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
}

const server = new McpServer({ name: 'matcap-pipeline', version: '0.1.0' });

// Shared field shapes
const recordFields = {
  firm: z.string().nullish(),
  role: z.string().nullish(),
  email: z.string().nullish(),
  geography: z.string().nullish(),
  source: z.enum(['self_added', 'cold_inbound']).optional(),
  status: z.enum(['self_outreach', 'first_meeting_complete', 'follow_up_questions', 'passed', 'invested']).optional(),
  nextActionText: z.string().nullish(),
  nextActionDate: z.string().nullish().describe('ISO date, e.g. 2026-06-15'),
  checkSize: z.string().nullish(),
  notes: z.string().nullish(),
};

server.tool(
  'list_investors',
  "List the founder's investor pipeline (MatCap intros + self-added). Filter and search.",
  {
    status: z.string().optional(),
    source: z.enum(['matcap', 'self_added', 'cold_inbound']).optional(),
    kind: z.enum(['matcap_intro', 'self_record']).optional(),
    search: z.string().optional().describe('matches investor name or firm'),
    needsAttention: z.boolean().optional().describe('only items with a due/overdue next action'),
    includeArchived: z.boolean().optional(),
    limit: z.number().int().positive().optional(),
    offset: z.number().int().nonnegative().optional(),
  },
  async (args) => {
    try {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(args)) if (v !== undefined) qs.set(k, String(v));
      const data = await api(`/investors?${qs.toString()}`);
      return ok(`${data.items.length} of ${data.total} pipeline item(s).`, data);
    } catch (e) { return err(e); }
  },
);

server.tool(
  'get_investor',
  'Get one pipeline item by its id (e.g. "self_record:42" or "matcap_intro:7").',
  { id: z.string() },
  async ({ id }) => {
    try { return ok('Pipeline item:', await api(`/investors/${encodeURIComponent(id)}`)); }
    catch (e) { return err(e); }
  },
);

server.tool(
  'create_investor',
  'Add a self-managed pipeline record (a MatCap intro cannot be created here).',
  { name: z.string(), ...recordFields },
  async (args) => {
    try { return ok('Created pipeline record:', await api('/investors', { method: 'POST', body: args })); }
    catch (e) { return err(e); }
  },
);

server.tool(
  'update_investor',
  'Update a pipeline item by id. For a MatCap intro, only nextActionText/nextActionDate/checkSize/notes are allowed.',
  { id: z.string(), name: z.string().optional(), ...recordFields },
  async ({ id, ...patch }) => {
    try { return ok('Updated pipeline item:', await api(`/investors/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch })); }
    catch (e) { return err(e); }
  },
);

server.tool(
  'archive_investor',
  'Archive (soft-delete, reversible) a self-managed record. MatCap intros cannot be archived.',
  { id: z.string() },
  async ({ id }) => {
    try { return ok('Archived.', await api(`/investors/${encodeURIComponent(id)}/archive`, { method: 'POST', body: {} })); }
    catch (e) { return err(e); }
  },
);

server.tool(
  'log_touch',
  'Record an interaction (last touch) on a pipeline item. Optionally advance a self-record status.',
  {
    id: z.string(),
    interactionType: z.enum(['meeting', 'email', 'call', 'note', 'intro_sent']),
    occurredAt: z.string().nullish().describe('ISO timestamp; defaults to now'),
    content: z.string().nullish(),
    advanceStatusTo: z.enum(['self_outreach', 'first_meeting_complete', 'follow_up_questions', 'passed', 'invested']).optional().describe('self-records only'),
  },
  async ({ id, ...body }) => {
    try { return ok('Logged interaction.', await api(`/investors/${encodeURIComponent(id)}/touch`, { method: 'POST', body })); }
    catch (e) { return err(e); }
  },
);

server.tool(
  'bulk_upsert_investors',
  'Idempotently create/update many self-managed records. Natural key is name+firm, so re-running makes no duplicates.',
  { items: z.array(z.object({ name: z.string(), ...recordFields })).min(1) },
  async ({ items }) => {
    try { return ok('Bulk upsert complete.', await api('/investors/bulk', { method: 'POST', body: { items } })); }
    catch (e) { return err(e); }
  },
);

server.tool(
  'get_pipeline_summary',
  'Counts by stage for the dashboard: total, active, needs-follow-up, self-added, closed, and by status.',
  {},
  async () => {
    try { return ok('Pipeline summary:', await api('/summary')); }
    catch (e) { return err(e); }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`matcap-pipeline MCP server connected (API: ${BASE})`);
