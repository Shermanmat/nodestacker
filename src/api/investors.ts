import { Hono } from 'hono';
import { eq, desc, and } from 'drizzle-orm';
import { db, investors, investorResearch } from '../db/index.js';
import { z } from 'zod';

const app = new Hono();

const createInvestorSchema = z.object({
  name: z.string().min(1),
  firm: z.string().optional(),
  role: z.string().optional(),
  focusAreas: z.array(z.string()).optional(),
  checkSize: z.string().optional(),
  geography: z.string().optional(),
});

const updateInvestorSchema = createInvestorSchema.partial();

// List all investors with their latest research
app.get('/', async (c) => {
  const allInvestors = await db.select().from(investors);

  // Get all completed research
  const allResearch = await db.select()
    .from(investorResearch)
    .where(eq(investorResearch.status, 'completed'))
    .orderBy(desc(investorResearch.researchedAt));

  // Create map of latest research per investor
  const researchMap = new Map<number, {
    bio: string | null;
    investmentThesis: string | null;
    portfolioCompanies: string | null;
    founderPreferences: string | null;
    recentActivity: string | null;
    researchedAt: string | null;
  }>();

  for (const r of allResearch) {
    if (!researchMap.has(r.investorId)) {
      researchMap.set(r.investorId, {
        bio: r.bio,
        investmentThesis: r.investmentThesis,
        portfolioCompanies: r.portfolioCompanies,
        founderPreferences: r.founderPreferences,
        recentActivity: r.recentActivity,
        researchedAt: r.researchedAt,
      });
    }
  }

  // Parse focusAreas JSON and attach research
  const parsed = allInvestors.map(inv => ({
    ...inv,
    focusAreas: inv.focusAreas ? JSON.parse(inv.focusAreas) : [],
    research: researchMap.get(inv.id) || null,
  }));

  return c.json(parsed);
});

// Get single investor with connections
app.get('/:id', async (c) => {
  const id = parseInt(c.req.param('id'));
  const investor = await db.query.investors.findFirst({
    where: eq(investors.id, id),
    with: {
      nodeConnections: {
        with: {
          node: true,
        },
      },
      introRequests: {
        with: {
          founder: true,
          node: true,
        },
      },
    },
  });

  if (!investor) {
    return c.json({ error: 'Investor not found' }, 404);
  }

  return c.json({
    ...investor,
    focusAreas: investor.focusAreas ? JSON.parse(investor.focusAreas) : [],
  });
});

// Create investor
app.post('/', async (c) => {
  const body = await c.req.json();
  const parsed = createInvestorSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: parsed.error.issues }, 400);
  }

  const now = new Date().toISOString();
  const result = await db.insert(investors).values({
    ...parsed.data,
    focusAreas: parsed.data.focusAreas ? JSON.stringify(parsed.data.focusAreas) : null,
    createdAt: now,
  }).returning();

  return c.json({
    ...result[0],
    focusAreas: parsed.data.focusAreas || [],
  }, 201);
});

// Update investor
app.put('/:id', async (c) => {
  const id = parseInt(c.req.param('id'));
  const body = await c.req.json();
  const parsed = updateInvestorSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: parsed.error.issues }, 400);
  }

  const updateData: Record<string, unknown> = { ...parsed.data };
  if (parsed.data.focusAreas) {
    updateData.focusAreas = JSON.stringify(parsed.data.focusAreas);
  }

  const result = await db.update(investors)
    .set(updateData)
    .where(eq(investors.id, id))
    .returning();

  if (result.length === 0) {
    return c.json({ error: 'Investor not found' }, 404);
  }
  return c.json({
    ...result[0],
    focusAreas: result[0].focusAreas ? JSON.parse(result[0].focusAreas) : [],
  });
});

// Delete investor
app.delete('/:id', async (c) => {
  const id = parseInt(c.req.param('id'));
  const result = await db.delete(investors).where(eq(investors.id, id)).returning();

  if (result.length === 0) {
    return c.json({ error: 'Investor not found' }, 404);
  }
  return c.json({ success: true });
});

export default app;
