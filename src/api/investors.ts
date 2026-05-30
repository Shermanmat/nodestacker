import { Hono } from 'hono';
import { eq, desc, and, sql } from 'drizzle-orm';
import {
  db,
  investors,
  investorResearch,
  introRequests,
  nodeInvestorConnections,
  investorCategoryAssignments,
  investorCategoryExclusions,
  investorCategories,
  matchSuggestions,
  inboundIntroLogs,
  instantlyLeads,
} from '../db/index.js';
import { inferState, STATE_CODES } from '../services/us-states.js';

// If admin didn't pass an explicit state but did pass a city we recognize,
// fill it in. Normalizes state codes to uppercase. Returns the (possibly
// mutated) data object — call before writing to DB.
function applyStateInference<T extends { city?: string | null; state?: string | null }>(data: T): T {
  if (data.state) {
    data.state = String(data.state).trim().toUpperCase();
    if (!STATE_CODES.has(data.state)) data.state = null;
  } else if (data.city) {
    const inferred = inferState(data.city);
    if (inferred) data.state = inferred;
  }
  return data;
}
import { z } from 'zod';

const app = new Hono();

const createInvestorSchema = z.object({
  name: z.string().min(1),
  firm: z.string().nullable().optional(),
  role: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  focusAreas: z.array(z.string()).nullable().optional(),
  checkSize: z.string().nullable().optional(),
  geography: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
});

const updateInvestorSchema = createInvestorSchema.partial().extend({
  active: z.boolean().optional(),
  vip: z.boolean().optional(),
  pausedUntil: z.string().nullable().optional(),
  pauseReason: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
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

  // Aggregate intro_requests per investor so we can show accept rate in
  // the list. "Accepted" = investor said yes (introduced or any downstream
  // status). "Total" = every intro request sent to them, regardless of
  // status. Pending intros count in the denominator — an investor with 5
  // outstanding/ignored intros and 1 accepted is honestly 1/6 = 17%.
  // Match-agent suggestions that were never sent are excluded.
  const allIntros = await db.select({
    investorId: introRequests.investorId,
    status: introRequests.status,
  }).from(introRequests);
  const ACCEPTED_STATUSES = new Set([
    'introduced',
    'first_meeting_complete',
    'second_meeting_complete',
    'follow_up_questions',
    'circle_back_round_opens',
    'invested',
  ]);
  const introStats = new Map<number, { total: number; accepted: number }>();
  for (const i of allIntros) {
    if (i.status === 'pending_suggestion') continue;
    const s = introStats.get(i.investorId) || { total: 0, accepted: 0 };
    s.total++;
    if (ACCEPTED_STATUSES.has(i.status)) s.accepted++;
    introStats.set(i.investorId, s);
  }

  // Parse focusAreas JSON, attach research, categories, and intro stats.
  let parsed = allInvestors.map(inv => {
    const stats = introStats.get(inv.id) || { total: 0, accepted: 0 };
    const acceptRate = stats.total > 0 ? Math.round((stats.accepted / stats.total) * 100) : null;
    return {
      ...inv,
      focusAreas: inv.focusAreas ? JSON.parse(inv.focusAreas) : [],
      research: researchMap.get(inv.id) || null,
      categories: categoryMap.get(inv.id) || [],
      introTotal: stats.total,
      introAccepted: stats.accepted,
      acceptRate, // null = no intros sent yet, so UI can show "—"
    };
  });

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

  // Pull this investor's category exclusions so the edit modal can pre-populate
  // the "Won't take" multi-select.
  const excludedRows = await db.select({ categoryId: investorCategoryExclusions.categoryId })
    .from(investorCategoryExclusions)
    .where(eq(investorCategoryExclusions.investorId, investor.id));

  return c.json({
    ...investor,
    focusAreas: investor.focusAreas ? JSON.parse(investor.focusAreas) : [],
    excludedCategoryIds: excludedRows.map(r => r.categoryId),
  });
});

