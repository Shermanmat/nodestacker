/**
 * Pitch Gym quota. Every founder gets WEEKLY_GYM_REPS practice reps against the
 * AI VC personas PER WEEK (min 1) — usage resets each week (Monday 00:00 UTC).
 * Admin can raise a founder's weekly rate via `gymRepsAllowed`. A "rep" = a
 * mock-call analysis tagged with a persona for that founder.
 */

import { eq, and, isNotNull } from 'drizzle-orm';
import { db, founders, mockCallAnalyses } from '../db/index.js';

/** Baseline practice reps every founder gets each week. */
export const WEEKLY_GYM_REPS = 1;

export interface GymStatus {
  repsAllowed: number;   // reps per week for this founder
  repsUsed: number;      // reps used THIS week
  repsRemaining: number;
}

/** Monday 00:00 UTC of the current week, as epoch ms. */
function weekStartUTC(now = new Date()): number {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = d.getUTCDay();                 // 0=Sun … 6=Sat
  d.setUTCDate(d.getUTCDate() - (day === 0 ? 6 : day - 1));
  return d.getTime();
}

/** Parse a stored timestamp (ISO or SQLite 'YYYY-MM-DD HH:MM:SS', assumed UTC). */
function toMs(s: string | null): number {
  if (!s) return 0;
  let iso = s.includes('T') ? s : s.replace(' ', 'T');
  if (!/[Zz]|[+-]\d\d:?\d\d$/.test(iso)) iso += 'Z';
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/** Count a founder's gym reps (persona-tagged analyses); optionally this week only. */
export async function countGymReps(founderId: number, thisWeekOnly = false): Promise<number> {
  const rows = await db.select({ createdAt: mockCallAnalyses.createdAt })
    .from(mockCallAnalyses)
    .where(and(eq(mockCallAnalyses.founderId, founderId), isNotNull(mockCallAnalyses.persona)));
  if (!thisWeekOnly) return rows.length;
  const since = weekStartUTC();
  return rows.filter(r => toMs(r.createdAt) >= since).length;
}

export async function getGymStatus(founderId: number): Promise<GymStatus> {
  const founder = await db.query.founders.findFirst({ where: eq(founders.id, founderId) });
  // gymRepsAllowed is the founder's weekly rate; floor at the baseline so every
  // founder always has at least WEEKLY_GYM_REPS/week regardless of stored value.
  const repsAllowed = Math.max(WEEKLY_GYM_REPS, founder?.gymRepsAllowed ?? WEEKLY_GYM_REPS);
  const repsUsed = await countGymReps(founderId, true);
  return { repsAllowed, repsUsed, repsRemaining: Math.max(0, repsAllowed - repsUsed) };
}

/** Set a founder's weekly rep rate (admin). Min 1. */
export async function setGymAllowance(founderId: number, repsPerWeek: number): Promise<GymStatus> {
  await db.update(founders).set({ gymRepsAllowed: Math.max(1, Math.round(repsPerWeek)) }).where(eq(founders.id, founderId));
  return getGymStatus(founderId);
}

/** Grant an extra rep for THIS week on top of the weekly rate (admin). */
export async function resetGymRep(founderId: number): Promise<GymStatus> {
  const usedThisWeek = await countGymReps(founderId, true);
  const founder = await db.query.founders.findFirst({ where: eq(founders.id, founderId) });
  const current = Math.max(WEEKLY_GYM_REPS, founder?.gymRepsAllowed ?? WEEKLY_GYM_REPS);
  await db.update(founders).set({ gymRepsAllowed: Math.max(current, usedThisWeek + 1) }).where(eq(founders.id, founderId));
  return getGymStatus(founderId);
}
