import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  db,
  trials,
  founders,
  introRequests,
  founderInvestorRecords,
  investorInteractions,
  portfolioCompanies,
} from '../db/index.js';

const app = new Hono();

const TRIAL_DAYS = 14;

// Intro statuses that mean the intro actually went out to the investor.
const INTRODUCED = ['introduced', 'meeting_scheduled', 'in_discussions', 'invested'];
const MEETING = ['meeting_scheduled', 'in_discussions', 'invested'];
// Anything past the suggestion stage counts as a request we acted on.
const ACTED = ['intro_request_sent', 'waiting_on_node', ...INTRODUCED, 'passed', 'ignored'];

const afterStart = (ts: string | null | undefined, start: string) =>
  !!ts && new Date(ts).getTime() >= new Date(start).getTime();

// Auto-measured signals for a trial, computed live from intro_requests + the
// founder's CRM activity within the trial window. Nothing here is stored.
async function computeMetrics(t: typeof trials.$inferSelect) {
  const intros = await db.query.introRequests.findMany({
    where: eq(introRequests.founderId, t.founderId),
  });
  const inWindow = intros.filter((i) => afterStart(i.createdAt, t.startDate));
  const requested = inWindow.filter((i) => ACTED.includes(i.status));
  const introduced = inWindow.filter((i) => INTRODUCED.includes(i.status));
  const meetings = inWindow.filter((i) => MEETING.includes(i.status));
  const replies = inWindow.filter((i) => !!i.replyDetectedAt);

  const records = (await db.query.founderInvestorRecords.findMany({
    where: eq(founderInvestorRecords.founderId, t.founderId),
  })).filter((r) => afterStart(r.createdAt, t.startDate));
  const interactions = (await db.query.investorInteractions.findMany({
    where: eq(investorInteractions.founderId, t.founderId),
  })).filter((i) => afterStart(i.createdAt, t.startDate));

  const activityStamps = [
    ...records.map((r) => r.createdAt),
    ...interactions.map((i) => i.createdAt),
  ].filter(Boolean) as string[];
  const lastActiveAt = activityStamps.length
    ? activityStamps.reduce((a, b) => (new Date(a) > new Date(b) ? a : b))
    : null;

  return {
    introsRequested: requested.length,
    introduced: introduced.length,
    meetings: meetings.length,
    replies: replies.length,
    replyRate: introduced.length ? Math.round((replies.length / introduced.length) * 100) : 0,
    crmRecordsAdded: records.length,
    crmInteractionsLogged: interactions.length,
    lastActiveAt,
  };
}

// Average of whatever ratings have been filled in (1–5), or null if none yet.
function composite(t: typeof trials.$inferSelect): number | null {
  const scores = [
    t.scoreFounderActivity,
    t.scoreCommsQuality,
    t.scoreMindset,
    t.scoreInvestorSentiment,
    t.scoreFollowThrough,
  ].filter((s): s is number => typeof s === 'number');
  if (!scores.length) return null;
  return Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10;
}

const daysLeft = (endDate: string) =>
  Math.ceil((new Date(endDate).getTime() - Date.now()) / (24 * 60 * 60 * 1000));

// List all trials with founder, computed metrics + composite.
app.get('/', async (c) => {
  const all = await db.query.trials.findMany({
    with: { founder: true },
    orderBy: (trials, { desc }) => [desc(trials.createdAt)],
  });
  const enriched = await Promise.all(
    all.map(async (t) => ({
      ...t,
      metrics: await computeMetrics(t),
      composite: composite(t),
      daysLeft: daysLeft(t.endDate),
      decisionDue: t.status === 'active' && daysLeft(t.endDate) <= 0,
    })),
  );
  return c.json({ trials: enriched });
});

// Founders eligible to start a trial: not already in an active trial,
// not already a portfolio company.
app.get('/eligible/founders', async (c) => {
  const all = await db.select().from(founders);
  const activeIds = new Set(
    (await db.query.trials.findMany())
      .filter((t) => ['active', 'offer_made'].includes(t.status))
      .map((t) => t.founderId),
  );
  const portfolio = await db.select({ founderId: portfolioCompanies.founderId }).from(portfolioCompanies);
  const portfolioIds = new Set(portfolio.map((p) => p.founderId));
  const eligible = all.filter((f) => !activeIds.has(f.id) && !portfolioIds.has(f.id) && !f.hidden);
  return c.json(eligible);
});

// Single trial detail.
app.get('/:id', async (c) => {
  const id = parseInt(c.req.param('id'));
  const t = await db.query.trials.findFirst({
    where: eq(trials.id, id),
    with: { founder: true },
  });
  if (!t) return c.json({ error: 'Trial not found' }, 404);
  return c.json({
    ...t,
    metrics: await computeMetrics(t),
    composite: composite(t),
    daysLeft: daysLeft(t.endDate),
  });
});

const startSchema = z.object({
  founderId: z.number(),
  introTargetMin: z.number().min(1).max(50).optional(),
  introTargetMax: z.number().min(1).max(50).optional(),
  days: z.number().min(1).max(60).optional(),
});

