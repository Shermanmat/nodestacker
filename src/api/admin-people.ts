import { Hono } from 'hono';
import { eq, and, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  db,
  founders,
  publicUsers,
  founderLeads,
  peopleCaptures,
  peopleTags,
} from '../db/index.js';

const app = new Hono();

type UnifiedRow = {
  email: string;
  name: string | null;
  city: string | null;
  company: string | null;
  sources: string[];           // e.g. ['founder', 'public_user', 'capture:equity_calculator']
  tags: string[];
  firstSeenAt: string;
  lastTouchAt: string;
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

// Distinct tags across all people — used to populate the tag-filter dropdown.
app.get('/tags', async (c) => {
  const all = await db.select({ tag: peopleTags.tag }).from(peopleTags);
  const set = new Set(all.map(r => r.tag));
  return c.json({ tags: [...set].sort() });
});

const safeJson = (s: string): unknown => {
  try { return JSON.parse(s); } catch { return s; }
};

export default app;
