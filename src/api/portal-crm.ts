import { Hono } from 'hono';
import { eq, and, or, desc } from 'drizzle-orm';
import { z } from 'zod';
import {
  db,
  introRequests,
  investors,
  nodes,
  founderInvestorRecords,
  investorInteractions,
} from '../db/index.js';
import { getSessionFounderId } from './auth.js';
import { getFounderAccess, CRM_GATE_ENFORCED } from './founder-access.js';

type Variables = {
  founderId: number;
};

const app = new Hono<{ Variables: Variables }>();

// Auth: every route below is scoped to the logged-in founder. No admin
// path reads any of these endpoints — the founder CRM is private.
app.use('*', async (c, next) => {
  const sessionId = c.req.header('X-Session-Id');
  const founderId = await getSessionFounderId(sessionId);
  if (!founderId) return c.json({ error: 'Unauthorized' }, 401);
  c.set('founderId', founderId);

  // Trial-based CRM gate (only when ENFORCE_CRM_TRIAL_GATE=1). CRM is a trial
  // perk: full access during an active trial / for portfolio founders;
  // read-only for 14 days after a pass/decline; none after that.
  if (CRM_GATE_ENFORCED) {
    const access = await getFounderAccess(founderId);
    if (access === 'none') {
      return c.json({ error: 'CRM access requires an active MatCap trial', accessLevel: 'none' }, 403);
    }
    // Read-only: allow safe reads, block mutations.
    if (access === 'readonly' && c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      return c.json({ error: 'Your trial ended — CRM is read-only', accessLevel: 'readonly' }, 403);
    }
  }

  await next();
});

// --- Unified CRM view ---
// Returns one combined "rows" array: MatCap-sent intros (from intro_requests)
// + founder-private records (from founder_investor_records). The UI renders
// both as table rows; `source` distinguishes them.
app.get('/investor-crm', async (c) => {
  const founderId = c.get('founderId') as number;

  // Pull the founder's intros, with the joined investor record.
  const intros = await db.query.introRequests.findMany({
    where: eq(introRequests.founderId, founderId),
    with: { investor: true, node: true },
    orderBy: desc(introRequests.updatedAt),
  });

  const introRows = intros.map(ir => ({
    kind: 'matcap_intro' as const,
    id: ir.id,
    investorName: ir.investor?.name ?? null,
    firm: ir.investor?.firm ?? null,
    role: ir.investor?.role ?? null,
    email: ir.investor?.email ?? null,
    geography: ir.investor?.geography ?? null,
    source: 'matcap' as const,
    status: ir.status,
    nextActionText: ir.founderNextActionText ?? null,
    nextActionDate: ir.founderNextActionDate ?? null,
    checkSize: ir.founderCheckSize ?? null,
    founderNotes: ir.founderOwnedNotes ?? null,
    lastTouchAt: ir.updatedAt,
    nodeName: ir.node?.name ?? null,
    warmIntroConnector: null,
  }));

  const records = await db.query.founderInvestorRecords.findMany({
    where: eq(founderInvestorRecords.founderId, founderId),
    orderBy: desc(founderInvestorRecords.updatedAt),
  });

  const recordRows = records.map(r => ({
    kind: 'self_record' as const,
    id: r.id,
    investorName: r.name,
    firm: r.firm,
    role: r.role,
    email: r.email,
    geography: r.geography,
    source: r.source as 'self_added' | 'cold_inbound' | 'warm_intro',
    status: r.status,
    nextActionText: r.nextActionText,
    nextActionDate: r.nextActionDate,
    checkSize: r.checkSize,
    founderNotes: r.notes,
    lastTouchAt: r.updatedAt,
    nodeName: null,
    warmIntroConnector: r.warmIntroConnector,
  }));

  // Combined, sorted by lastTouchAt desc. UI handles further sort/filter.
  const rows = [...introRows, ...recordRows].sort((a, b) => {
    const at = a.lastTouchAt ?? '';
    const bt = b.lastTouchAt ?? '';
    return bt.localeCompare(at);
  });

  return c.json({ rows });
});

