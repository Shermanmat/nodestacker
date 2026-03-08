import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, investorCategories, investorCategoryAssignments, founderCategoryAssignments } from '../db/index.js';
import { z } from 'zod';

const app = new Hono();

const categorySchema = z.object({
  name: z.string().min(1),
  type: z.enum(['stage', 'persona', 'sector']).optional().default('sector'),
  color: z.string().optional().default('gray'),
});

// List all categories
app.get('/', async (c) => {
  const categories = await db.select().from(investorCategories);
  return c.json(categories);
});

// Create category
app.post('/', async (c) => {
  const body = await c.req.json();
  const parsed = categorySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues }, 400);
  }

  const now = new Date().toISOString();
  const result = await db.insert(investorCategories).values({
    name: parsed.data.name,
    type: parsed.data.type,
    color: parsed.data.color,
    createdAt: now,
  }).returning();

  return c.json(result[0], 201);
});

// Update category
app.put('/:id', async (c) => {
  const id = parseInt(c.req.param('id'));
  const body = await c.req.json();
  const parsed = categorySchema.partial().safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues }, 400);
  }

  const result = await db.update(investorCategories)
    .set(parsed.data)
    .where(eq(investorCategories.id, id))
    .returning();

  if (result.length === 0) {
    return c.json({ error: 'Category not found' }, 404);
  }
  return c.json(result[0]);
});

// Delete category (cascade handled by ON DELETE CASCADE in schema)
app.delete('/:id', async (c) => {
  const id = parseInt(c.req.param('id'));

  // Delete assignments first (SQLite may not cascade automatically via Drizzle)
  await db.delete(investorCategoryAssignments).where(eq(investorCategoryAssignments.categoryId, id));
  await db.delete(founderCategoryAssignments).where(eq(founderCategoryAssignments.categoryId, id));

  const result = await db.delete(investorCategories).where(eq(investorCategories.id, id)).returning();
  if (result.length === 0) {
    return c.json({ error: 'Category not found' }, 404);
  }
  return c.json({ success: true });
});

export default app;
