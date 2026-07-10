/**
 * Founder Momentum.
 *
 * Each founder's weekly INTRO-REQUEST pace (founders.introTargetPerWeek — the
 * number the match generator fills toward). We promise intro *requests* (the
 * outreach we control), never intros (the investor's acceptance).
 *
 * Core rule: **the weekly pace is ONLY a function of the founder's intro-request
 * acceptance rate.** Nothing else moves it. `recomputePaceForAll` keeps
 * introTargetPerWeek tracking acceptance each cycle. New founders are set by the
 * calibration burst; after that, acceptance drives the number continuously.
 *
 * (Bonus one-off "shots on goal" from carrots, and the win-blitz, are separate
 * mechanics layered on top — not part of the weekly pace.)
 */

import { eq, and, isNull, isNotNull } from 'drizzle-orm';
import { db, founders, introRequests } from '../db/index.js';
import { getGymStatus } from './gym.js';

/** Base pace a founder falls back to with no signal. */
export const BASE_TARGET = 1;
/** Neutral pace when a founder has too little data to read acceptance. */
export const NEUTRAL_TARGET = 2;
/** Top of the accept-rate ladder. */
export const MAX_PACE = 5;

// ── Acceptance → pace ladder (the whole model) ───────────────────────────────
// Smooth 5-4-3-2-1 ladder keyed to intro-request acceptance rate:
//   ≥30% → 5 (exceptional) · 25–29% → 4 (strong) · 20–24% → 3 (solid)
//   17–19% → 2 (slipping / ⚠️ warning) · <17% → 1 (at risk — fix the pitch)
export const WARN_FLOOR = 0.17;   // below this → drop to 1
export const WARN_CEIL = 0.20;    // [WARN_FLOOR, WARN_CEIL) → warning zone

export function speedFromAcceptRate(rate: number): number {
  if (rate >= 0.30) return 5;
  if (rate >= 0.25) return 4;
  if (rate >= 0.20) return 3;
  if (rate >= WARN_FLOOR) return 2;   // 17–19% — slipping
  return 1;                            // <17%
}

/** Which acceptance bracket a rate falls in, its label, and the pace it supports. */
export function acceptBracket(rate: number): { label: string; supports: number } {
  if (rate >= 0.30) return { label: 'exceptional', supports: 5 };
  if (rate >= 0.25) return { label: 'strong', supports: 4 };
  if (rate >= 0.20) return { label: 'solid', supports: 3 };
  if (rate >= WARN_FLOOR) return { label: 'slipping', supports: 2 };
  return { label: 'at risk', supports: 1 };
}

/** Pace from a possibly-null rate: too little data → a neutral 2. */
export function paceFromRate(rate: number | null): number {
  return rate === null ? NEUTRAL_TARGET : speedFromAcceptRate(rate);
}

/** True when a founder is in the "slipping" warning zone (17–19%). */
export function isWarning(rate: number | null): boolean {
  return rate !== null && rate >= WARN_FLOOR && rate < WARN_CEIL;
}

/** Minimum decided requests before we trust / show an acceptance rate. */
export const ACCEPT_MIN_SAMPLE = 4;

const ACCEPTED_STATUSES = new Set([
  'introduced', 'first_meeting_complete', 'second_meeting_complete',
  'follow_up_questions', 'circle_back_round_opens', 'invested',
]);
const DECIDED_STATUSES = new Set([...ACCEPTED_STATUSES, 'passed', 'ignored']);
const isSent = (status: string) => status !== 'pending_suggestion';

/** A founder's intro-request acceptance rate over their decided requests. */
export function acceptRateOf(intros: Array<{ status: string }>): { rate: number | null; decided: number } {
  const decided = intros.filter(i => DECIDED_STATUSES.has(i.status)).length;
  const accepted = intros.filter(i => ACCEPTED_STATUSES.has(i.status)).length;
  return { rate: decided >= ACCEPT_MIN_SAMPLE ? accepted / decided : null, decided };
}

async function loadIntros(founderId: number) {
  return db.select({
    status: introRequests.status,
    dateRequested: introRequests.dateRequested,
    createdAt: introRequests.createdAt,
  }).from(introRequests).where(eq(introRequests.founderId, founderId));
}

// ── Continuous pace = acceptance ─────────────────────────────────────────────

/**
 * Recompute a single founder's weekly pace from their acceptance rate and write
 * it to introTargetPerWeek. Only for calibrated + active founders (new founders
 * are handled by the calibration burst; paused founders don't send). Returns the
 * pace, or null if skipped.
 */
export async function recomputePace(founderId: number): Promise<number | null> {
  const founder = await db.query.founders.findFirst({ where: eq(founders.id, founderId) });
  if (!founder || !founder.calibratedAt || !founder.introCadenceActive) return null;
  const { rate } = acceptRateOf(await loadIntros(founderId));
  const pace = paceFromRate(rate);
  if (pace !== founder.introTargetPerWeek) {
    await db.update(founders).set({ introTargetPerWeek: pace }).where(eq(founders.id, founderId));
  }
  return pace;
}

/** Recompute pace from acceptance for every calibrated + active founder (or one). */
export async function recomputePaceForAll(founderId?: number): Promise<void> {
  const candidates = await db.query.founders.findMany({
    where: founderId
      ? eq(founders.id, founderId)
      : and(isNotNull(founders.calibratedAt), eq(founders.introCadenceActive, true)),
    columns: { id: true },
  });
  for (const f of candidates) {
    try { await recomputePace(f.id); }
    catch (e) { console.error('[momentum] recomputePace failed for founder', f.id, e); }
  }
}

