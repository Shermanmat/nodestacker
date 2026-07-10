/**
 * Founder Treadmill — v1.
 *
 * Each founder's "belt speed" is their weekly INTRO-REQUEST allowance
 * (founders.introTargetPerWeek — the number the match generator fills toward).
 * Note the wording: we promise intro *requests* (the outreach we control), never
 * intros (the investor's acceptance, which we don't).
 *
 * v1 has exactly one trigger: completing a gym session (an AI pitch-practice rep)
 * ratchets the allowance up by 1. First rep takes a founder from 1 → 2/week.
 * More triggers (loop-closing, CRM growth, the messaging-diagnostic states, the
 * manual win-sprint) are designed in the plan but intentionally not built yet.
 */

import { eq, and, isNull } from 'drizzle-orm';
import { db, founders, introRequests } from '../db/index.js';
import { countGymReps } from './gym.js';

/** Max intro-requests/week reachable via gym reps alone (matches DYNAMIC_MAX). */
export const GYM_BUMP_CAP = 5;

/** Base allowance a new founder starts at. */
export const BASE_TARGET = 1;

/**
 * Completing a gym session is worth +1 intro request/week — from wherever the
 * founder currently is — capped at GYM_BUMP_CAP. Never lowers: a target already
 * at/above the cap (e.g. a future manual sprint to 20) is returned unchanged.
 * Pure — unit-testable, no I/O. This "+1 per session" rule works for both new
 * founders (1→2) and existing ones defaulted to 2 (2→3).
 */
export function bumpForRep(current: number): number {
  return current < GYM_BUMP_CAP ? current + 1 : current;
}

/**
 * Called once per newly-completed gym rep: ratchet introTargetPerWeek up by one.
 * Only ever raises. Safe on paused founders — the generator skips them, but the
 * unlock still accrues. Returns the resulting target.
 */
export async function applyGymReward(founderId: number): Promise<number> {
  const founder = await db.query.founders.findFirst({ where: eq(founders.id, founderId) });
  const current = founder?.introTargetPerWeek ?? BASE_TARGET;
  const next = bumpForRep(current);
  if (next !== current) {
    await db.update(founders).set({ introTargetPerWeek: next }).where(eq(founders.id, founderId));
  }
  return next;
}

// ── Calibration ──────────────────────────────────────────────────────────────
// A new founder's first CALIBRATION_TARGET intro requests go out as a burst (all
// in week 1) so we can read their accept rate — you can't judge "heat" off 1-2
// requests. Once enough have resolved, their ongoing weekly allowance is set from
// that rate and founders.calibratedAt is stamped. Existing founders are
// grandfathered (stamped) at migration time, so this only affects new signups.

export const CALIBRATION_TARGET = 10;       // total requests in the burst
export const CALIBRATION_WEEKLY = 10;       // week-1 firehose rate (all 10 up front)
export const CALIBRATION_MIN_DECIDED = 8;   // enough resolved outcomes to trust the rate
export const CALIBRATION_BACKSTOP_DAYS = 28; // finalize anyway after this long

const ACCEPTED_STATUSES = new Set([
  'introduced', 'first_meeting_complete', 'second_meeting_complete',
  'follow_up_questions', 'circle_back_round_opens', 'invested',
]);
const DECIDED_STATUSES = new Set([...ACCEPTED_STATUSES, 'passed', 'ignored']);
const isSent = (status: string) => status !== 'pending_suggestion';

/**
 * Accept rate → starting weekly intro-request allowance. Data-calibrated from
 * 711 historical requests: population average ≈25%, with a clean gap below ~15%.
 * ≥25% (vibing) → 4; the normal 15-25% pack → 2; <15% (messaging problem) → 1.
 */
export function speedFromAcceptRate(rate: number): number {
  if (rate >= 0.25) return 4;
  if (rate >= 0.15) return 2;
  return 1;
}

export interface CalibrationView {
  phase: 'sending' | 'waiting' | 'ready';
  sentCount: number;
  decidedCount: number;
  acceptRate: number | null;
  ready: boolean;
  recommendedTarget: number | null;   // set when ready
  messagingConcern: boolean;           // ready & accept rate below the ~15% floor
}

/**
 * Pure calibration state for a not-yet-calibrated founder, given their intro
 * requests. Unit-testable, no I/O.
 */
