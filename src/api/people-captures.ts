import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { db, peopleCaptures } from '../db/index.js';

const app = new Hono();

// Per-source auto-email config. Add an entry when you ship a new lead magnet
// that should trigger a follow-up email on capture. Source not listed here =
// silent capture (no email). Subject/html/text are interpolated with the
// captured fields ({{name}}, {{email}}, and any metadata key like {{equityPct}}).
const AUTO_EMAIL_CONFIGS: Record<string, { subject: string; html: string; text: string }> = {
  // Example placeholder — will be tuned when the actual equity calculator ships.
  equity_calculator: {
    subject: 'Your equity plan — and a quick offer',
    html: `<div style="font-family:Inter,system-ui,sans-serif;max-width:560px;color:#222">
      <p>Hey{{nameSpace}},</p>
      <p>Thanks for using the equity calculator. Your inputs are saved at the link you got on screen.</p>
      <p>If you'd like a 15-minute walkthrough — pricing tiers, what to grant your first hire, common mistakes — just reply to this email.</p>
      <p>— Mat<br/>MatCap</p>
    </div>`,
    text: `Hey{{nameSpace}},

Thanks for using the equity calculator. Your inputs are saved at the link you got on screen.

If you'd like a 15-minute walkthrough — pricing tiers, what to grant your first hire, common mistakes — just reply to this email.

— Mat
MatCap`,
  },
};

const interpolate = (template: string, vars: Record<string, string | undefined>): string => {
  return template.replace(/{{(\w+)}}/g, (_, key) => vars[key] ?? '');
};

const captureSchema = z.object({
  email: z.string().email(),
  name: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  source: z.string().min(1).max(64),
  metadata: z.record(z.unknown()).optional(),
});

// Public — no auth. Standalone lead magnet pages and inline email-capture
// widgets POST here to land the email in the unified people directory.
app.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = captureSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const { email, name, city, source, metadata } = parsed.data;
  const normalizedEmail = email.toLowerCase().trim();
  const metadataJson = metadata ? JSON.stringify(metadata) : null;

  // De-dupe on (email, source). If an existing row matches, refresh name/city
  // if newly provided but don't re-fire the auto-email.
  const existing = await db.query.peopleCaptures.findFirst({
    where: and(
      eq(peopleCaptures.email, normalizedEmail),
      eq(peopleCaptures.source, source),
    ),
  });

  if (existing) {
    const updates: Record<string, string | null> = {};
    if (name && !existing.name) updates.name = name;
    if (city && !existing.city) updates.city = city;
    if (metadataJson) updates.metadata = metadataJson;
    if (Object.keys(updates).length > 0) {
      await db.update(peopleCaptures).set(updates).where(eq(peopleCaptures.id, existing.id));
    }
    return c.json({ ok: true, isNew: false, id: existing.id });
  }

  const [created] = await db.insert(peopleCaptures).values({
    email: normalizedEmail,
    name: name ?? null,
    city: city ?? null,
    source,
    metadata: metadataJson,
    capturedAt: new Date().toISOString(),
  }).returning();

  // Auto-email hook. Only fires for sources with a config entry, and only on
  // the first capture for that (email, source). Failure to send is logged but
  // never breaks the capture — the lead is already saved.
  const config = AUTO_EMAIL_CONFIGS[source];
  if (config) {
    try {
      const { sendEmail } = await import('../services/email.js');
      const firstName = (name || '').trim().split(' ')[0];
      const vars: Record<string, string> = {
        name: name ?? '',
        firstName,
        nameSpace: firstName ? ' ' + firstName : '',
        email: normalizedEmail,
        ...(metadata ? Object.fromEntries(Object.entries(metadata).map(([k, v]) => [k, String(v)])) : {}),
      };
      await sendEmail({
        to: normalizedEmail,
        subject: interpolate(config.subject, vars),
        html: interpolate(config.html, vars),
        text: interpolate(config.text, vars),
      });
      await db.update(peopleCaptures)
        .set({ autoEmailedAt: new Date().toISOString() })
        .where(eq(peopleCaptures.id, created.id));
    } catch (e: any) {
      console.error('[people-captures] auto-email failed', source, normalizedEmail, e?.message);
    }
  }

  return c.json({ ok: true, isNew: true, id: created.id }, 201);
});

export default app;
