import { Hono } from 'hono';
import { z } from 'zod';
import { eq, desc } from 'drizzle-orm';
import { db, mockCallAnalyses } from '../db/index.js';
import { analyzeMockCall } from '../services/mock-call-analyzer.js';
import { getGymStatus, setGymAllowance, resetGymRep } from '../services/gym.js';

const app = new Hono();

// Parse the JSON-in-text columns back into objects for the client.
function hydrate(row: any) {
  return {
    ...row,
    scorecard: row.scorecard ? JSON.parse(row.scorecard) : [],
    blindSpots: row.blindSpots ? JSON.parse(row.blindSpots) : [],
    coaching: row.coaching ? JSON.parse(row.coaching) : [],
  };
}

const createSchema = z.object({
  transcript: z.string().min(1, 'transcript is required'),
  founderId: z.number().int().positive().optional(),
  publicCompanyId: z.number().int().positive().optional(),
  contextOverride: z.string().optional(),
});

// Analyze a mock call transcript and store the result.
app.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    const msg = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ');
    return c.json({ error: msg }, 400);
  }
  try {
    const result = await analyzeMockCall(parsed.data);
    if (!result) return c.json({ error: 'Analyzer unavailable (ANTHROPIC_API_KEY not set)' }, 503);
    const row = await db.query.mockCallAnalyses.findFirst({ where: eq(mockCallAnalyses.id, result.id) });
    return c.json(hydrate(row), 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[mock-call-analysis] failed:', message);
    return c.json({ error: message }, 500);
  }
});

// Admin: view a founder's Gym quota (allowed / used / remaining).
app.get('/founders/:id/quota', async (c) => {
  const id = parseInt(c.req.param('id'));
  return c.json(await getGymStatus(id));
});

// Admin: set a founder's Gym allowance explicitly.
app.post('/founders/:id/quota', async (c) => {
  const id = parseInt(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));
  const n = Number(body?.repsAllowed);
  if (!Number.isFinite(n)) return c.json({ error: 'repsAllowed must be a number' }, 400);
  return c.json(await setGymAllowance(id, n));
});

// Admin: reset a founder — grant exactly one fresh rep.
app.post('/founders/:id/quota/reset', async (c) => {
  const id = parseInt(c.req.param('id'));
  return c.json(await resetGymRep(id));
});

// List recent analyses (optionally filtered by founder or company).
app.get('/', async (c) => {
  const rows = await db.select().from(mockCallAnalyses).orderBy(desc(mockCallAnalyses.id)).limit(50);
  return c.json(rows.map(hydrate));
});

// Fetch one analysis.
app.get('/:id', async (c) => {
  const id = parseInt(c.req.param('id'));
  const row = await db.query.mockCallAnalyses.findFirst({ where: eq(mockCallAnalyses.id, id) });
  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json(hydrate(row));
});

export default app;
