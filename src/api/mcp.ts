/**
 * MCP pipeline API — the token-authenticated HTTP surface the MCP server calls.
 *
 * Auth: `Authorization: Bearer <mcp token>`. The token resolves to exactly one
 * founderId (see services/mcp-tokens), which scopes every call through the
 * pipeline DAL. There is no way to pass a founderId from the client — it's
 * always derived from the token, server-side. Mirrors the portal's trial gate so
 * MCP access matches what the founder can do in the UI.
 */

import { Hono } from 'hono';
import { verifyToken } from '../services/mcp-tokens.js';
import { getFounderAccess, CRM_GATE_ENFORCED } from './founder-access.js';
import {
  listInvestors, getInvestor, createInvestor, updateInvestor,
  archiveInvestor, logTouch, bulkUpsertInvestors, getPipelineSummary,
  PipelineError,
} from '../services/pipeline-dao.js';

type Variables = { founderId: number };
const app = new Hono<{ Variables: Variables }>();

// ── Auth + trial gate ────────────────────────────────────────────────────────
app.use('*', async (c, next) => {
  const header = c.req.header('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const founderId = await verifyToken(token);
  if (!founderId) return c.json({ error: 'Invalid or expired MCP token', code: 'UNAUTHORIZED' }, 401);
  c.set('founderId', founderId);

  if (CRM_GATE_ENFORCED) {
    const access = await getFounderAccess(founderId);
    if (access === 'none') return c.json({ error: 'Pipeline access requires an active MatCap trial', code: 'NO_ACCESS' }, 403);
    if (access === 'readonly' && c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      return c.json({ error: 'Your trial ended — pipeline is read-only', code: 'READ_ONLY' }, 403);
    }
  }
  await next();
});

// Convert a thrown PipelineError into a clean JSON response; rethrow others.
function fail(c: any, err: unknown) {
  if (err instanceof PipelineError) return c.json({ error: err.message, code: err.code }, err.httpStatus as any);
  console.error('[MCP] unexpected error:', err);
  return c.json({ error: 'Internal error', code: 'INTERNAL' }, 500);
}

// ── Reads ────────────────────────────────────────────────────────────────────
app.get('/investors', async (c) => {
  const founderId = c.get('founderId');
  const q = c.req.query();
  try {
    const result = await listInvestors(founderId, {
      status: q.status, source: q.source,
      kind: q.kind as any, search: q.search,
      needsAttention: q.needsAttention === 'true',
      includeArchived: q.includeArchived === 'true',
      limit: q.limit ? parseInt(q.limit) : undefined,
      offset: q.offset ? parseInt(q.offset) : undefined,
    });
    return c.json(result);
  } catch (err) { return fail(c, err); }
});

app.get('/summary', async (c) => {
  try { return c.json(await getPipelineSummary(c.get('founderId'))); }
  catch (err) { return fail(c, err); }
});

app.get('/investors/:id', async (c) => {
  try { return c.json(await getInvestor(c.get('founderId'), c.req.param('id'))); }
  catch (err) { return fail(c, err); }
});

// ── Writes ───────────────────────────────────────────────────────────────────
app.post('/investors', async (c) => {
  try { return c.json(await createInvestor(c.get('founderId'), await c.req.json()), 201); }
  catch (err) { return fail(c, err); }
});

app.post('/investors/bulk', async (c) => {
  try {
    const body = await c.req.json();
    return c.json(await bulkUpsertInvestors(c.get('founderId'), body.items ?? body));
  } catch (err) { return fail(c, err); }
});

app.patch('/investors/:id', async (c) => {
  try { return c.json(await updateInvestor(c.get('founderId'), c.req.param('id'), await c.req.json())); }
  catch (err) { return fail(c, err); }
});

app.post('/investors/:id/archive', async (c) => {
  try { return c.json(await archiveInvestor(c.get('founderId'), c.req.param('id'))); }
  catch (err) { return fail(c, err); }
});

app.post('/investors/:id/touch', async (c) => {
  try { return c.json(await logTouch(c.get('founderId'), c.req.param('id'), await c.req.json())); }
  catch (err) { return fail(c, err); }
});

export default app;
