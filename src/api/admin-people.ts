import { Hono } from 'hono';
import { eq, and, sql } from 'drizzle-orm';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import * as postmark from 'postmark';
import {
  db,
  founders,
  publicUsers,
  publicCompanies,
  founderLeads,
  aiInterviewInvites,
  peopleCaptures,
  peopleTags,
  peopleOverrides,
} from '../db/index.js';

const app = new Hono();

const postmarkClient = process.env.POSTMARK_API_KEY
  ? new postmark.ServerClient(process.env.POSTMARK_API_KEY)
  : null;

type UnifiedRow = {
  email: string;
  name: string | null;
  city: string | null;
  company: string | null;
  sources: string[];           // e.g. ['founder', 'public_user', 'capture:equity_calculator']
  tags: string[];
  firstSeenAt: string;
  lastTouchAt: string;
  // Admin-applied overrides on top of merged source data (notes is admin-only)
  override: { name: string | null; city: string | null; company: string | null; notes: string | null } | null;
  // Per-source detail for the drawer
  rawSources: Array<{ source: string; id: number; data: Record<string, unknown> }>;
};

const normEmail = (e: string | null | undefined) =>
  (e ?? '').trim().toLowerCase();

const earlier = (a: string, b: string) => (a < b ? a : b);
const later = (a: string, b: string) => (a > b ? a : b);

// Pull everyone from every source, key by lowercased email, return unioned rows.
app.get('/', async (c) => {
  const rowsByEmail = new Map<string, UnifiedRow>();

  const upsert = (email: string, partial: Partial<UnifiedRow>, sourceRaw: { source: string; id: number; data: Record<string, unknown> }) => {
    if (!email) return;
    const existing = rowsByEmail.get(email);
    if (!existing) {
      rowsByEmail.set(email, {
        email,
        name: partial.name ?? null,
        city: partial.city ?? null,
        company: partial.company ?? null,
        sources: [sourceRaw.source],
        tags: [],
        firstSeenAt: partial.firstSeenAt ?? '',
        lastTouchAt: partial.lastTouchAt ?? '',
        override: null,
        rawSources: [sourceRaw],
      });
      return;
    }
    if (!existing.name && partial.name) existing.name = partial.name;
    if (!existing.city && partial.city) existing.city = partial.city;
    if (!existing.company && partial.company) existing.company = partial.company;
    if (!existing.sources.includes(sourceRaw.source)) existing.sources.push(sourceRaw.source);
    existing.rawSources.push(sourceRaw);
    if (partial.firstSeenAt) existing.firstSeenAt = existing.firstSeenAt ? earlier(existing.firstSeenAt, partial.firstSeenAt) : partial.firstSeenAt;
    if (partial.lastTouchAt) existing.lastTouchAt = existing.lastTouchAt ? later(existing.lastTouchAt, partial.lastTouchAt) : partial.lastTouchAt;
  };

  // 1. Founders (portfolio + active)
  const founderRows = await db.select().from(founders);
  for (const f of founderRows) {
    const email = normEmail(f.email);
    if (!email) continue;
    upsert(email, {
      name: f.name,
      city: f.city,
      company: f.companyName,
      firstSeenAt: f.createdAt,
      lastTouchAt: f.createdAt,
    }, { source: 'founder', id: f.id, data: { name: f.name, companyName: f.companyName, companyStage: f.companyStage, roundStatus: f.roundStatus, city: f.city, country: f.country } });
  }

  // 2. Public users — network signups (could be founders, nodes, investors, other)
  const publicRows = await db.select().from(publicUsers);
  for (const u of publicRows) {
    const email = normEmail(u.email);
    if (!email) continue;
    const name = [u.firstName, u.lastName].filter(Boolean).join(' ') || null;
    upsert(email, {
      name,
      city: u.city,
      firstSeenAt: u.createdAt,
      lastTouchAt: u.createdAt,
    }, { source: 'public_user', id: u.id, data: { name, role: u.role, status: u.status, oneLiner: u.oneLiner, city: u.city, linkedinUrl: u.linkedinUrl } });
  }

  // 3. Founder leads — inbound onboarding chat / blurb-builder applicants
  const leadRows = await db.select().from(founderLeads);
  for (const l of leadRows) {
    const email = normEmail(l.email);
    if (!email) continue;
    const name = [l.firstName, l.lastName].filter(Boolean).join(' ') || null;
    upsert(email, {
      name,
      company: l.companyName,
      firstSeenAt: l.createdAt,
      lastTouchAt: l.completedAt || l.createdAt,
    }, { source: 'founder_lead', id: l.id, data: { name, companyName: l.companyName, sector: l.sector, companyStage: l.companyStage, oneLiner: l.oneLiner, status: l.status, leadSource: l.source } });
  }

  // 4. People captures — lead magnets. Source includes the magnet name.
  const captureRows = await db.select().from(peopleCaptures);
  for (const cap of captureRows) {
    const email = normEmail(cap.email);
    if (!email) continue;
    upsert(email, {
      name: cap.name,
      city: cap.city,
      firstSeenAt: cap.capturedAt,
      lastTouchAt: cap.capturedAt,
    }, { source: `capture:${cap.source}`, id: cap.id, data: { source: cap.source, metadata: cap.metadata ? safeJson(cap.metadata) : null, autoEmailedAt: cap.autoEmailedAt } });
  }

  // 5. Attach tags to whoever has them.
  const tagRows = await db.select().from(peopleTags);
  for (const t of tagRows) {
    const email = normEmail(t.email);
    const row = rowsByEmail.get(email);
    if (!row) continue;
    if (!row.tags.includes(t.tag)) row.tags.push(t.tag);
  }

  // 6. Apply overrides on top of merged source data. Non-destructive — source
  // tables are untouched; we just surface the admin-edited values.
  const overrideRows = await db.select().from(peopleOverrides);
  for (const o of overrideRows) {
    const email = normEmail(o.email);
    const row = rowsByEmail.get(email);
    if (!row) continue;
    row.override = {
      name: o.name ?? null,
      city: o.city ?? null,
      company: o.company ?? null,
      notes: o.notes ?? null,
    };
    if (o.name) row.name = o.name;
    if (o.city) row.city = o.city;
    if (o.company) row.company = o.company;
  }

  // Sort by lastTouchAt desc, falling back to firstSeenAt.
  const rows = [...rowsByEmail.values()].sort((a, b) => {
    const at = a.lastTouchAt || a.firstSeenAt || '';
    const bt = b.lastTouchAt || b.firstSeenAt || '';
    return bt.localeCompare(at);
  });

  return c.json({ rows });
});