// Replace this investor's category exclusions with the supplied list.
// "Lori @ Bloomberg Beta doesn't take fintech" → POST { categoryIds: [<fintech_id>] }.
// Matching algorithm honors these automatically via passesCategoryFilter.
app.put('/:id/exclusions', async (c) => {
  const id = parseInt(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));
  const schema = z.object({ categoryIds: z.array(z.number()) });
  const parsed = schema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);

  await db.delete(investorCategoryExclusions).where(eq(investorCategoryExclusions.investorId, id));
  for (const categoryId of parsed.data.categoryIds) {
    await db.insert(investorCategoryExclusions)
      .values({ investorId: id, categoryId })
      .onConflictDoNothing();
  }
  return c.json({ success: true, count: parsed.data.categoryIds.length });
});

// Create investor
app.post('/', async (c) => {
  const body = await c.req.json();
  const parsed = createInvestorSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: parsed.error.issues }, 400);
  }

  const now = new Date().toISOString();
  const data = applyStateInference({ ...parsed.data });
  const result = await db.insert(investors).values({
    ...data,
    focusAreas: data.focusAreas ? JSON.stringify(data.focusAreas) : null,
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

  const updateData: Record<string, unknown> = { ...applyStateInference({ ...parsed.data }) };
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

// Pause investor for N months (default 3)
app.post('/:id/pause', async (c) => {
  const id = parseInt(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));
  const months = body.months || 3;
  const reason = body.reason || 'Raising fund';

  const pausedUntil = new Date();
  pausedUntil.setMonth(pausedUntil.getMonth() + months);

  const result = await db.update(investors)
    .set({ pausedUntil: pausedUntil.toISOString(), pauseReason: reason })
    .where(eq(investors.id, id))
    .returning();

  if (result.length === 0) return c.json({ error: 'Investor not found' }, 404);
  return c.json({ success: true, pausedUntil: result[0].pausedUntil, pauseReason: result[0].pauseReason });
});

// Unpause investor
app.post('/:id/unpause', async (c) => {
  const id = parseInt(c.req.param('id'));
  const result = await db.update(investors)
    .set({ pausedUntil: null, pauseReason: null })
    .where(eq(investors.id, id))
    .returning();

  if (result.length === 0) return c.json({ error: 'Investor not found' }, 404);
  return c.json({ success: true });
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

/**
 * Merge a duplicate investor into a canonical one.
 *
 * Reassigns every FK reference from `fromId` → `toId`, then deletes the
 * source investor. For relationship tables where (investorId, otherCol)
 * is logically unique (node connections, category assignments / exclusions,
 * AI research), duplicates are deduped — the target's row wins.
 *
 * For event tables (intro_requests, match_suggestions, inbound_intro_logs,
 * instantly_leads, angel_leaderboard) all rows get reassigned with no
 * dedup — they're history, not state.
 *
 * POST /api/investors/:fromId/merge-into/:toId
 */
app.post('/:fromId/merge-into/:toId', async (c) => {
  const fromId = parseInt(c.req.param('fromId'));
  const toId = parseInt(c.req.param('toId'));

  if (isNaN(fromId) || isNaN(toId)) {
    return c.json({ error: 'Invalid investor ids' }, 400);
  }
  if (fromId === toId) {
    return c.json({ error: 'Cannot merge an investor into itself' }, 400);
  }

  const [fromInv] = await db.select().from(investors).where(eq(investors.id, fromId)).limit(1);
  const [toInv] = await db.select().from(investors).where(eq(investors.id, toId)).limit(1);
  if (!fromInv) return c.json({ error: 'Source (duplicate) investor not found' }, 404);
  if (!toInv) return c.json({ error: 'Target (keep) investor not found' }, 404);

  const stats = {
    introRequests: 0,
    matchSuggestions: 0,
    nodeConnections: { reassigned: 0, deduped: 0 },
    categoryAssignments: { reassigned: 0, deduped: 0 },
    categoryExclusions: { reassigned: 0, deduped: 0 },
    research: { reassigned: 0, deduped: 0 },
    inboundLogs: 0,
    instantlyLeads: 0,
  };

  // 1. intro_requests — history, simple reassign
  const introResult = await db.update(introRequests)
    .set({ investorId: toId })
    .where(eq(introRequests.investorId, fromId))
    .returning();
  stats.introRequests = introResult.length;

  // 2. match_suggestions — history, simple reassign
  const msResult = await db.update(matchSuggestions)
    .set({ investorId: toId })
    .where(eq(matchSuggestions.investorId, fromId))
    .returning();
  stats.matchSuggestions = msResult.length;

  // 3. node_investor_connections — dedupe by (nodeId, investorId)
  const fromConns = await db.select().from(nodeInvestorConnections)
    .where(eq(nodeInvestorConnections.investorId, fromId));
  const toConns = await db.select().from(nodeInvestorConnections)
    .where(eq(nodeInvestorConnections.investorId, toId));
  const toConnNodeIds = new Set(toConns.map(c => c.nodeId));
  for (const conn of fromConns) {
    if (toConnNodeIds.has(conn.nodeId)) {
      await db.delete(nodeInvestorConnections).where(eq(nodeInvestorConnections.id, conn.id));
      stats.nodeConnections.deduped++;
    } else {
      await db.update(nodeInvestorConnections)
        .set({ investorId: toId })
        .where(eq(nodeInvestorConnections.id, conn.id));
      stats.nodeConnections.reassigned++;
    }
  }

  // 4. investor_category_assignments — dedupe by (investorId, categoryId)
  const fromCats = await db.select().from(investorCategoryAssignments)
    .where(eq(investorCategoryAssignments.investorId, fromId));
  const toCats = await db.select().from(investorCategoryAssignments)
    .where(eq(investorCategoryAssignments.investorId, toId));
  const toCatIds = new Set(toCats.map(c => c.categoryId));
  for (const a of fromCats) {
    if (toCatIds.has(a.categoryId)) {
      await db.delete(investorCategoryAssignments).where(eq(investorCategoryAssignments.id, a.id));
      stats.categoryAssignments.deduped++;
    } else {
      await db.update(investorCategoryAssignments)
        .set({ investorId: toId })
        .where(eq(investorCategoryAssignments.id, a.id));
      stats.categoryAssignments.reassigned++;
    }
  }

  // 5. investor_category_exclusions — dedupe by (investorId, categoryId)
  const fromExcl = await db.select().from(investorCategoryExclusions)
    .where(eq(investorCategoryExclusions.investorId, fromId));
  const toExcl = await db.select().from(investorCategoryExclusions)
    .where(eq(investorCategoryExclusions.investorId, toId));
  const toExclIds = new Set(toExcl.map(e => e.categoryId));
  for (const e of fromExcl) {
    if (toExclIds.has(e.categoryId)) {
      await db.delete(investorCategoryExclusions).where(eq(investorCategoryExclusions.id, e.id));
      stats.categoryExclusions.deduped++;
    } else {
      await db.update(investorCategoryExclusions)
        .set({ investorId: toId })
        .where(eq(investorCategoryExclusions.id, e.id));
      stats.categoryExclusions.reassigned++;
    }
  }

  // 6. investor_research — usually one per investor; if target has one, drop source's
  const fromResearch = await db.select().from(investorResearch)
    .where(eq(investorResearch.investorId, fromId));
  const targetHasResearch = (await db.select({ id: investorResearch.id }).from(investorResearch)
    .where(eq(investorResearch.investorId, toId)).limit(1)).length > 0;
  for (const r of fromResearch) {
    if (targetHasResearch) {
      await db.delete(investorResearch).where(eq(investorResearch.id, r.id));
      stats.research.deduped++;
    } else {
      await db.update(investorResearch)
        .set({ investorId: toId })
        .where(eq(investorResearch.id, r.id));
      stats.research.reassigned++;
    }
  }

  // 7. inbound_intro_logs.detectedInvestorId — nullable, simple reassign
  const inboundResult = await db.update(inboundIntroLogs)
    .set({ detectedInvestorId: toId })
    .where(eq(inboundIntroLogs.detectedInvestorId, fromId))
    .returning();
  stats.inboundLogs = inboundResult.length;

  // 8. instantly_leads — nullable, simple reassign
  const instResult = await db.update(instantlyLeads)
    .set({ investorId: toId })
    .where(eq(instantlyLeads.investorId, fromId))
    .returning();
  stats.instantlyLeads = instResult.length;

  // Finally, delete the source investor
  await db.delete(investors).where(eq(investors.id, fromId));

  return c.json({
    success: true,
    mergedInto: { id: toInv.id, name: toInv.name, firm: toInv.firm },
    deleted: { id: fromInv.id, name: fromInv.name, firm: fromInv.firm },
    stats,
  });
});

export default app;
