import { Hono } from 'hono';
import { db, introRequests, investors } from '../db/index.js';

const app = new Hono();

const INTRO_TAKEN_STATUSES = new Set([
  'introduced',
  'first_meeting_complete',
  'second_meeting_complete',
  'follow_up_questions',
  'circle_back_round_opens',
  'invested',
]);

const WINDOW_DAYS = 30;

app.get('/recent-firms', async (c) => {
  const cutoff = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      investorId: introRequests.investorId,
      status: introRequests.status,
      dateIntroduced: introRequests.dateIntroduced,
      dateRequested: introRequests.dateRequested,
      createdAt: introRequests.createdAt,
    })
    .from(introRequests);

  const investorRows = await db
    .select({ id: investors.id, firm: investors.firm })
    .from(investors);
  const firmById = new Map(investorRows.map((i) => [i.id, i.firm?.trim() || null]));

  const firmSet = new Set<string>();
  for (const r of rows) {
    if (!INTRO_TAKEN_STATUSES.has(r.status)) continue;

    const dateStr = r.dateIntroduced || r.dateRequested || r.createdAt;
    if (!dateStr) continue;
    const d = new Date(dateStr);
    if (isNaN(d.getTime()) || d < cutoff) continue;

    const firm = firmById.get(r.investorId);
    if (!firm) continue;
    firmSet.add(firm);
  }

  const firms = [...firmSet].sort((a, b) => a.localeCompare(b));

  c.header('Cache-Control', 'public, max-age=60');
  return c.json({
    count: firms.length,
    firms,
    window_days: WINDOW_DAYS,
  });
});

export default app;
