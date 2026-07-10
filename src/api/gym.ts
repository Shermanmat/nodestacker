import { Hono } from 'hono';
import { z } from 'zod';
import { desc, eq, and, isNotNull } from 'drizzle-orm';
import { db, mockCallAnalyses } from '../db/index.js';
import { getSessionFounderId } from './auth.js';
import { enabledPersonas, personaPublic, getPersona } from '../services/gym-personas.js';
import { getGymStatus } from '../services/gym.js';
import { applyGymReward } from '../services/treadmill.js';
import { analyzeMockCall } from '../services/mock-call-analyzer.js';
import { createConversation, getConversation, formatTranscript } from '../services/tavus.js';

const GYM_MAX_CALL_SECS = 15 * 60; // cap each practice rep at 15 minutes

type Variables = { founderId: number };
const app = new Hono<{ Variables: Variables }>();

// Founder session auth (same pattern as the founder portal).
app.use('*', async (c, next) => {
  const founderId = await getSessionFounderId(c.req.header('X-Session-Id'));
  if (!founderId) return c.json({ error: 'Unauthorized' }, 401);
  c.set('founderId', founderId);
  await next();
});

function hydrate(row: any) {
  return {
    ...row,
    scorecard: row.scorecard ? JSON.parse(row.scorecard) : [],
    blindSpots: row.blindSpots ? JSON.parse(row.blindSpots) : [],
    coaching: row.coaching ? JSON.parse(row.coaching) : [],
  };
}

// Gym home: available personas, this founder's quota, and their rep history.
app.get('/', async (c) => {
  const founderId = c.get('founderId');
  const status = await getGymStatus(founderId);
  const reps = await db.select().from(mockCallAnalyses)
    .where(and(eq(mockCallAnalyses.founderId, founderId), isNotNull(mockCallAnalyses.persona)))
    .orderBy(desc(mockCallAnalyses.id));
  return c.json({
    personas: enabledPersonas().map(personaPublic),
    ...status,
    reps: reps.map(r => ({
      id: r.id, persona: r.persona, overallScore: r.overallScore, summary: r.summary, createdAt: r.createdAt,
    })),
  });
});

// One of the founder's reps, full readout (scoped to them).
app.get('/reps/:id', async (c) => {
  const founderId = c.get('founderId');
  const id = parseInt(c.req.param('id'));
  const row = await db.query.mockCallAnalyses.findFirst({ where: eq(mockCallAnalyses.id, id) });
  if (!row || row.founderId !== founderId) return c.json({ error: 'Not found' }, 404);
  return c.json(hydrate(row));
});

const startSchema = z.object({ persona: z.string().min(1) });

// Start a rep: create a Tavus AI-VC conversation and return the join URL.
// Quota is checked here so a founder can't spin up calls they can't afford.
app.post('/conversations', async (c) => {
  const founderId = c.get('founderId');
  const parsed = startSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.issues.map(i => i.message).join(', ') }, 400);
  const persona = getPersona(parsed.data.persona);
  if (!persona || !persona.enabled) return c.json({ error: 'Unknown persona' }, 400);

  const status = await getGymStatus(founderId);
  if (status.repsRemaining <= 0) return c.json({ error: 'No gym reps remaining', ...status }, 403);

  try {
    const conv = await createConversation({
      palId: persona.tavusPalId,
      faceId: persona.tavusFaceId,
      // Attribution rides in the name — the complete step parses it back.
      conversationName: `gym|${founderId}|${persona.key}`,
      maxCallDurationSecs: GYM_MAX_CALL_SECS,
    });
    return c.json({ conversationId: conv.conversationId, conversationUrl: conv.conversationUrl, persona: persona.key }, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[gym] start conversation failed:', message);
    return c.json({ error: message }, 502);
  }
});

const completeSchema = z.object({ conversationId: z.string().min(1) });

// Complete a rep: pull the transcript from Tavus by conversation id, then analyze.
// Idempotent — a repeat call for the same conversation returns the existing rep.
app.post('/reps/complete', async (c) => {
  const founderId = c.get('founderId');
  const parsed = completeSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.issues.map(i => i.message).join(', ') }, 400);
  const conversationId = parsed.data.conversationId;

  // Already analyzed? Return it (no double-charge).
  const existing = await db.query.mockCallAnalyses.findFirst({ where: eq(mockCallAnalyses.tavusConversationId, conversationId) });
  if (existing) {
    if (existing.founderId !== founderId) return c.json({ error: 'Not found' }, 404);
    return c.json(hydrate(existing));
  }

  let fetched;
  try {
    fetched = await getConversation(conversationId);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[gym] fetch transcript failed:', message);
    return c.json({ error: message }, 502);
  }

  // Attribution: conversation_name is "gym|<founderId>|<persona>". Guard that this
  // conversation belongs to the calling founder before we do anything with it.
  const parts = (fetched.conversationName || '').split('|');
  if (parts[0] !== 'gym' || Number(parts[1]) !== founderId) return c.json({ error: 'Not found' }, 404);
  const persona = parts[2] || undefined;

  if (!fetched.turns || fetched.turns.length === 0) {
    // Transcript not ready yet (or the call had no speech) — tell the client to retry.
    return c.json({ status: 'processing' }, 202);
  }
  const transcript = formatTranscript(fetched.turns);
  if (!transcript.trim()) return c.json({ status: 'processing' }, 202);

  const status = await getGymStatus(founderId);
  if (status.repsRemaining <= 0) return c.json({ error: 'No gym reps remaining', ...status }, 403);

  try {
    const result = await analyzeMockCall({ transcript, founderId, persona, tavusConversationId: conversationId });
    if (!result) return c.json({ error: 'Analyzer unavailable (ANTHROPIC_API_KEY not set)' }, 503);
    // Treadmill reward: completing a rep ratchets up the founder's weekly
    // intro-request allowance. Never let a reward hiccup fail the rep response.
    try { await applyGymReward(founderId); } catch (e) { console.error('[gym] treadmill reward failed:', e); }
    const row = await db.query.mockCallAnalyses.findFirst({ where: eq(mockCallAnalyses.id, result.id) });
    return c.json(hydrate(row), 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[gym] complete rep failed:', message);
    return c.json({ error: message }, 500);
  }
});

const repSchema = z.object({ persona: z.string().min(1), transcript: z.string().min(1) });

// Log a completed rep — the transcript from the Tavus conversation — then analyze
// and store it. Enforces the founder's remaining quota.
app.post('/reps', async (c) => {
  const founderId = c.get('founderId');
  const parsed = repSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.issues.map(i => i.message).join(', ') }, 400);
  if (!getPersona(parsed.data.persona)) return c.json({ error: 'Unknown persona' }, 400);

  const status = await getGymStatus(founderId);
  if (status.repsRemaining <= 0) return c.json({ error: 'No gym reps remaining', ...status }, 403);

  try {
    const result = await analyzeMockCall({ transcript: parsed.data.transcript, founderId, persona: parsed.data.persona });
    if (!result) return c.json({ error: 'Analyzer unavailable (ANTHROPIC_API_KEY not set)' }, 503);
    try { await applyGymReward(founderId); } catch (e) { console.error('[gym] treadmill reward failed:', e); }
    const row = await db.query.mockCallAnalyses.findFirst({ where: eq(mockCallAnalyses.id, result.id) });
    return c.json(hydrate(row), 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[gym] rep failed:', message);
    return c.json({ error: message }, 500);
  }
});

export default app;