// Add a tag to a person (by email).
const addTagSchema = z.object({
  email: z.string().email(),
  tag: z.string().min(1).max(64),
});

app.post('/tags', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = addTagSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const email = parsed.data.email.toLowerCase().trim();
  const tag = parsed.data.tag.trim();

  const existing = await db.query.peopleTags.findFirst({
    where: and(eq(peopleTags.email, email), eq(peopleTags.tag, tag)),
  });
  if (existing) return c.json({ ok: true, isNew: false });

  await db.insert(peopleTags).values({
    email,
    tag,
    createdAt: new Date().toISOString(),
  });
  return c.json({ ok: true, isNew: true }, 201);
});

// Remove a tag from a person.
app.delete('/tags', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = addTagSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const email = parsed.data.email.toLowerCase().trim();
  const tag = parsed.data.tag.trim();

  await db.delete(peopleTags).where(and(eq(peopleTags.email, email), eq(peopleTags.tag, tag)));
  return c.json({ ok: true });
});

// Save (upsert) admin overrides for a person. Empty string clears that field.
const overrideSchema = z.object({
  email: z.string().email(),
  name: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  company: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});

app.put('/overrides', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = overrideSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const email = parsed.data.email.toLowerCase().trim();
  const norm = (v: string | null | undefined) => {
    if (v === null || v === undefined) return null;
    const t = String(v).trim();
    return t === '' ? null : t;
  };
  const fields = {
    name: norm(parsed.data.name),
    city: norm(parsed.data.city),
    company: norm(parsed.data.company),
    notes: norm(parsed.data.notes),
    updatedAt: new Date().toISOString(),
  };

  const existing = await db.query.peopleOverrides.findFirst({
    where: eq(peopleOverrides.email, email),
  });

  if (existing) {
    await db.update(peopleOverrides).set(fields).where(eq(peopleOverrides.email, email));
  } else {
    await db.insert(peopleOverrides).values({ email, ...fields });
  }
  return c.json({ ok: true, override: { ...fields, email } });
});

