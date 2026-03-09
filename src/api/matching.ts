import { Hono } from 'hono';
import { eq, and, inArray, desc } from 'drizzle-orm';
import {
  db,
  matchSuggestions,
  personaHotnessTiers,
  investorCategoryExclusions,
  investorCategories,
  introRequests,
  founderNodeRelationships,
  nodeInvestorConnections,
  founders,
} from '../db/index.js';
import {
  generateMatchSuggestions,
  computeAllFounderScores,
  computeAllInvestorScores,
} from '../services/matching.js';
import { z } from 'zod';

const app = new Hono();

// --- Persona Tier Endpoints ---

// Get persona hotness tiers
app.get('/persona-tiers', async (c) => {
  const tiers = await db.select().from(personaHotnessTiers);
  return c.json(tiers.sort((a, b) => b.tier - a.tier));
});

// Update persona hotness tiers
app.put('/persona-tiers', async (c) => {
  const body = await c.req.json();
  const schema = z.object({
    tiers: z.array(z.object({
      persona: z.string(),
      tier: z.number().int().min(1).max(7),
    })),
  });

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ') }, 400);
  }

  const now = new Date().toISOString();
  for (const { persona, tier } of parsed.data.tiers) {
    await db.update(personaHotnessTiers)
      .set({ tier, updatedAt: now })
      .where(eq(personaHotnessTiers.persona, persona));
  }

  const updated = await db.select().from(personaHotnessTiers);
  return c.json(updated.sort((a, b) => b.tier - a.tier));
});

// --- Exclusion Endpoints ---

// Get exclusions for an investor
app.get('/exclusions/:investorId', async (c) => {
  const investorId = parseInt(c.req.param('investorId'));
  const exclusions = await db.select({
    id: investorCategoryExclusions.id,
    investorId: investorCategoryExclusions.investorId,
    categoryId: investorCategoryExclusions.categoryId,
    categoryName: investorCategories.name,
    categoryType: investorCategories.type,
  }).from(investorCategoryExclusions)
    .innerJoin(investorCategories, eq(investorCategoryExclusions.categoryId, investorCategories.id))
    .where(eq(investorCategoryExclusions.investorId, investorId));

  return c.json(exclusions);
});

// Set exclusions for an investor (replaces all)
app.put('/exclusions/:investorId', async (c) => {
  const investorId = parseInt(c.req.param('investorId'));
  const body = await c.req.json();
  const schema = z.object({
    categoryIds: z.array(z.number()),
  });

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ') }, 400);
  }

  // Delete existing exclusions
  await db.delete(investorCategoryExclusions)
    .where(eq(investorCategoryExclusions.investorId, investorId));

  // Insert new exclusions
  if (parsed.data.categoryIds.length > 0) {
    await db.insert(investorCategoryExclusions).values(
      parsed.data.categoryIds.map(categoryId => ({
        investorId,
        categoryId,
      }))
    );
  }

  return c.json({ success: true, investorId, excludedCategoryIds: parsed.data.categoryIds });
});

// --- Score Visibility Endpoints ---

// Get all founder heat scores
app.get('/scores/founders', async (c) => {
  const scores = await computeAllFounderScores();
  return c.json(scores);
});

// Get all investor reliability scores
app.get('/scores/investors', async (c) => {
  const scores = await computeAllInvestorScores();
  return c.json(scores);
});

// --- Match Generation ---

// Generate match suggestions → creates intro requests with pending_suggestion status
app.post('/generate', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const founderId = body.founderId ? parseInt(body.founderId) : undefined;

  const { suggestions, batchId, rampUps } = await generateMatchSuggestions(founderId);

  // Apply ramp-ups to founder intro targets
  for (const ramp of rampUps) {
    await db.update(founders)
      .set({ introTargetPerWeek: ramp.newTarget })
      .where(eq(founders.id, ramp.founderId));
  }

  // Create intro requests and match suggestions for each generated suggestion
  const createdIntros: number[] = [];
  for (const s of suggestions) {
    const now = new Date().toISOString();
    const reasoning = JSON.parse(s.matchReasoning);

    // Create intro request with pending_suggestion status
    const [introRequest] = await db.insert(introRequests).values({
      founderId: s.founderId,
      nodeId: s.nodeId,
      investorId: s.investorId,
      status: 'pending_suggestion',
      notes: `Match Score: ${s.matchScore} | ${reasoning.logic}`,
      createdAt: now,
      updatedAt: now,
    }).returning();

    // Create match suggestion linked to the intro request (scoring metadata)
    await db.insert(matchSuggestions).values({
      founderId: s.founderId,
      nodeId: s.nodeId,
      investorId: s.investorId,
      founderHeatScore: s.founderHeatScore,
      investorReliabilityScore: s.investorReliabilityScore,
      matchScore: s.matchScore,
      matchReasoning: s.matchReasoning,
      batchId: s.batchId,
      status: 'pending',
      introRequestId: introRequest.id,
      createdAt: now,
    });

    createdIntros.push(introRequest.id);
  }

  const founderIds = new Set(suggestions.map(s => s.founderId));

  return c.json({
    batchId,
    totalGenerated: suggestions.length,
    foundersCovered: founderIds.size,
    introRequestIds: createdIntros,
    rampUps: rampUps.length > 0 ? rampUps : undefined,
    averageMatchScore: suggestions.length > 0
      ? Math.round(suggestions.reduce((sum, s) => sum + s.matchScore, 0) / suggestions.length)
      : 0,
  });
});

