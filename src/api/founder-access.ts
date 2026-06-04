import { eq } from 'drizzle-orm';
import { db, portfolioCompanies, trials } from '../db/index.js';

// CRM / portal access level derived from a founder's trial + portfolio status.
//   full     — active trial, offer pending/accepted, or a portfolio company
//   readonly — within the 14-day grace window after a pass or declined offer
//   none     — no current relationship (or grace expired)
export type AccessLevel = 'full' | 'readonly' | 'none';

export async function getFounderAccess(founderId: number): Promise<AccessLevel> {
  // Portfolio companies always have full access.
  const portfolio = await db.query.portfolioCompanies.findFirst({
    where: eq(portfolioCompanies.founderId, founderId),
  });
  if (portfolio) return 'full';

  const founderTrials = await db.query.trials.findMany({
    where: eq(trials.founderId, founderId),
  });
  if (founderTrials.some((t) => ['active', 'offer_made', 'offer_accepted'].includes(t.status))) {
    return 'full';
  }

  // Passed or declined within the grace window → read-only.
  const now = Date.now();
  const inGrace = founderTrials.some(
    (t) =>
      (t.status === 'passed' || t.status === 'offer_declined') &&
      t.accessRevokesAt &&
      new Date(t.accessRevokesAt).getTime() > now,
  );
  return inGrace ? 'readonly' : 'none';
}

// Whether the trial CRM gate is enforced. Off by default so existing founders
// keep CRM access on deploy; flip ENFORCE_CRM_TRIAL_GATE=1 to restrict CRM to
// trial/portfolio founders (with the read-only grace).
export const CRM_GATE_ENFORCED = process.env.ENFORCE_CRM_TRIAL_GATE === '1';
