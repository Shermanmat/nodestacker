import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, portfolioCompanies, founders } from '../db/index.js';
import { z } from 'zod';

const app = new Hono();

const portfolioSchema = z.object({
  founderId: z.number(),
  investmentDate: z.string().nullable().optional(),
  equityPercent: z.string().nullable().optional(),
  currentValuation: z.number().nullable().optional(),
  advisorySigned: z.boolean().optional(),
  equitySigned: z.boolean().optional(),
  sharesPaid: z.boolean().optional(),
  certificateReceived: z.boolean().optional(),
  notes: z.string().nullable().optional(),
});

const updateSchema = portfolioSchema.partial().omit({ founderId: true });

// List all portfolio companies with founder info
app.get('/', async (c) => {
  const companies = await db.query.portfolioCompanies.findMany({
    with: {
      founder: true,
    },
    orderBy: (portfolioCompanies, { desc }) => [desc(portfolioCompanies.currentValuation)],
  });

  // Calculate totals
  let totalValue = 0;
  for (const co of companies) {
    if (co.currentValuation && co.equityPercent) {
      const equity = parseFloat(co.equityPercent) / 100;
      totalValue += co.currentValuation * equity;
    }
  }

  return c.json({
    companies,
    summary: {
      totalCompanies: companies.length,
      totalPortfolioValue: Math.round(totalValue),
      fullyCompleted: companies.filter(c =>
        c.advisorySigned && c.equitySigned && c.sharesPaid && c.certificateReceived
      ).length,
    },
  });
});

// Get single portfolio company
app.get('/:id', async (c) => {
  const id = parseInt(c.req.param('id'));
  const company = await db.query.portfolioCompanies.findFirst({
    where: eq(portfolioCompanies.id, id),
    with: {
      founder: true,
    },
  });

  if (!company) {
    return c.json({ error: 'Portfolio company not found' }, 404);
  }
  return c.json(company);
});

// Add company to portfolio
app.post('/', async (c) => {
  const body = await c.req.json();
  const parsed = portfolioSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: parsed.error.issues }, 400);
  }

  // Check founder exists
  const founder = await db.select().from(founders).where(eq(founders.id, parsed.data.founderId));
  if (founder.length === 0) {
    return c.json({ error: 'Founder not found' }, 404);
  }

  // Check not already in portfolio
  const existing = await db.select().from(portfolioCompanies)
    .where(eq(portfolioCompanies.founderId, parsed.data.founderId));
  if (existing.length > 0) {
    return c.json({ error: 'This founder is already in the portfolio' }, 400);
  }

  const now = new Date().toISOString();
  const result = await db.insert(portfolioCompanies).values({
    ...parsed.data,
    createdAt: now,
    updatedAt: now,
  }).returning();

  return c.json(result[0], 201);
});

// Update portfolio company
app.put('/:id', async (c) => {
  const id = parseInt(c.req.param('id'));
  const body = await c.req.json();
  const parsed = updateSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: parsed.error.issues }, 400);
  }

  const now = new Date().toISOString();
  const result = await db.update(portfolioCompanies)
    .set({
      ...parsed.data,
      updatedAt: now,
    })
    .where(eq(portfolioCompanies.id, id))
    .returning();

  if (result.length === 0) {
    return c.json({ error: 'Portfolio company not found' }, 404);
  }
  return c.json(result[0]);
});

// Remove from portfolio
app.delete('/:id', async (c) => {
  const id = parseInt(c.req.param('id'));
  const result = await db.delete(portfolioCompanies)
    .where(eq(portfolioCompanies.id, id))
    .returning();

  if (result.length === 0) {
    return c.json({ error: 'Portfolio company not found' }, 404);
  }
  return c.json({ success: true });
});

// Get founders eligible to add to portfolio (not already in portfolio)
app.get('/eligible/founders', async (c) => {
  const allFounders = await db.select().from(founders);
  const inPortfolio = await db.select({ founderId: portfolioCompanies.founderId }).from(portfolioCompanies);
  const portfolioIds = new Set(inPortfolio.map(p => p.founderId));

  const eligible = allFounders.filter(f => !portfolioIds.has(f.id));
  return c.json(eligible);
});

export default app;
