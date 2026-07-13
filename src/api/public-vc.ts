/**
 * Public applicant AI-VC call — a founder who just applied has a live Tavus
 * video conversation with our AI VC as part of their application. No login
 * required; the call is scoped to the public_company they applied as, and the
 * transcript is stored so we can send feedback afterward.
 *
 * Mounted at /api/public/vc.
 *   POST /start     { publicCompanyId }        -> { conversationId, conversationUrl }
 *   POST /complete  { conversationId }         -> { status: 'completed' | 'processing' }
 */

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, applicantVcCalls, applicantTranscripts, publicCompanies, publicUsers } from '../db/index.js';
import { z } from 'zod';
import * as postmark from 'postmark';
import { createConversation, getConversation, formatTranscript } from '../services/tavus.js';
import { enabledPersonas, getPersona } from '../services/gym-personas.js';

const app = new Hono();

const postmarkClient = process.env.POSTMARK_API_KEY
  ? new postmark.ServerClient(process.env.POSTMARK_API_KEY)
  : null;

// Cap the applicant call so a public endpoint can't run up Tavus cost.
const MAX_CALL_SECS = 8 * 60;

const startSchema = z.object({ publicCompanyId: z.number().int().positive() });

// Start (or resume) the applicant's AI-VC call.
app.post('/start', async (c) => {
  const parsed = startSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'publicCompanyId is required' }, 400);
  const publicCompanyId = parsed.data.publicCompanyId;

  const company = await db.query.publicCompanies.findFirst({
    where: eq(publicCompanies.id, publicCompanyId),
  });
  if (!company) return c.json({ error: 'Application not found' }, 404);

  // If they already finished a call, don't start another — return the done state.
  const existing = await db.query.applicantVcCalls.findFirst({
    where: eq(applicantVcCalls.publicCompanyId, publicCompanyId),
  });
  if (existing?.status === 'completed') {
    return c.json({ alreadyCompleted: true }, 200);
  }

  const persona = getPersona('gp') || enabledPersonas()[0];
  if (!persona) return c.json({ error: 'No AI VC persona configured' }, 503);

  let conv;
  try {
    conv = await createConversation({
      palId: persona.tavusPalId,
      faceId: persona.tavusFaceId,
      // Attribution: "apply|<publicCompanyId>|<persona>" — verified on /complete.
      conversationName: `apply|${publicCompanyId}|${persona.key}`,
      maxCallDurationSecs: MAX_CALL_SECS,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[public-vc] createConversation failed:', message);
    return c.json({ error: 'Could not start the AI VC call' }, 502);
  }

  await db.insert(applicantVcCalls).values({
    publicCompanyId,
    conversationId: conv.conversationId,
    conversationUrl: conv.conversationUrl,
    persona: persona.key,
    status: 'started',
    createdAt: new Date().toISOString(),
  });

  return c.json({
    conversationId: conv.conversationId,
    conversationUrl: conv.conversationUrl,
    persona: persona.key,
  }, 201);
});

const completeSchema = z.object({ conversationId: z.string().min(1) });

// Finish the call: pull the transcript from Tavus, store it, notify admin.
// Idempotent, and returns 202 { status: 'processing' } while Tavus is still
// preparing the transcript so the client can retry.
app.post('/complete', async (c) => {
  const parsed = completeSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'conversationId is required' }, 400);
  const conversationId = parsed.data.conversationId;

  const call = await db.query.applicantVcCalls.findFirst({
    where: eq(applicantVcCalls.conversationId, conversationId),
  });
  if (!call) return c.json({ error: 'Call not found' }, 404);
  if (call.status === 'completed') return c.json({ status: 'completed' });

  let fetched;
  try {
    fetched = await getConversation(conversationId);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[public-vc] fetch transcript failed:', message);
    return c.json({ error: message }, 502);
  }

  // Guard: this conversation must belong to this application.
  const parts = (fetched.conversationName || '').split('|');
  if (parts[0] !== 'apply' || Number(parts[1]) !== call.publicCompanyId) {
    return c.json({ error: 'Not found' }, 404);
  }

  // Transcript not ready yet (or no speech) — tell the client to retry.
  if (!fetched.turns || fetched.turns.length === 0) return c.json({ status: 'processing' }, 202);
  const transcript = formatTranscript(fetched.turns);
  if (!transcript.trim()) return c.json({ status: 'processing' }, 202);

  await db
    .update(applicantVcCalls)
    .set({ status: 'completed', transcript, completedAt: new Date().toISOString() })
    .where(eq(applicantVcCalls.id, call.id));

  // Notify admin so a human can send feedback on the application.
  notifyAdmin(call.publicCompanyId, 'call', transcript).catch((e) =>
    console.error('[public-vc] admin notify failed:', e instanceof Error ? e.message : e),
  );

  return c.json({ status: 'completed' });
});

// Closes the Granola loop: after the AI-VC call, the founder pastes a real
// investor-call transcript so we can coach them on it.
const transcriptSchema = z.object({
  publicCompanyId: z.number().int().positive(),
  transcript: z.string().min(40, 'Please paste the full transcript'),
  title: z.string().max(200).optional(),
});

app.post('/transcript', async (c) => {
  const parsed = transcriptSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues.map((i) => i.message).join(', ') }, 400);
  }
  const { publicCompanyId, transcript, title } = parsed.data;

  const company = await db.query.publicCompanies.findFirst({
    where: eq(publicCompanies.id, publicCompanyId),
  });
  if (!company) return c.json({ error: 'Application not found' }, 404);

  await db.insert(applicantTranscripts).values({
    publicCompanyId,
    title: title?.trim() || null,
    transcript,
    createdAt: new Date().toISOString(),
  });

  notifyAdmin(publicCompanyId, 'transcript', transcript, title?.trim() || undefined).catch((e) =>
    console.error('[public-vc] transcript notify failed:', e instanceof Error ? e.message : e),
  );

  return c.json({ success: true });
});

async function notifyAdmin(
  publicCompanyId: number,
  kind: 'call' | 'transcript',
  transcript: string,
  title?: string,
): Promise<void> {
  if (!postmarkClient) return;
  const company = await db.query.publicCompanies.findFirst({
    where: eq(publicCompanies.id, publicCompanyId),
  });
  const user = company
    ? await db.query.publicUsers.findFirst({ where: eq(publicUsers.id, company.userId) })
    : null;
  const fullName = user ? `${user.firstName || ''} ${user.lastName || ''}`.trim() : '';
  const who = `${fullName || 'A founder'}${company ? ` (${company.companyName})` : ''}`;
  const admin = process.env.POSTMARK_FROM_EMAIL || 'mat@matsherman.com';
  const snippet = transcript.length > 4000 ? transcript.slice(0, 4000) + '\n…(truncated)' : transcript;

  const subject =
    kind === 'call'
      ? `🎙️ AI VC call complete — ${who}`
      : `📝 Investor-call transcript submitted — ${who}`;
  const intro =
    kind === 'call'
      ? `${who} just finished their AI VC call as part of their application.`
      : `${who} submitted a real investor-call transcript${title ? ` ("${title}")` : ''} for coaching.`;

  await postmarkClient.sendEmail({
    From: admin,
    To: admin,
    Subject: subject,
    TextBody:
      `${intro}\n\n` +
      `Review it and send them feedback.\n\n` +
      `Application company id: ${publicCompanyId}\n\n` +
      `--- Transcript ---\n${snippet}`,
  });
}

export default app;