// Start a trial. Flips the founder's cadence on so the intro machinery engages.
app.post('/', async (c) => {
  const parsed = startSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);

  const founder = await db.query.founders.findFirst({ where: eq(founders.id, parsed.data.founderId) });
  if (!founder) return c.json({ error: 'Founder not found' }, 404);

  const existing = await db.query.trials.findMany({ where: eq(trials.founderId, parsed.data.founderId) });
  if (existing.some((t) => ['active', 'offer_made'].includes(t.status))) {
    return c.json({ error: 'This founder already has an open trial' }, 400);
  }

  const now = new Date();
  const end = new Date(now.getTime() + (parsed.data.days || TRIAL_DAYS) * 24 * 60 * 60 * 1000);
  const nowIso = now.toISOString();

  const [created] = await db.insert(trials).values({
    founderId: parsed.data.founderId,
    status: 'active',
    startDate: nowIso,
    endDate: end.toISOString(),
    introTargetMin: parsed.data.introTargetMin ?? 5,
    introTargetMax: parsed.data.introTargetMax ?? 15,
    createdAt: nowIso,
    updatedAt: nowIso,
  }).returning();

  // Engage the intro cadence for this founder.
  await db.update(founders).set({
    introCadenceActive: true,
    cadenceStartDate: nowIso.split('T')[0],
  }).where(eq(founders.id, parsed.data.founderId));

  return c.json(created, 201);
});

const scoreSchema = z.object({
  scoreFounderActivity: z.number().min(1).max(5).nullable().optional(),
  scoreCommsQuality: z.number().min(1).max(5).nullable().optional(),
  scoreMindset: z.number().min(1).max(5).nullable().optional(),
  scoreInvestorSentiment: z.number().min(1).max(5).nullable().optional(),
  scoreFollowThrough: z.number().min(1).max(5).nullable().optional(),
});

// Update the human-judgment scorecard.
app.put('/:id/scores', async (c) => {
  const id = parseInt(c.req.param('id'));
  const parsed = scoreSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
  const [updated] = await db.update(trials)
    .set({ ...parsed.data, updatedAt: new Date().toISOString() })
    .where(eq(trials.id, id))
    .returning();
  if (!updated) return c.json({ error: 'Trial not found' }, 404);
  return c.json(updated);
});

const decideSchema = z.object({
  decision: z.enum(['offer', 'pass']),
  notes: z.string().optional(),
});

// Make the offer (1%) or pass.
app.post('/:id/decide', async (c) => {
  const id = parseInt(c.req.param('id'));
  const parsed = decideSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);

  const t = await db.query.trials.findFirst({ where: eq(trials.id, id) });
  if (!t) return c.json({ error: 'Trial not found' }, 404);
  if (!['active', 'expired'].includes(t.status)) {
    return c.json({ error: `Trial already decided (status: ${t.status})` }, 400);
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const isPass = parsed.data.decision === 'pass';
  // On a pass, start the 14-day read-only CRM grace window.
  const accessRevokesAt = isPass
    ? new Date(now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000).toISOString()
    : null;

  const [updated] = await db.update(trials).set({
    decision: parsed.data.decision,
    decisionAt: nowIso,
    decisionNotes: parsed.data.notes || null,
    status: isPass ? 'passed' : 'offer_made',
    accessRevokesAt,
    updatedAt: nowIso,
  }).where(eq(trials.id, id)).returning();

  // On a pass, also turn off the intro cadence.
  if (isPass) {
    await db.update(founders).set({ introCadenceActive: false }).where(eq(founders.id, t.founderId));
  }
  return c.json(updated);
});

const respondSchema = z.object({ response: z.enum(['accepted', 'declined']) });

// Record the founder's response to the 1% offer. On accept, create the
// portfolio company; on decline, start the read-only grace window.
app.post('/:id/respond', async (c) => {
  const id = parseInt(c.req.param('id'));
  const parsed = respondSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);

  const t = await db.query.trials.findFirst({ where: eq(trials.id, id) });
  if (!t) return c.json({ error: 'Trial not found' }, 404);
  if (t.status !== 'offer_made') {
    return c.json({ error: `No open offer to respond to (status: ${t.status})` }, 400);
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const accepted = parsed.data.response === 'accepted';

  const [updated] = await db.update(trials).set({
    founderResponse: parsed.data.response,
    founderRespondedAt: nowIso,
    status: accepted ? 'offer_accepted' : 'offer_declined',
    accessRevokesAt: accepted
      ? null
      : new Date(now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000).toISOString(),
    updatedAt: nowIso,
  }).where(eq(trials.id, id)).returning();

  if (accepted) {
    // Create the portfolio company at the offered equity (idempotent).
    const exists = await db.query.portfolioCompanies.findFirst({
      where: eq(portfolioCompanies.founderId, t.founderId),
    });
    if (!exists) {
      await db.insert(portfolioCompanies).values({
        founderId: t.founderId,
        equityPercent: t.offerEquityPercent,
        investmentDate: nowIso.split('T')[0],
        createdAt: nowIso,
        updatedAt: nowIso,
      });
    }
  } else {
    await db.update(founders).set({ introCadenceActive: false }).where(eq(founders.id, t.founderId));
  }
  return c.json(updated);
});

// Delete a trial (cleanup).
app.delete('/:id', async (c) => {
  const id = parseInt(c.req.param('id'));
  const [deleted] = await db.delete(trials).where(eq(trials.id, id)).returning();
  if (!deleted) return c.json({ error: 'Trial not found' }, 404);
  return c.json({ success: true });
});

export default app;
