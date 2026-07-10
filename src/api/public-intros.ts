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

// Individual angels carry a generic firm name. Collapse them into one
// "Angel ×N" tile so the count of angel investors is visible.
const ANGEL_FIRM_LABELS = new Set(['angel', 'angel investor', 'angel investors']);

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
  const angelInvestorIds = new Set<(typeof rows)[number]['investorId']>();
  for (const r of rows) {
    if (!INTRO_TAKEN_STATUSES.has(r.status)) continue;

    const dateStr = r.dateIntroduced || r.dateRequested || r.createdAt;
    if (!dateStr) continue;
    const d = new Date(dateStr);
    if (isNaN(d.getTime()) || d < cutoff) continue;

    const firm = firmById.get(r.investorId);
    if (!firm) continue;
    if (ANGEL_FIRM_LABELS.has(firm.toLowerCase())) {
      angelInvestorIds.add(r.investorId);
    } else {
      firmSet.add(firm);
    }
  }

  const firms = [...firmSet].sort((a, b) => a.localeCompare(b));
  // Surface angels as a single tile up front so the volume reads clearly.
  if (angelInvestorIds.size > 0) {
    firms.unshift(`Angel ×${angelInvestorIds.size}`);
  }

  c.header('Cache-Control', 'public, max-age=60');
  return c.json({
    count: firms.length,
    firms,
    window_days: WINDOW_DAYS,
  });
});

export default app;