// Distinct tags across all people — used to populate the tag-filter dropdown.
app.get('/tags', async (c) => {
  const all = await db.select({ tag: peopleTags.tag }).from(peopleTags);
  const set = new Set(all.map(r => r.tag));
  return c.json({ tags: [...set].sort() });
});

const safeJson = (s: string): unknown => {
  try { return JSON.parse(s); } catch { return s; }
};

// ============ AI-VC interview invite ============
// Proactively invite someone to talk to the AI VC — the optional interview
// step, triggered from admin instead of only appearing after a full
// application. Two entry points:
//   { companyId } — from the Signups/Applications page (applicant already has a
//                   public_company; we invite them straight into the flow).
//   { email }     — from the People/Leads directory (a lead Mat is interested
//                   in; we resolve or create a minimal public_company).
// Either way we email a tokenized link to /onboarding, which runs the full
// "how we work" flow: connect Granola (Mat's partner link) → talk to the AI VC
// → get feedback. The AI-VC call reuses the existing /api/public/vc endpoints.
const aiInterviewSchema = z
  .object({
    email: z.string().email().optional(),
    companyId: z.number().int().positive().optional(),
  })
  .refine((d) => d.email || d.companyId, { message: 'email or companyId is required' });

app.post('/ai-interview', async (c) => {
  const parsed = aiInterviewSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'A valid email or companyId is required' }, 400);

  let publicCompanyId: number | null = null;
  let email = '';
  let firstName: string | null = null;
  let leadId: number | null = null;

  if (parsed.data.companyId) {
    // Applicant path — the public_company already exists.
    const company = await db.query.publicCompanies.findFirst({
      where: eq(publicCompanies.id, parsed.data.companyId),
    });
    if (!company) return c.json({ error: 'Application not found' }, 404);
    const user = await db.query.publicUsers.findFirst({ where: eq(publicUsers.id, company.userId) });
    if (!user?.email) return c.json({ error: 'This applicant has no email on file' }, 400);
    publicCompanyId = company.id;
    email = normEmail(user.email);
    firstName = user.firstName || null;
    const lead = await db.query.founderLeads.findFirst({ where: eq(founderLeads.email, email) });
    if (lead) { leadId = lead.id; firstName = lead.firstName || firstName; }
  } else {
    // Lead path — resolve or create a minimal public_company to anchor the call.
    email = normEmail(parsed.data.email!);
    const lead = await db.query.founderLeads.findFirst({ where: eq(founderLeads.email, email) });
    leadId = lead?.id ?? null;
    firstName = lead?.firstName ?? null;

    publicCompanyId = lead?.publicCompanyId ?? null;
    if (publicCompanyId) {
      const exists = await db.query.publicCompanies.findFirst({ where: eq(publicCompanies.id, publicCompanyId) });
      if (!exists) publicCompanyId = null;
    }

    if (!publicCompanyId) {
      let user = await db.query.publicUsers.findFirst({ where: eq(publicUsers.email, email) });
      if (!user) {
        const [inserted] = await db.insert(publicUsers).values({
          firstName: lead?.firstName || 'Founder',
          lastName: lead?.lastName || '',
          email,
          role: 'founder',
          status: 'pending',
          oneLiner: lead?.oneLiner || null,
          createdAt: new Date().toISOString(),
        }).returning();
        user = inserted;
      }
      if (!firstName) firstName = user.firstName || null;

      // Minimal company; application_status left null so it doesn't appear as a
      // submitted application — it only anchors the AI-VC call.
      let company = await db.query.publicCompanies.findFirst({ where: eq(publicCompanies.userId, user.id) });
      if (!company) {
        const [insertedCompany] = await db.insert(publicCompanies).values({
          userId: user.id,
          companyName: lead?.companyName || `${user.firstName}'s company`,
          oneLiner: lead?.oneLiner || null,
          sector: lead?.sector || null,
          createdAt: new Date().toISOString(),
        }).returning();
        company = insertedCompany;
      }
      publicCompanyId = company.id;

      if (lead && (!lead.publicUserId || !lead.publicCompanyId)) {
        await db.update(founderLeads)
          .set({ publicUserId: user.id, publicCompanyId })
          .where(eq(founderLeads.id, lead.id));
      }
    }
  }

  // Issue the invite token and email the link.
  const token = randomBytes(24).toString('hex');
  const now = new Date().toISOString();
  await db.insert(aiInterviewInvites).values({
    token,
    founderLeadId: leadId,
    publicCompanyId,
    email,
    persona: 'gp',
    status: 'sent',
    sentAt: now,
    createdAt: now,
  });

  const baseUrl = process.env.BASE_URL || 'https://matcap.vc';
  const inviteUrl = `${baseUrl}/onboarding?invite=${token}`;

  const sendResult = await sendInterviewInvite(email, firstName, inviteUrl);
  if (!sendResult.sent) {
    console.error('[admin-people] AI interview invite email not sent:', sendResult.error);
  }

  // Return the invite regardless (the link works even if email didn't send),
  // but surface WHY it didn't send so admin isn't left guessing.
  return c.json({ ok: true, inviteUrl, to: email, emailed: sendResult.sent, emailError: sendResult.error });
});