// --- PATCH a MatCap-sourced intro row (founder-side fields only) ---
// Founder cannot change status, dates, node, etc. — admin owns those.
// Only the founder's CRM fields are mutable here.
const patchIntroSchema = z.object({
  founderNextActionText: z.string().nullable().optional(),
  founderNextActionDate: z.string().nullable().optional(),
  founderCheckSize: z.string().nullable().optional(),
  founderOwnedNotes: z.string().nullable().optional(),
}).strip();

app.patch('/intro-requests/:id', async (c) => {
  const founderId = c.get('founderId') as number;
  const id = parseInt(c.req.param('id'));
  if (!Number.isFinite(id)) return c.json({ error: 'Invalid id' }, 400);

  const ir = await db.query.introRequests.findFirst({
    where: and(eq(introRequests.id, id), eq(introRequests.founderId, founderId)),
  });
  if (!ir) return c.json({ error: 'Not found' }, 404);

  const body = await c.req.json().catch(() => ({}));
  const parsed = patchIntroSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const updates: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(parsed.data)) {
    if (v !== undefined) updates[k] = v;
  }
  if (Object.keys(updates).length === 0) return c.json({ ok: true, noop: true });
  updates.updatedAt = new Date().toISOString();

  await db.update(introRequests).set(updates).where(eq(introRequests.id, id));
  return c.json({ ok: true });
});

// --- Founder-private records (self-added / cold inbound) ---
const createRecordSchema = z.object({
  name: z.string().min(1),
  firm: z.string().nullable().optional(),
  role: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  geography: z.string().nullable().optional(),
  source: z.enum(['self_added', 'cold_inbound', 'warm_intro']).optional(),
  status: z.string().optional(),
  nextActionText: z.string().nullable().optional(),
  nextActionDate: z.string().nullable().optional(),
  checkSize: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  warmIntroConnector: z.string().nullable().optional(),
});

app.post('/founder-investor-records', async (c) => {
  const founderId = c.get('founderId') as number;
  const body = await c.req.json().catch(() => ({}));
  const parsed = createRecordSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const now = new Date().toISOString();
  const [created] = await db.insert(founderInvestorRecords).values({
    founderId,
    name: parsed.data.name,
    firm: parsed.data.firm ?? null,
    role: parsed.data.role ?? null,
    email: parsed.data.email ?? null,
    geography: parsed.data.geography ?? null,
    source: parsed.data.source ?? 'self_added',
    status: parsed.data.status ?? 'self_outreach',
    nextActionText: parsed.data.nextActionText ?? null,
    nextActionDate: parsed.data.nextActionDate ?? null,
    checkSize: parsed.data.checkSize ?? null,
    notes: parsed.data.notes ?? null,
    warmIntroConnector: parsed.data.warmIntroConnector ?? null,
    createdAt: now,
    updatedAt: now,
  }).returning();

  return c.json(created, 201);
});

const patchRecordSchema = createRecordSchema.partial().strip();

app.patch('/founder-investor-records/:id', async (c) => {
  const founderId = c.get('founderId') as number;
  const id = parseInt(c.req.param('id'));
  if (!Number.isFinite(id)) return c.json({ error: 'Invalid id' }, 400);

  const record = await db.query.founderInvestorRecords.findFirst({
    where: and(eq(founderInvestorRecords.id, id), eq(founderInvestorRecords.founderId, founderId)),
  });
  if (!record) return c.json({ error: 'Not found' }, 404);

  const body = await c.req.json().catch(() => ({}));
  const parsed = patchRecordSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const updates: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(parsed.data)) {
    if (v !== undefined) updates[k] = v as string | null;
  }
  if (Object.keys(updates).length === 0) return c.json({ ok: true, noop: true });
  updates.updatedAt = new Date().toISOString();

  await db.update(founderInvestorRecords).set(updates).where(eq(founderInvestorRecords.id, id));
  return c.json({ ok: true });
});