// ── Calibration ──────────────────────────────────────────────────────────────
// A new founder's first CALIBRATION_TARGET intro requests go out as a burst (all
// in week 1) so we can read their accept rate — you can't judge acceptance off
// 1-2 requests. Once enough resolve, the pace is set from that rate and
// founders.calibratedAt is stamped. Existing founders were grandfathered at
// migration time, so this only affects new signups.

export const CALIBRATION_TARGET = 10;
export const CALIBRATION_WEEKLY = 10;
export const CALIBRATION_MIN_DECIDED = 8;
export const CALIBRATION_BACKSTOP_DAYS = 28;

export interface CalibrationView {
  phase: 'sending' | 'waiting' | 'ready';
  sentCount: number;
  decidedCount: number;
  acceptRate: number | null;
  ready: boolean;
  recommendedTarget: number | null;
  messagingConcern: boolean;   // ready & acceptance below the warning floor
}

export function calibrationView(
  intros: Array<{ status: string; dateRequested?: string | null; createdAt?: string | null }>,
  now: Date = new Date(),
): CalibrationView {
  const sent = intros.filter(i => isSent(i.status));
  const decided = sent.filter(i => DECIDED_STATUSES.has(i.status));
  const accepted = sent.filter(i => ACCEPTED_STATUSES.has(i.status));
  const acceptRate = decided.length > 0 ? accepted.length / decided.length : null;

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
  const recommendedTarget = ready
    ? (decided.length >= ACCEPT_MIN_SAMPLE && acceptRate !== null ? speedFromAcceptRate(acceptRate) : NEUTRAL_TARGET)
    : null;
  const messagingConcern = ready && decided.length >= ACCEPT_MIN_SAMPLE && acceptRate !== null && acceptRate < WARN_FLOOR;

  return { phase, sentCount: sent.length, decidedCount: decided.length, acceptRate, ready, recommendedTarget, messagingConcern };
}

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
    catch (e) { console.error('[momentum] finalizeCalibration failed for founder', f.id, e); }
  }
}

/**
 * Still in the send phase of calibration? Used by the generator to elevate the
 * weekly target to the burst rate. Pure given the inputs.
 */
export function isCalibrationSending(calibratedAt: string | null | undefined, sentCount: number): boolean {
  return !calibratedAt && sentCount < CALIBRATION_TARGET;
}

// ── Founder-facing reading ───────────────────────────────────────────────────

export interface TreadmillReading {
  requestsPerWeek: number;       // current weekly pace
  cadenceActive: boolean;
  gymRepsRemaining: number;      // gym reps available this week (practice)
  calibrating: boolean;
  calibration: { phase: 'sending' | 'waiting'; sentCount: number; target: number } | null;
  // Why the pace is what it is + how it moves.
  explainer: {
    acceptRatePct: number | null;   // rounded % of decided requests accepted (null = too few)
    bracket: string | null;         // exceptional | strong | solid | slipping | at risk
    bracketSupports: number | null; // pace that response level supports
    warning: boolean;               // in the 17–19% slipping zone
    atTop: boolean;                  // at the top of the ladder (≥30%)
    hint: string | null;
  } | null;
}

export async function getTreadmillReading(founderId: number): Promise<TreadmillReading> {
  const founder = await db.query.founders.findFirst({ where: eq(founders.id, founderId) });
  const cadenceActive = Boolean(founder?.introCadenceActive);
  const gymRepsRemaining = (await getGymStatus(founderId)).repsRemaining;
  const intros = await loadIntros(founderId);

  // Calibrating (new founder, active, not yet stamped): show burst progress.
  if (!founder?.calibratedAt && cadenceActive) {
    const view = calibrationView(intros);
    if (view.phase !== 'ready') {
      return {
        requestsPerWeek: founder?.introTargetPerWeek ?? BASE_TARGET, cadenceActive, gymRepsRemaining,
        calibrating: true,
        calibration: { phase: view.phase, sentCount: view.sentCount, target: CALIBRATION_TARGET },
        explainer: null,
      };
    }
  }

  // Why this pace — from the founder's acceptance rate + the bracket it's in.
  const { rate } = acceptRateOf(intros);
  // Show the LIVE acceptance-derived pace for calibrated founders so the number
  // always matches the "why" (the stored introTargetPerWeek is synced to this on
  // each generation tick, which is what the generator actually uses).
  const requestsPerWeek = founder?.calibratedAt ? paceFromRate(rate) : (founder?.introTargetPerWeek ?? BASE_TARGET);
  const b = rate !== null ? acceptBracket(rate) : null;
  const explainer = {
    acceptRatePct: rate !== null ? Math.round(rate * 100) : null,
    bracket: b?.label ?? null,
    bracketSupports: b?.supports ?? null,
    warning: isWarning(rate),
    atTop: rate !== null && rate >= 0.30,
    hint: rate === null
      ? 'As more investors respond, your pace adjusts to match how your requests are landing.'
      : (rate < WARN_FLOOR
          ? "Investors aren't biting yet — let's tighten the pitch together and get this back up."
          : (rate < 0.30 ? 'When investors accept more of your intro requests, your pace picks up.' : null)),
  };

  return { requestsPerWeek, cadenceActive, gymRepsRemaining, calibrating: false, calibration: null, explainer };
}