async function sendInterviewInvite(
  email: string,
  firstName: string | null,
  inviteUrl: string,
): Promise<{ sent: boolean; error?: string }> {
  if (!postmarkClient) {
    return { sent: false, error: 'POSTMARK_API_KEY is not set in this environment.' };
  }
  const from = process.env.POSTMARK_FROM_EMAIL || 'mat@matsherman.com';
  const greeting = firstName ? `Hi ${firstName},` : 'Hi,';
  try {
    const res = await postmarkClient.sendEmail({
      From: from,
      To: email,
      ReplyTo: 'mat@matsherman.com',
      Subject: 'Your AI VC interview with MatCap',
      TextBody:
        `${greeting}\n\n` +
        `I'd love for you to talk to our fine-tuned AI VC — a short live video conversation ` +
        `about you and your raise. It's the fastest way for us to get a feel for your story, ` +
        `and you'll get honest feedback on your pitch either way.\n\n` +
        `Two quick steps when you open the link:\n` +
        `  1. Connect Granola (free first month through our link) so it can take notes on the call — ` +
        `this is how we coach you on your real investor calls too. Get it here: https://www.granola.ai?via=mat-sherman\n` +
        `  2. Jump into the video call with the AI VC.\n\n` +
        `Important: we can only evaluate your interview if you run Granola on the call and send us the ` +
        `transcript right after. It's a key part of how we work — so getting into the motion of doing it ` +
        `now is what matters.\n\n` +
        `Start whenever you're ready:\n${inviteUrl}\n\n` +
        `Grab a quiet room — it's a real video call with camera + mic, about 8 minutes.\n\n` +
        `— Mat`,
    });
    // Postmark returns 200 with a non-zero ErrorCode for some soft failures.
    if (res.ErrorCode && res.ErrorCode !== 0) {
      return { sent: false, error: `Postmark ${res.ErrorCode}: ${res.Message}` };
    }
    return { sent: true };
  } catch (e: any) {
    // Postmark client throws on hard errors (e.g. 406 inactive recipient,
    // 300 invalid/unconfirmed From address). Pass the reason through.
    const code = e?.code ?? e?.ErrorCode;
    const msg = e?.message || 'Unknown send error';
    return { sent: false, error: code ? `Postmark ${code}: ${msg}` : msg };
  }
}

export default app;
