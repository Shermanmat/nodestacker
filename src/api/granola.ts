/**
 * Granola meeting-transcript ingest.
 *
 * Auth: `Authorization: Bearer <mcp token>` — the SAME per-founder token a
 * founder mints in the portal's Connect AI tab. The token resolves to one
 * founderId, so a transcript can only ever land in that founder's pipeline.
 *
 * Flow (POST /ingest): store raw transcript → match it to one of the founder's
 * pipeline investors + score the meeting (one LLM call) → conservatively apply:
 * on a confident match we log a 'meeting' touch, set the next action, and write
 * advisory scores onto the founder's active trial. Low-confidence / unmatched
 * transcripts are stored as needs_review and change nothing.
 *
 * This serves both Zapier (Granola → webhook) and manual paste-testing — same
 * endpoint, just POST { title, transcript, shareLink } with the bearer token.
 */

import { Hono } from 'hono';
import { eq, desc } from 'drizzle-orm';
import { db, meetingTranscripts, trials, founders } from '../db/index.js';
import { verifyToken } from '../services/mcp-tokens.js';
import { listInvestors, logTouch, updateInvestor, type PipelineItem } from '../services/pipeline-dao.js';
import { matchAndScoreMeeting } from '../services/meeting-scorer.js';

type Variables = { founderId: number };
const app = new Hono<{ Variables: Variables }>();

// Bearer MCP token → founderId on every route.
app.use('*', async (c, next) => {
  const header = c.req.header('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const founderId = await verifyToken(token);
  if (!founderId) return c.json({ error: 'Invalid or expired token' }, 401);
  c.set('founderId', founderId);
  await next();
});

const CONFIDENCE_FLOOR = 0.7;

// POST /ingest — accept a transcript, match + score it, conservatively apply.
app.post('/ingest', async (c) => {
  const founderId = c.get('founderId');
  const body = await c.req.json().catch(() => ({} as any));
  // Be liberal about field names — Zapier/Granola payloads vary.
  const title: string | null = body.title ?? body.meetingTitle ?? body.meeting_title ?? body.name ?? null;
  const transcript: string = body.transcript ?? body.notes ?? body.text ?? '';
  const shareLink: string | null = body.shareLink ?? body.share_link ?? body.url ?? null;

  if (!transcript || transcript.trim().length < 20) {
    return c.json({ error: 'Missing or too-short transcript' }, 400);
  }

  const now = new Date().toISOString();
  const [row] = await db.insert(meetingTranscripts).values({
    founderId, source: 'granola', meetingTitle: title, transcript, shareLink,
    matchStatus: 'pending', status: 'received', createdAt: now,
  }).returning();

  try {
    // Build the candidate set from THIS founder's pipeline.
    const founder = await db.query.founders.findFirst({ where: eq(founders.id, founderId) });
    const { items } = await listInvestors(founderId, { includeArchived: false, limit: 200 });
    const candidates = items.map((it: PipelineItem) => ({ pipelineId: it.id, name: it.investorName, firm: it.firm }));

    const result = await matchAndScoreMeeting({
      founderName: founder?.name ?? 'the founder',
      companyName: founder?.companyName ?? null,
      title, transcript, candidates,
    });

    // Decide what to do with it.
    const matchStatus = !result.isInvestorMeeting
      ? 'not_investor_meeting'
      : (result.matchedPipelineId && result.matchConfidence >= CONFIDENCE_FLOOR ? 'matched' : 'unmatched');

    let appliedAt: string | null = null;
    if (matchStatus === 'matched' && result.matchedPipelineId) {
      // Log the meeting as a touch on the matched pipeline item.
      try {
        await logTouch(founderId, result.matchedPipelineId, {
          interactionType: 'meeting',
          occurredAt: now,
          content: result.summary,
        });
        // Set the agreed next action (these fields are editable on both kinds).
        if (result.nextStep.text) {
          await updateInvestor(founderId, result.matchedPipelineId, {
            nextActionText: result.nextStep.text,
            nextActionDate: result.nextStep.date ?? undefined,
          } as any);
        }
        appliedAt = new Date().toISOString();
      } catch (e: any) {
        console.error('[granola] apply to pipeline failed:', e?.message || e);
      }

      // Advisory: write scores onto the founder's most recent trial.
      try {
        const trial = await db.query.trials.findFirst({
          where: eq(trials.founderId, founderId),
          orderBy: [desc(trials.createdAt)],
        });
        if (trial) {
          await db.update(trials).set({
            scoreCommsQuality: result.scores.comms_quality.value,
            scoreInvestorSentiment: result.scores.investor_sentiment.value,
            scoreFollowThrough: result.scores.follow_through.value,
            updatedAt: new Date().toISOString(),
          }).where(eq(trials.id, trial.id));
        }
      } catch (e: any) {
        console.error('[granola] trial score write failed:', e?.message || e);
      }
    }

    const [updated] = await db.update(meetingTranscripts).set({
      matchedPipelineId: result.matchedPipelineId,
      matchedInvestorName: result.matchedInvestorName,
      matchStatus,
      matchConfidence: String(result.matchConfidence),
      meetingType: result.meetingType,
      outcome: result.outcome,
      summary: result.summary,
      nextStepText: result.nextStep.text,
      nextStepDate: result.nextStep.date,
      scoreCommsQuality: result.scores.comms_quality.value,
      scoreInvestorSentiment: result.scores.investor_sentiment.value,
      scoreFollowThrough: result.scores.follow_through.value,
      scoreJson: JSON.stringify(result),
      status: matchStatus === 'matched' ? 'processed' : 'needs_review',
      appliedAt,
      processedAt: new Date().toISOString(),
    }).where(eq(meetingTranscripts.id, row.id)).returning();

    return c.json({ id: row.id, applied: matchStatus === 'matched', matchStatus, result, record: updated });
  } catch (e: any) {
    await db.update(meetingTranscripts).set({
      status: 'error', errorMessage: String(e?.message || e), processedAt: new Date().toISOString(),
    }).where(eq(meetingTranscripts.id, row.id));
    // 200 so Zapier doesn't retry-storm; the error is in the body + stored.
    return c.json({ id: row.id, error: 'Processing failed', detail: String(e?.message || e) });
  }
});

// GET /transcripts — recent transcripts for this founder.
app.get('/transcripts', async (c) => {
  const founderId = c.get('founderId');
  const rows = await db.query.meetingTranscripts.findMany({
    where: eq(meetingTranscripts.founderId, founderId),
    orderBy: [desc(meetingTranscripts.createdAt)],
    limit: 50,
  });
  return c.json({ items: rows });
});

// GET /transcripts/:id — one transcript (scoped to the founder).
app.get('/transcripts/:id', async (c) => {
  const founderId = c.get('founderId');
  const id = parseInt(c.req.param('id'));
  const row = await db.query.meetingTranscripts.findFirst({ where: eq(meetingTranscripts.id, id) });
  if (!row || row.founderId !== founderId) return c.json({ error: 'Not found' }, 404);
  return c.json(row);
});

export default app;
