import { Hono } from 'hono';
import { eq, desc } from 'drizzle-orm';
import { db, brands } from '../db/index.js';
import { z } from 'zod';

const app = new Hono();

const brandSchema = z.object({
  name: z.string().min(1),
  contactName: z.string().nullable().optional(),
  contactEmail: z.string().nullable().optional(),
  status: z.enum(['lead', 'contacted', 'in_conversation', 'committed', 'passed']).optional(),
  notes: z.string().nullable().optional(),
});

// List all brands
app.get('/', async (c) => {
  const all = await db.select().from(brands).orderBy(desc(brands.createdAt));
  return c.json(all);
});

// Create brand
app.post('/', async (c) => {
  const body = await c.req.json();
  const parsed = brandSchema.parse(body);
  const now = new Date().toISOString();
  const [created] = await db.insert(brands).values({
    ...parsed,
    createdAt: now,
    updatedAt: now,
  }).returning();
  return c.json(created, 201);
});

// Update brand
app.put('/:id', async (c) => {
  const id = parseInt(c.req.param('id'));
  const body = await c.req.json();
  const parsed = brandSchema.partial().parse(body);
  const now = new Date().toISOString();
  const [updated] = await db.update(brands)
    .set({ ...parsed, updatedAt: now })
    .where(eq(brands.id, id))
    .returning();
  if (!updated) return c.json({ error: 'Not found' }, 404);
  return c.json(updated);
});

// Delete brand
app.delete('/:id', async (c) => {
  const id = parseInt(c.req.param('id'));
  await db.delete(brands).where(eq(brands.id, id));
  return c.json({ success: true });
});

export default app;