app.delete('/founder-investor-records/:id', async (c) => {
  const founderId = c.get('founderId') as number;
  const id = parseInt(c.req.param('id'));
  if (!Number.isFinite(id)) return c.json({ error: 'Invalid id' }, 400);

  const record = await db.query.founderInvestorRecords.findFirst({
    where: and(eq(founderInvestorRecords.id, id), eq(founderInvestorRecords.founderId, founderId)),
  });
  if (!record) return c.json({ error: 'Not found' }, 404);

  // Cascade: drop the record's interactions first (no FK ON DELETE wired).
  await db.delete(investorInteractions).where(
    and(
      eq(investorInteractions.founderInvestorRecordId, id),
      eq(investorInteractions.founderId, founderId),
    ),
  );
  await db.delete(founderInvestorRecords).where(eq(founderInvestorRecords.id, id));
  return c.json({ ok: true });
});

// --- Interactions (meeting / email / call / note logs) ---
const createInteractionSchema = z.object({
  investorId: z.number().int().optional(),
  founderInvestorRecordId: z.number().int().optional(),
  interactionType: z.enum(['meeting', 'email', 'call', 'note', 'intro_sent']),
  occurredAt: z.string(),
  content: z.string().nullable().optional(),
}).refine(
  d => (d.investorId != null) !== (d.founderInvestorRecordId != null),
  { message: 'Exactly one of investorId or founderInvestorRecordId is required' },
);

app.post('/investor-interactions', async (c) => {
  const founderId = c.get('founderId') as number;
  const body = await c.req.json().catch(() => ({}));
  const parsed = createInteractionSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  // Authorize: founder can only log against their own intros / records.
  if (parsed.data.investorId != null) {
    const ir = await db.query.introRequests.findFirst({
      where: and(
        eq(introRequests.investorId, parsed.data.investorId),
        eq(introRequests.founderId, founderId),
      ),
    });
    if (!ir) return c.json({ error: 'No intro request for this investor under your account' }, 403);
  } else if (parsed.data.founderInvestorRecordId != null) {
    const r = await db.query.founderInvestorRecords.findFirst({
      where: and(
        eq(founderInvestorRecords.id, parsed.data.founderInvestorRecordId),
        eq(founderInvestorRecords.founderId, founderId),
      ),
    });
    if (!r) return c.json({ error: 'Not found' }, 404);
  }

  const [created] = await db.insert(investorInteractions).values({
    founderId,
    investorId: parsed.data.investorId ?? null,
    founderInvestorRecordId: parsed.data.founderInvestorRecordId ?? null,
    interactionType: parsed.data.interactionType,
    occurredAt: parsed.data.occurredAt,
    content: parsed.data.content ?? null,
    createdBy: 'founder',
    createdAt: new Date().toISOString(),
  }).returning();

  return c.json(created, 201);
});

app.get('/investor-interactions', async (c) => {
  const founderId = c.get('founderId') as number;
  const investorIdRaw = c.req.query('investorId');
  const recordIdRaw = c.req.query('recordId');

  const investorId = investorIdRaw ? parseInt(investorIdRaw) : null;
  const recordId = recordIdRaw ? parseInt(recordIdRaw) : null;

  if (investorId == null && recordId == null) {
    return c.json({ error: 'investorId or recordId is required' }, 400);
  }

  const conds = [eq(investorInteractions.founderId, founderId)];
  if (investorId != null) conds.push(eq(investorInteractions.investorId, investorId));
  if (recordId != null) conds.push(eq(investorInteractions.founderInvestorRecordId, recordId));

  const rows = await db.select().from(investorInteractions)
    .where(and(...conds))
    .orderBy(desc(investorInteractions.occurredAt));

  return c.json({ interactions: rows });
});

export default app;
