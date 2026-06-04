/**
 * Agent actions API — admin review surface for the AI worker's ledger.
 * Mounted admin-only. Lets Mat see what the agent has done/proposed, approve or
 * reject proposals, and glance at the scorecard.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import {
  listActions,
  getAction,
  decideAction,
  getScorecard,
  type ActionStatus,
} from '../services/agent-actions.js';

const app = new Hono();

const STATUSES: ActionStatus[] = ['logged', 'proposed', 'approved', 'rejected', 'executed', 'failed'];

// GET /api/agent-actions?status=proposed&agent=match-generator&limit=100
app.get('/', async (c) => {
  const status = c.req.query('status') as ActionStatus | undefined;
  const agent = c.req.query('agent') || undefined;
  const limitRaw = c.req.query('limit');
  const limit = limitRaw ? Math.min(parseInt(limitRaw) || 100, 500) : 100;

  if (status && !STATUSES.includes(status)) {
    return c.json({ error: `Invalid status. One of: ${STATUSES.join(', ')}` }, 400);
  }

  const actions = await listActions({ status, agent, limit });
  return c.json(actions);
});

// GET /api/agent-actions/scorecard — coarse health stats
app.get('/scorecard', async (c) => {
  return c.json(await getScorecard());
});

// GET /api/agent-actions/:id
app.get('/:id', async (c) => {
  const action = await getAction(parseInt(c.req.param('id')));
  if (!action) return c.json({ error: 'Not found' }, 404);
  return c.json(action);
});

const decideSchema = z.object({
  decidedBy: z.string().optional(),
});

// POST /api/agent-actions/:id/approve — approve (and execute if a handler exists)
app.post('/:id/approve', async (c) => {
  const id = parseInt(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));
  const parsed = decideSchema.safeParse(body);
  const decidedBy = (parsed.success && parsed.data.decidedBy) || 'admin';
  try {
    const action = await decideAction(id, 'approve', decidedBy);
    return c.json(action);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to approve' }, 400);
  }
});

// POST /api/agent-actions/:id/reject
app.post('/:id/reject', async (c) => {
  const id = parseInt(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));
  const parsed = decideSchema.safeParse(body);
  const decidedBy = (parsed.success && parsed.data.decidedBy) || 'admin';
  try {
    const action = await decideAction(id, 'reject', decidedBy);
    return c.json(action);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to reject' }, 400);
  }
});

export default app;
