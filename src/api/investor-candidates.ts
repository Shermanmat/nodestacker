// Admin review surface for the investor-discovery agent. List pending candidates,
// trigger a discovery run on demand, and approve (→ create an investors row) or
// reject. Admin-gated via the adminGuard in index.ts.

import { Hono } from 'hono';
import { eq, and, desc } from 'drizzle-orm';
import { db, investorCandidates, investors } from '../db/index.js';
import { runInvestorDiscoveryTick } from '../services/investor-discovery.js';

const app = new Hono();

app.get('/', async (c) => {
  const status = c.req.query('status') || 'pending';
  const rows = await db.query.investorCandidates.findMany({
    where: status === 'all' ? undefined : eq(investorCandidates.status, status),
    orderBy: [desc(investorCandidates.createdAt)],
    limit: 300,
  });
  const all = await db.select({ status: investorCandidates.status }).from(investorCandidates);
  const counts: Record<string, number> = { pending: 0, approved: 0, rejected: 0 };
  for (const r of all) counts[r.status] = (counts[r.status] || 0) + 1;
  return c.json({ items: rows, counts });
});

// Trigger a discovery run now (also runs daily on a cron).
app.post('/run', async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const count = Math.min(30, Math.max(1, parseInt(body.count) || 15));
  try {
    const result = await runInvestorDiscoveryTick(count);
    return c.json({ success: true, ...result });
  } catch (e: any) {
    return c.json({ error: e?.message || 'Discovery failed' }, 500);
  }
});

// Approve → create (or reuse) an investors row, mark the candidate approved.
app.post('/:id/approve', async (c) => {
  const id = parseInt(c.req.param('id'));
  const cand = await db.query.investorCandidates.findFirst({ where: eq(investorCandidates.id, id) });
  if (!cand) return c.json({ error: 'Not found' }, 404);
  if (cand.status === 'approved' && cand.investorId) return c.json({ success: true, investorId: cand.investorId });

  const existing = await db.query.investors.findFirst({
    where: cand.firm ? and(eq(investors.name, cand.name), eq(investors.firm, cand.firm)) : eq(investors.name, cand.name),
  });
  const now = new Date().toISOString();
  let investorId: number;
  if (existing) {
    investorId = existing.id;
  } else {
    const noteParts = ['Discovered via sourcing agent'];
    if (cand.stage) noteParts.push(`Stage: ${cand.stage}`);
    if (cand.thesis) noteParts.push(cand.thesis);
    if (cand.sourceUrl) noteParts.push(`Source: ${cand.sourceUrl}`);
    const [created] = await db.insert(investors).values({
      name: cand.name, firm: cand.firm, role: cand.role,
      checkSize: cand.checkSize, geography: cand.geo,
      active: true, vip: false,
      notes: noteParts.join(' · '),
    }).returning();
    investorId = created.id;
  }
  await db.update(investorCandidates).set({ status: 'approved', investorId, reviewedAt: now }).where(eq(investorCandidates.id, id));
  return c.json({ success: true, investorId });
});

app.post('/:id/reject', async (c) => {
  const id = parseInt(c.req.param('id'));
  await db.update(investorCandidates).set({ status: 'rejected', reviewedAt: new Date().toISOString() }).where(eq(investorCandidates.id, id));
  return c.json({ success: true });
});

export default app;