// --- Pending Suggestion Management ---

// Approve a pending suggestion → changes intro request to intro_request_sent
app.put('/approve-intro/:id', async (c) => {
  const id = parseInt(c.req.param('id'));

  const introRequest = await db.query.introRequests.findFirst({
    where: eq(introRequests.id, id),
  });

  if (!introRequest) return c.json({ error: 'Intro request not found' }, 404);
  if (introRequest.status !== 'pending_suggestion') {
    return c.json({ error: `Not a pending suggestion (status: ${introRequest.status})` }, 400);
  }

  const now = new Date().toISOString();
  await db.update(introRequests)
    .set({
      status: 'intro_request_sent',
      dateRequested: now.split('T')[0],
      updatedAt: now,
    })
    .where(eq(introRequests.id, id));

  // Update linked match suggestion
  await db.update(matchSuggestions)
    .set({ status: 'approved', reviewedAt: now })
    .where(eq(matchSuggestions.introRequestId, id));

  return c.json({ success: true, introRequestId: id });
});

// Reject a pending suggestion → removes the intro request
app.put('/reject-intro/:id', async (c) => {
  const id = parseInt(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));

  const introRequest = await db.query.introRequests.findFirst({
    where: eq(introRequests.id, id),
  });

  if (!introRequest) return c.json({ error: 'Intro request not found' }, 404);
  if (introRequest.status !== 'pending_suggestion') {
    return c.json({ error: `Not a pending suggestion (status: ${introRequest.status})` }, 400);
  }

  // Delete the intro request (it was never sent)
  await db.delete(introRequests).where(eq(introRequests.id, id));

  // Mark linked match suggestion as rejected
  const now = new Date().toISOString();
  await db.update(matchSuggestions)
    .set({ status: 'rejected', reviewedAt: now, rejectionReason: body.reason || null })
    .where(eq(matchSuggestions.introRequestId, id));

  return c.json({ success: true });
});

// Bulk approve pending suggestions
app.post('/bulk-approve-intros', async (c) => {
  const body = await c.req.json();
  const schema = z.object({
    introRequestIds: z.array(z.number()),
  });

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ') }, 400);
  }

  const now = new Date().toISOString();
  const results: { id: number; error?: string }[] = [];

  for (const id of parsed.data.introRequestIds) {
    const ir = await db.query.introRequests.findFirst({
      where: eq(introRequests.id, id),
    });

    if (!ir || ir.status !== 'pending_suggestion') {
      results.push({ id, error: ir ? `Status: ${ir.status}` : 'Not found' });
      continue;
    }

    await db.update(introRequests)
      .set({ status: 'intro_request_sent', dateRequested: now.split('T')[0], updatedAt: now })
      .where(eq(introRequests.id, id));

    await db.update(matchSuggestions)
      .set({ status: 'approved', reviewedAt: now })
      .where(eq(matchSuggestions.introRequestId, id));

    results.push({ id });
  }

  return c.json({
    approved: results.filter(r => !r.error).length,
    failed: results.filter(r => r.error).length,
    results,
  });
});

// --- Legacy Suggestion Endpoints (match_suggestions table) ---

// List suggestions with filters
app.get('/suggestions', async (c) => {
  const status = c.req.query('status') || 'pending';
  const founderId = c.req.query('founderId');
  const batchId = c.req.query('batchId');

  const suggestions = await db.query.matchSuggestions.findMany({
    with: {
      founder: true,
      node: true,
      investor: true,
    },
    orderBy: desc(matchSuggestions.matchScore),
  });

  let filtered = suggestions;
  if (status) {
    filtered = filtered.filter(s => s.status === status);
  }
  if (founderId) {
    filtered = filtered.filter(s => s.founderId === parseInt(founderId));
  }
  if (batchId) {
    filtered = filtered.filter(s => s.batchId === batchId);
  }

  return c.json(filtered);
});

// --- Suggestion Expiration ---

// Expire stale suggestions and their pending_suggestion intro requests
async function expireStaleSuggestions() {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const pending = await db.select().from(matchSuggestions)
    .where(eq(matchSuggestions.status, 'pending'));

  let expired = 0;
  for (const s of pending) {
    if (s.createdAt && s.createdAt < sevenDaysAgo) {
      await db.update(matchSuggestions)
        .set({ status: 'expired' })
        .where(eq(matchSuggestions.id, s.id));

      // Also clean up the linked pending_suggestion intro request
      if (s.introRequestId) {
        const ir = await db.query.introRequests.findFirst({
          where: eq(introRequests.id, s.introRequestId),
        });
        if (ir && ir.status === 'pending_suggestion') {
          await db.delete(introRequests).where(eq(introRequests.id, s.introRequestId));
        }
      }

      expired++;
    }
  }

  if (expired > 0) {
    console.log(`[Matching] Expired ${expired} stale suggestion(s)`);
  }
}

// Run expiration on startup and every 6 hours
expireStaleSuggestions();
setInterval(expireStaleSuggestions, 6 * 60 * 60 * 1000);

export default app;
