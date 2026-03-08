import { Hono } from 'hono';
import { eq, desc, and, sql } from 'drizzle-orm';
import { db, investors, investorResearch, introRequests, nodeInvestorConnections, investorCategoryAssignments, investorCategories } from '../db/index.js';
import { z } from 'zod';

const app = new Hono();

const createInvestorSchema = z.object({
  name: z.string().min(1),
  firm: z.string().nullable().optional(),
  role: z.string().nullable().optional(),
  focusAreas: z.array(z.string()).nullable().optional(),
  checkSize: z.string().nullable().optional(),
  geography: z.string().nullable().optional(),
});

const updateInvestorSchema = createInvestorSchema.partial().extend({
  active: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
  city: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
});

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

  // Get all category assignments
  const allCategoryAssignments = await db.select({
    investorId: investorCategoryAssignments.investorId,
    categoryId: investorCategoryAssignments.categoryId,
    categoryName: investorCategories.name,
    categoryType: investorCategories.type,
    categoryColor: investorCategories.color,
  }).from(investorCategoryAssignments)
    .innerJoin(investorCategories, eq(investorCategoryAssignments.categoryId, investorCategories.id));

  const categoryMap = new Map<number, { id: number; name: string; type: string; color: string | null }[]>();
  for (const a of allCategoryAssignments) {
    if (!categoryMap.has(a.investorId)) categoryMap.set(a.investorId, []);
    categoryMap.get(a.investorId)!.push({ id: a.categoryId, name: a.categoryName, type: a.categoryType, color: a.categoryColor });
  }

  // Filter by category or country if requested
  const categoryFilter = c.req.query('category');
  const countryFilter = c.req.query('country');

  // Parse focusAreas and tags JSON, attach research and categories
  let parsed = allInvestors.map(inv => ({
    ...inv,
    focusAreas: inv.focusAreas ? JSON.parse(inv.focusAreas) : [],
    tags: inv.tags ? JSON.parse(inv.tags) : [],
    research: researchMap.get(inv.id) || null,
    categories: categoryMap.get(inv.id) || [],
  }));

  if (categoryFilter) {
    const filterLower = categoryFilter.toLowerCase();
    parsed = parsed.filter(inv => inv.categories.some(cat => cat.name.toLowerCase() === filterLower));
  }

  if (countryFilter) {
    parsed = parsed.filter(inv => inv.country === countryFilter);
  }

  return c.json(parsed);
});

