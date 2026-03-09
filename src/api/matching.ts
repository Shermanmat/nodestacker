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

// Generate match suggestions
app.post('/generate', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const founderId = body.founderId ? parseInt(body.founderId) : undefined;

  const { suggestions, batchId } = await generateMatchSuggestions(founderId);

  // Insert suggestions into database
  if (suggestions.length > 0) {
    await db.insert(matchSuggestions).values(
      suggestions.map(s => ({
        founderId: s.founderId,
        nodeId: s.nodeId,
        investorId: s.investorId,
        founderHeatScore: s.founderHeatScore,
        investorReliabilityScore: s.investorReliabilityScore,
        matchScore: s.matchScore,
        matchReasoning: s.matchReasoning,
        batchId: s.batchId,
        status: 'pending',
        createdAt: new Date().toISOString(),
      }))
    );
  }

  // Count founders covered
  const founderIds = new Set(suggestions.map(s => s.founderId));

  return c.json({
    batchId,
    totalGenerated: suggestions.length,
    foundersCovered: founderIds.size,
    averageMatchScore: suggestions.length > 0
      ? Math.round(suggestions.reduce((sum, s) => sum + s.matchScore, 0) / suggestions.length)
      : 0,
  });
});

// --- Suggestion Management ---

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

// Approve a suggestion → creates intro request
app.put('/suggestions/:id/approve', async (c) => {
  const id = parseInt(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));

  const suggestion = await db.query.matchSuggestions.findFirst({
    where: eq(matchSuggestions.id, id),
  });

  if (!suggestion) {
    return c.json({ error: 'Suggestion not found' }, 404);
  }
  if (suggestion.status !== 'pending') {
    return c.json({ error: `Suggestion is already ${suggestion.status}` }, 400);
  }

  // Validate founder-node relationship still exists
  const fnRelation = await db.query.founderNodeRelationships.findFirst({
    where: and(
      eq(founderNodeRelationships.founderId, suggestion.founderId),
      eq(founderNodeRelationships.nodeId, suggestion.nodeId),
    ),
  });
  if (!fnRelation) {
    return c.json({ error: 'Founder-node relationship no longer exists' }, 400);
  }

  // Validate node-investor connection still exists
  const niConnection = await db.query.nodeInvestorConnections.findFirst({
    where: and(
      eq(nodeInvestorConnections.nodeId, suggestion.nodeId),
      eq(nodeInvestorConnections.investorId, suggestion.investorId),
    ),
  });
  if (!niConnection) {
    return c.json({ error: 'Node-investor connection no longer exists' }, 400);
  }

  // Check no active intro request already exists for this founder-investor pair
  const existingRequest = await db.query.introRequests.findFirst({
    where: and(
      eq(introRequests.founderId, suggestion.founderId),
      eq(introRequests.investorId, suggestion.investorId),
      inArray(introRequests.status, [
        'intro_request_sent',
        'introduced',
        'first_meeting_complete',
        'second_meeting_complete',
        'follow_up_questions',
      ]),
    ),
  });
  if (existingRequest) {
    return c.json({ error: 'Active intro request already exists for this founder-investor pair' }, 400);
  }

  // Create the intro request
  const now = new Date().toISOString();
  const [introRequest] = await db.insert(introRequests).values({
    founderId: suggestion.founderId,
    nodeId: suggestion.nodeId,
    investorId: suggestion.investorId,
    status: 'intro_request_sent',
    dateRequested: now.split('T')[0],
    notes: body.notes || null,
    createdAt: now,
    updatedAt: now,
  }).returning();

  // Update suggestion status
  await db.update(matchSuggestions)
    .set({
      status: 'approved',
      reviewedAt: now,
      introRequestId: introRequest.id,
    })
    .where(eq(matchSuggestions.id, id));

  return c.json({
    suggestion: { ...suggestion, status: 'approved', introRequestId: introRequest.id },
    introRequest,
  });
});

// Reject a suggestion
app.put('/suggestions/:id/reject', async (c) => {
  const id = parseInt(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));

  const suggestion = await db.query.matchSuggestions.findFirst({
    where: eq(matchSuggestions.id, id),
  });

  if (!suggestion) {
    return c.json({ error: 'Suggestion not found' }, 404);
  }
  if (suggestion.status !== 'pending') {
    return c.json({ error: `Suggestion is already ${suggestion.status}` }, 400);
  }

  await db.update(matchSuggestions)
    .set({
      status: 'rejected',
      reviewedAt: new Date().toISOString(),
      rejectionReason: body.reason || null,
    })
    .where(eq(matchSuggestions.id, id));

  return c.json({ success: true });
});

// Bulk approve suggestions
app.post('/suggestions/bulk-approve', async (c) => {
  const body = await c.req.json();
  const schema = z.object({
    suggestionIds: z.array(z.number()),
  });

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ') }, 400);
  }

  const results: { suggestionId: number; introRequestId?: number; error?: string }[] = [];

  for (const suggestionId of parsed.data.suggestionIds) {
    const suggestion = await db.query.matchSuggestions.findFirst({
      where: eq(matchSuggestions.id, suggestionId),
    });

    if (!suggestion || suggestion.status !== 'pending') {
      results.push({ suggestionId, error: suggestion ? `Already ${suggestion.status}` : 'Not found' });
      continue;
    }

    // Validate relationships still exist
    const fnRelation = await db.query.founderNodeRelationships.findFirst({
      where: and(
        eq(founderNodeRelationships.founderId, suggestion.founderId),
        eq(founderNodeRelationships.nodeId, suggestion.nodeId),
      ),
    });
    const niConnection = await db.query.nodeInvestorConnections.findFirst({
      where: and(
        eq(nodeInvestorConnections.nodeId, suggestion.nodeId),
        eq(nodeInvestorConnections.investorId, suggestion.investorId),
      ),
    });

    if (!fnRelation || !niConnection) {
      results.push({ suggestionId, error: 'Relationship no longer exists' });
      continue;
    }

    // Check for existing active intro
    const existingRequest = await db.query.introRequests.findFirst({
      where: and(
        eq(introRequests.founderId, suggestion.founderId),
        eq(introRequests.investorId, suggestion.investorId),
        inArray(introRequests.status, [
          'intro_request_sent', 'introduced', 'first_meeting_complete',
          'second_meeting_complete', 'follow_up_questions',
        ]),
      ),
    });

    if (existingRequest) {
      results.push({ suggestionId, error: 'Active intro already exists' });
      continue;
    }

    // Create intro request
    const now = new Date().toISOString();
    const [introRequest] = await db.insert(introRequests).values({
      founderId: suggestion.founderId,
      nodeId: suggestion.nodeId,
      investorId: suggestion.investorId,
      status: 'intro_request_sent',
      dateRequested: now.split('T')[0],
      createdAt: now,
      updatedAt: now,
    }).returning();

    // Update suggestion
    await db.update(matchSuggestions)
      .set({
        status: 'approved',
        reviewedAt: now,
        introRequestId: introRequest.id,
      })
      .where(eq(matchSuggestions.id, suggestionId));

    results.push({ suggestionId, introRequestId: introRequest.id });
  }

  const approved = results.filter(r => r.introRequestId).length;
  const failed = results.filter(r => r.error).length;

  return c.json({ approved, failed, results });
});

// --- Suggestion Expiration ---

// Expire stale suggestions (called on startup and every 6 hours)
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
