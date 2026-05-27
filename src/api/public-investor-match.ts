import { Hono } from 'hono';
import { eq, and, inArray } from 'drizzle-orm';
import { z } from 'zod';
import {
  db,
  investors,
  investorCategories,
  investorCategoryAssignments,
  peopleCaptures,
} from '../db/index.js';
import { classifyMatchFit, computeFitScore } from '../services/matching.js';

const app = new Hono();

// Cache the pre-seed stage category id. Looked up lazily on first request,
// kept for the life of the process. If the row is missing (unlikely — it's
// part of the seeded taxonomy) we silently omit the stage match.
let preSeedStageIdPromise: Promise<number | null> | null = null;
const getPreSeedStageId = async (): Promise<number | null> => {
  if (!preSeedStageIdPromise) {
    preSeedStageIdPromise = (async () => {
      const row = await db.select().from(investorCategories)
        .where(and(eq(investorCategories.type, 'stage'), eq(investorCategories.name, 'Pre-Seed')))
        .get();
      return row?.id ?? null;
    })();
  }
  return preSeedStageIdPromise;
};

const schema = z.object({
  name: z.string().min(1).max(120),
  companyName: z.string().min(1).max(120),
  oneLiner: z.string().min(1).max(280),
  websiteUrl: z.string().url().nullable().optional().or(z.literal('')),
  linkedinUrl: z.string().url(),
  city: z.string().min(1).max(120),
  sectorIds: z.array(z.number().int()).max(3).optional(),
  email: z.string().email(),
});

type Match = {
  id: number;
  name: string;
  firm: string | null;
  city: string | null;
  sectors: string[];
  stage: string | null;
  fitBucket: 'Strong' | 'Good' | 'Possible';
  fitReason: string;
};

const bucketFor = (score: number): Match['fitBucket'] => {
  // computeFitScore caps at 100. With our constants (medium=15, recency=0),
  // max possible is 15 + 25 (sector exact) + 10 (stage exact) + 5 (persona exact) = 55.
  // So buckets are tuned to that ceiling: 45+ = Strong, 30+ = Good, else Possible.
  if (score >= 45) return 'Strong';
  if (score >= 30) return 'Good';
  return 'Possible';
};

const buildFitReason = (inv: {
  firm: string | null;
  city: string | null;
  sectorNames: string[];
  hasStageMatch: boolean;
}): string => {
  const parts: string[] = [];
  if (inv.hasStageMatch) parts.push('Invests pre-seed');
  if (inv.sectorNames.length > 0) {
    const list = inv.sectorNames.slice(0, 2).join(' / ');
    parts.push(inv.hasStageMatch ? `in ${list}` : `Invests in ${list}`);
  }
  if (inv.city) parts.push(`based in ${inv.city}`);
  if (parts.length === 0) return inv.firm ? `Active investor at ${inv.firm}` : 'Active investor';
  return parts.join(' ') + '.';
};

app.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = schema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const input = parsed.data;
  const sectorIds = input.sectorIds ?? [];

  // Synthetic founder categories: pre-seed stage + supplied sectors.
  const preSeedId = await getPreSeedStageId();
  const founderCategories: { id: number; name: string; type: string }[] = [];
  if (preSeedId != null) founderCategories.push({ id: preSeedId, name: 'Pre-Seed', type: 'stage' });
  for (const id of sectorIds) founderCategories.push({ id, name: '', type: 'sector' });

  // Fetch all active investors with their category assignments. Join category
  // names so we can render sector chips and fit reasons.
  const activeInvestors = await db.select().from(investors).where(eq(investors.active, true));
  if (activeInvestors.length === 0) return c.json({ matches: [] });

  const investorIds = activeInvestors.map(i => i.id);
  const assignments = await db.select({
    investorId: investorCategoryAssignments.investorId,
    categoryId: investorCategoryAssignments.categoryId,
    name: investorCategories.name,
    type: investorCategories.type,
  })
    .from(investorCategoryAssignments)
    .leftJoin(investorCategories, eq(investorCategoryAssignments.categoryId, investorCategories.id))
    .where(inArray(investorCategoryAssignments.investorId, investorIds));

  const catsByInvestor = new Map<number, { id: number; name: string; type: string }[]>();
  for (const row of assignments) {
    if (!row.name || !row.type) continue;
    const arr = catsByInvestor.get(row.investorId) ?? [];
    arr.push({ id: row.categoryId, name: row.name, type: row.type });
    catsByInvestor.set(row.investorId, arr);
  }

  // Score each investor. Skip the hard gate entirely — public matcher always
  // returns top 10.
  const scored = activeInvestors.map(inv => {
    const invCats = catsByInvestor.get(inv.id) ?? [];
    const fit = classifyMatchFit(founderCategories, invCats);
    const score = computeFitScore('medium', fit, 0);
    return { inv, invCats, fit, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 10);

  const matches: Match[] = top.map(({ inv, invCats, fit, score }) => {
    const sectorNames = invCats.filter(c => c.type === 'sector').map(c => c.name);
    const stageNames = invCats.filter(c => c.type === 'stage').map(c => c.name);
    return {
      id: inv.id,
      name: inv.name,
      firm: inv.firm ?? null,
      city: inv.city ?? null,
      sectors: sectorNames,
      stage: stageNames[0] ?? null,
      fitBucket: bucketFor(score),
      fitReason: buildFitReason({
        firm: inv.firm ?? null,
        city: inv.city ?? null,
        sectorNames,
        hasStageMatch: fit.stage === 'exact',
      }),
    };
  });

  // Capture the lead. De-dupe on (email, source='investor_matcher') — if the
  // same email submits again we update the metadata in place.
  const email = input.email.toLowerCase().trim();
  const metadata = JSON.stringify({
    companyName: input.companyName,
    oneLiner: input.oneLiner,
    websiteUrl: input.websiteUrl || null,
    linkedinUrl: input.linkedinUrl,
    city: input.city,
    sectorIds,
  });
  try {
    const existing = await db.select().from(peopleCaptures)
      .where(and(eq(peopleCaptures.email, email), eq(peopleCaptures.source, 'investor_matcher')))
      .get();
    if (existing) {
      await db.update(peopleCaptures)
        .set({ name: input.name, city: input.city, metadata })
        .where(eq(peopleCaptures.id, existing.id));
    } else {
      await db.insert(peopleCaptures).values({
        email,
        name: input.name,
        city: input.city,
        source: 'investor_matcher',
        metadata,
        capturedAt: new Date().toISOString(),
      });
    }
  } catch (err) {
    console.error('[investor-match] capture failed:', err);
    // Don't fail the response — the founder should still get their matches.
  }

  return c.json({ matches });
});

export default app;