// Network Health: Get all investors with engagement metrics and dormancy status
// IMPORTANT: This must be before /:id to avoid route collision
app.get('/health', async (c) => {
  const allInvestors = await db.select().from(investors);
  const allIntroRequests = await db.select().from(introRequests);
  const allConnections = await db.select().from(nodeInvestorConnections);

  // Calculate metrics per investor
  const investorMetrics = allInvestors.map(inv => {
    const intros = allIntroRequests.filter(ir => ir.investorId === inv.id);
    const connections = allConnections.filter(c => c.investorId === inv.id);

    // Count statuses
    const totalIntros = intros.length;
    const ignored = intros.filter(ir => ir.status === 'ignored').length;
    const passed = intros.filter(ir => ir.status === 'passed').length;
    const meetings = intros.filter(ir =>
      ['first_meeting_complete', 'second_meeting_complete', 'invested'].includes(ir.status)
    ).length;
    const invested = intros.filter(ir => ir.status === 'invested').length;
    const introduced = intros.filter(ir =>
      ['introduced', 'first_meeting_complete', 'second_meeting_complete', 'invested', 'circle_back_round_opens', 'follow_up_questions'].includes(ir.status)
    ).length;
    const responded = introduced + passed; // Responded = actually made a decision (not ignored, not pending)

    // Calculate rates
    const responseRate = totalIntros > 0 ? Math.round((responded / totalIntros) * 100) : 0;
    const ignoreRate = totalIntros > 0 ? Math.round((ignored / totalIntros) * 100) : 0;
    const meetingRate = responded > 0 ? Math.round((meetings / responded) * 100) : 0;
    const passRate = responded > 0 ? Math.round((passed / responded) * 100) : 0;

    // Find last intro date
    const introductionDates = intros
      .filter(ir => ir.dateIntroduced)
      .map(ir => new Date(ir.dateIntroduced!).getTime());
    const lastIntroDate = introductionDates.length > 0
      ? new Date(Math.max(...introductionDates)).toISOString().split('T')[0]
      : null;

    // Calculate days since last intro
    const now = new Date();
    const daysSinceLastIntro = lastIntroDate
      ? Math.floor((now.getTime() - new Date(lastIntroDate).getTime()) / (1000 * 60 * 60 * 24))
      : null;

    // Determine dormancy status
    let isDormant = false;
    let dormancyReason: string | null = null;

    // Check dormancy conditions (as per plan)
    if (daysSinceLastIntro !== null && daysSinceLastIntro > 90) {
      isDormant = true;
      dormancyReason = 'no_recent_intros';
    } else if (totalIntros >= 3 && responded === 0) {
      isDormant = true;
      dormancyReason = 'never_responded';
    } else if (totalIntros > 0 && ignoreRate > 70) {
      isDormant = true;
      dormancyReason = 'high_ignore_rate';
    } else if (responded > 0 && passRate > 80 && meetings === 0) {
      isDormant = true;
      dormancyReason = 'all_passes';
    }

    return {
      id: inv.id,
      name: inv.name,
      firm: inv.firm,

      // Engagement metrics
      totalIntros,
      responded,
      ignored,
      passed,
      meetings,
      invested,

      // Calculated rates
      responseRate,
      ignoreRate,
      meetingRate,

      // Recency
      lastIntroDate,
      daysSinceLastIntro,

      // Dormancy status
      isDormant,
      dormancyReason,

      // Current status
      active: inv.active,
      connectionCount: connections.length,
    };
  });

  // Calculate summary stats
  const total = investorMetrics.length;
  const active = investorMetrics.filter(im => im.active).length;
  const dormant = investorMetrics.filter(im => im.isDormant).length;

  const dormantByReason = {
    no_recent_intros: investorMetrics.filter(im => im.dormancyReason === 'no_recent_intros').length,
    high_ignore_rate: investorMetrics.filter(im => im.dormancyReason === 'high_ignore_rate').length,
    all_passes: investorMetrics.filter(im => im.dormancyReason === 'all_passes').length,
    never_responded: investorMetrics.filter(im => im.dormancyReason === 'never_responded').length,
  };

  return c.json({
    investors: investorMetrics,
    summary: {
      total,
      active,
      dormant,
      dormantByReason,
    },
  });
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
  if (parsed.data.tags) {
    updateData.tags = JSON.stringify(parsed.data.tags);
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
    tags: result[0].tags ? JSON.parse(result[0].tags) : [],
  });
});

// Assign categories to investor (replaces existing)
app.post('/:id/categories', async (c) => {
  const id = parseInt(c.req.param('id'));
  const body = await c.req.json();
  const parsed = z.object({ categoryIds: z.array(z.number()) }).safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues }, 400);
  }

  // Delete existing assignments
  await db.delete(investorCategoryAssignments).where(eq(investorCategoryAssignments.investorId, id));

  // Insert new assignments
  if (parsed.data.categoryIds.length > 0) {
    await db.insert(investorCategoryAssignments).values(
      parsed.data.categoryIds.map(categoryId => ({ investorId: id, categoryId }))
    );
  }

  // Return updated categories
  const assignments = await db.select({
    id: investorCategories.id,
    name: investorCategories.name,
    type: investorCategories.type,
    color: investorCategories.color,
  }).from(investorCategoryAssignments)
    .innerJoin(investorCategories, eq(investorCategoryAssignments.categoryId, investorCategories.id))
    .where(eq(investorCategoryAssignments.investorId, id));

  return c.json({ categories: assignments });
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