export function calibrationView(
  intros: Array<{ status: string; dateRequested?: string | null; createdAt?: string | null }>,
  now: Date = new Date(),
): CalibrationView {
  const sent = intros.filter(i => isSent(i.status));
  const decided = sent.filter(i => DECIDED_STATUSES.has(i.status));
  const accepted = sent.filter(i => ACCEPTED_STATUSES.has(i.status));
  const acceptRate = decided.length > 0 ? accepted.length / decided.length : null;

  // Backstop: how long since the first request went out.
  let firstSentMs = Infinity;
  for (const i of sent) {
    const d = i.dateRequested || i.createdAt;
    if (d) firstSentMs = Math.min(firstSentMs, new Date(d).getTime());
  }
  const ageDays = firstSentMs === Infinity ? 0 : (now.getTime() - firstSentMs) / 86_400_000;

  let phase: CalibrationView['phase'];
  if (sent.length < CALIBRATION_TARGET) phase = 'sending';
  else if (decided.length >= CALIBRATION_MIN_DECIDED || ageDays >= CALIBRATION_BACKSTOP_DAYS) phase = 'ready';
  else phase = 'waiting';

  const ready = phase === 'ready';
  // With too few decided (backstop with sparse outcomes), don't guess a rate —
  // give a neutral speed of 2 rather than punish on no data.
  const recommendedTarget = ready
    ? (decided.length >= 4 && acceptRate !== null ? speedFromAcceptRate(acceptRate) : 2)
    : null;
  const messagingConcern = ready && decided.length >= 4 && acceptRate !== null && acceptRate < 0.15;

  return { phase, sentCount: sent.length, decidedCount: decided.length, acceptRate, ready, recommendedTarget, messagingConcern };
}

async function loadIntros(founderId: number) {
  return db.select({
    status: introRequests.status,
    dateRequested: introRequests.dateRequested,
    createdAt: introRequests.createdAt,
  }).from(introRequests).where(eq(introRequests.founderId, founderId));
}

/**
 * If a founder's calibration burst has resolved enough, set their ongoing weekly
 * allowance from the measured accept rate and stamp calibratedAt. No-op if
 * already calibrated, paused, or still gathering signal. Returns the view when it
 * finalized, else null. Calibration is authoritative for the initial speed —
 * it SETS the target (gym/other triggers take over afterward).
 */
export async function finalizeCalibrationIfReady(founderId: number): Promise<CalibrationView | null> {
  const founder = await db.query.founders.findFirst({ where: eq(founders.id, founderId) });
  if (!founder || founder.calibratedAt || !founder.introCadenceActive) return null;
  const view = calibrationView(await loadIntros(founderId));
  if (!view.ready || view.recommendedTarget == null) return null;
  await db.update(founders)
    .set({ introTargetPerWeek: view.recommendedTarget, calibratedAt: new Date().toISOString() })
    .where(eq(founders.id, founderId));
  return view;
}

/** Finalize calibration for every active, not-yet-calibrated founder (or one). */
export async function finalizeCalibrationForAll(founderId?: number): Promise<void> {
  const candidates = await db.query.founders.findMany({
    where: founderId
      ? and(eq(founders.id, founderId), isNull(founders.calibratedAt))
      : and(isNull(founders.calibratedAt), eq(founders.introCadenceActive, true)),
    columns: { id: true },
  });
  for (const f of candidates) {
    try { await finalizeCalibrationIfReady(f.id); }
    catch (e) { console.error('[treadmill] finalizeCalibration failed for founder', f.id, e); }
  }
}

/**
 * Is this founder still in the send phase of calibration? Used by the generator
 * to elevate their weekly target to the burst rate. Pure given the inputs.
 */
export function isCalibrationSending(calibratedAt: string | null | undefined, sentCount: number): boolean {
  return !calibratedAt && sentCount < CALIBRATION_TARGET;
}

export interface TreadmillReading {
  requestsPerWeek: number;       // current belt speed
  gymRepsDone: number;
  cadenceActive: boolean;
  nextUnlock: { action: string; reward: string } | null;
  calibrating: boolean;
  calibration: { phase: 'sending' | 'waiting'; sentCount: number; target: number } | null;
}

/**
 * Read-only view for the founder's Treadmill tab. Computes belt state without
 * mutating anything (writes only happen when a rep actually completes).
 */
export async function getTreadmillReading(founderId: number): Promise<TreadmillReading> {
  const founder = await db.query.founders.findFirst({ where: eq(founders.id, founderId) });
  const reps = await countGymReps(founderId);
  const requestsPerWeek = founder?.introTargetPerWeek ?? BASE_TARGET;
  const cadenceActive = Boolean(founder?.introCadenceActive);

  // Calibrating (new founder, active, not yet stamped): show burst progress
  // instead of a belt number.
  if (!founder?.calibratedAt && cadenceActive) {
    const view = calibrationView(await loadIntros(founderId));
    if (view.phase !== 'ready') {
      return {
        requestsPerWeek, gymRepsDone: reps, cadenceActive, nextUnlock: null,
        calibrating: true,
        calibration: { phase: view.phase, sentCount: view.sentCount, target: CALIBRATION_TARGET },
      };
    }
    // phase === 'ready' but not yet finalized (finalize runs on the tick / on
    // generation) — fall through to show the belt at its recommended speed.
  }

  return {
    requestsPerWeek,
    gymRepsDone: reps,
    cadenceActive,
    nextUnlock: requestsPerWeek < GYM_BUMP_CAP
      ? { action: 'Complete a gym session', reward: '+1 intro request / week' }
      : null,
    calibrating: false,
    calibration: null,
  };
}
