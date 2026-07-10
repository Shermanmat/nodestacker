/**
 * Pitch Gym quota. A founder gets a limited number of practice reps against the
 * AI VC personas (default 1). Reps used = mock-call analyses tagged with a
 * persona for that founder. Admin can raise the allowance or reset a founder.
 */

import { eq, and, isNotNull, sql } from 'drizzle-orm';
import { db, founders, mockCallAnalyses } from '../db/index.js';

export interface GymStatus {
  repsAllowed: number;
  repsUsed: number;
  repsRemaining: number;
}

/** Count a founder's gym reps (analyses tagged with a persona). */
export async function countGymReps(founderId: number): Promise<number> {
  const row = await db.select({ n: sql<number>`count(*)` })
    .from(mockCallAnalyses)
    .where(and(eq(mockCallAnalyses.founderId, founderId), isNotNull(mockCallAnalyses.persona)))
    .get();
  return row?.n ?? 0;
}

export async function getGymStatus(founderId: number): Promise<GymStatus> {
  const founder = await db.query.founders.findFirst({ where: eq(founders.id, founderId) });
  const repsAllowed = founder?.gymRepsAllowed ?? 1;
  const repsUsed = await countGymReps(founderId);
  return { repsAllowed, repsUsed, repsRemaining: Math.max(0, repsAllowed - repsUsed) };
}

/** Set an explicit allowance for a founder (admin). */
export async function setGymAllowance(founderId: number, repsAllowed: number): Promise<GymStatus> {
  await db.update(founders).set({ gymRepsAllowed: Math.max(0, Math.round(repsAllowed)) }).where(eq(founders.id, founderId));
  return getGymStatus(founderId);
}

/** Grant exactly one fresh rep regardless of history (admin "reset"). */
export async function resetGymRep(founderId: number): Promise<GymStatus> {
  const used = await countGymReps(founderId);
  await db.update(founders).set({ gymRepsAllowed: used + 1 }).where(eq(founders.id, founderId));
  return getGymStatus(founderId);
}
