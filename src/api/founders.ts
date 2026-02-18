import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, founders, founderNodeRelationships, nodes } from '../db/index.js';
import { z } from 'zod';

const app = new Hono();

const createFounderSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  companyName: z.string().min(1),
  companyStage: z.enum(['idea', 'pre_seed', 'seed', 'series_a']),
  roundStatus: z.enum(['pre_round', 'round_open', 'round_closed']).optional(),
});

const updateFounderSchema = createFounderSchema.partial();

// List all founders
app.get('/', async (c) => {
  const allFounders = await db.select().from(founders);
  return c.json(allFounders);
});

// Get single founder with relationships
app.get('/:id', async (c) => {
  const id = parseInt(c.req.param('id'));
  const founder = await db.query.founders.findFirst({
    where: eq(founders.id, id),
    with: {
      nodeRelationships: {
        with: {
          node: true,
        },
      },
      introRequests: {
        with: {
          node: true,
          investor: true,
        },
      },
    },
  });

  if (!founder) {
    return c.json({ error: 'Founder not found' }, 404);
  }
  return c.json(founder);
});

// Create founder
app.post('/', async (c) => {
  const body = await c.req.json();
  const parsed = createFounderSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: parsed.error.issues }, 400);
  }

  const now = new Date().toISOString();
  const result = await db.insert(founders).values({
    ...parsed.data,
    createdAt: now,
  }).returning();

  return c.json(result[0], 201);
});

// Update founder
app.put('/:id', async (c) => {
  const id = parseInt(c.req.param('id'));
  const body = await c.req.json();
  const parsed = updateFounderSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: parsed.error.issues }, 400);
  }

  const result = await db.update(founders)
    .set(parsed.data)
    .where(eq(founders.id, id))
    .returning();

  if (result.length === 0) {
    return c.json({ error: 'Founder not found' }, 404);
  }
  return c.json(result[0]);
});

// Delete founder
app.delete('/:id', async (c) => {
  const id = parseInt(c.req.param('id'));
  const result = await db.delete(founders).where(eq(founders.id, id)).returning();

  if (result.length === 0) {
    return c.json({ error: 'Founder not found' }, 404);
  }
  return c.json({ success: true });
});

// Get founder's nodes
app.get('/:id/nodes', async (c) => {
  const id = parseInt(c.req.param('id'));
  const relationships = await db.query.founderNodeRelationships.findMany({
    where: eq(founderNodeRelationships.founderId, id),
    with: {
      node: {
        with: {
          investorConnections: {
            with: {
              investor: true,
            },
          },
        },
      },
    },
  });
  return c.json(relationships);
});

// Add node relationship
app.post('/:id/nodes', async (c) => {
  const founderId = parseInt(c.req.param('id'));
  const body = await c.req.json();

  const schema = z.object({
    nodeId: z.number(),
    relationshipStrength: z.enum(['strong', 'medium', 'weak']).optional(),
    howConnected: z.string().optional(),
  });

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues }, 400);
  }

  const now = new Date().toISOString();
  const result = await db.insert(founderNodeRelationships).values({
    founderId,
    nodeId: parsed.data.nodeId,
    relationshipStrength: parsed.data.relationshipStrength || 'medium',
    howConnected: parsed.data.howConnected,
    createdAt: now,
  }).returning();

  return c.json(result[0], 201);
});

export default app;
