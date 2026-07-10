/**
 * Treadmill v1 tests — the gym-session reward mechanic.
 *  - bumpForRep: +1 per session from current, capped at 5, never lowers
 *  - applyGymReward: ratchets founders.introTargetPerWeek up on rep completion,
 *    and never lowers a higher (manually-set) target.
 * Runs against a throwaway SQLite DB — never touches dev/prod data.
 *
 * Run:  node --import tsx --test tests/treadmill.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';

const TMP_DB = path.join(process.cwd(), `.tmp-treadmill-test-${Date.now()}.db`);

let db: any, founders: any, mockCallAnalyses: any, introRequests: any, eq: any;
let treadmill: typeof import('../src/services/treadmill.js');

before(async () => {
  // Copy DDL (no data) from the dev DB into a throwaway, then point the app at it.
  const srcPath = process.env.DATABASE_PATH || 'nodestacker.db';
  const src = new Database(srcPath, { readonly: true });
  const ddl = src.prepare(
    "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' " +
    "ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END",
  ).all() as Array<{ sql: string }>;
  src.close();
  const dst = new Database(TMP_DB);
  for (const row of ddl) { try { dst.exec(row.sql); } catch { /* skip */ } }
  dst.close();
  process.env.DATABASE_PATH = TMP_DB;

  const dbMod = await import('../src/db/index.js');
  db = dbMod.db; founders = dbMod.founders; mockCallAnalyses = dbMod.mockCallAnalyses;
  introRequests = dbMod.introRequests;
  ({ eq } = await import('drizzle-orm'));
  treadmill = await import('../src/services/treadmill.js');
});

after(() => {
  if (existsSync(TMP_DB)) rmSync(TMP_DB);
});

test('bumpForRep: +1 per session, capped, never lowers', () => {
  const { bumpForRep } = treadmill;
  assert.equal(bumpForRep(1), 2);
  assert.equal(bumpForRep(2), 3);   // existing founders default to 2
  assert.equal(bumpForRep(4), 5);
  assert.equal(bumpForRep(5), 5);   // capped
  assert.equal(bumpForRep(20), 20); // above cap (future sprint) — never lowered
});

let seq = 0;
async function makeFounder(target: number): Promise<number> {
  const [f] = await db.insert(founders).values({
    name: 'Test Founder', email: `treadmill-test-${++seq}@example.com`,
    companyName: 'Test Co', companyStage: 'pre-seed',
    introTargetPerWeek: target, introCadenceActive: true,
    createdAt: new Date().toISOString(),
  }).returning();
  return f.id;
}
async function addRep(founderId: number) {
  await db.insert(mockCallAnalyses).values({
    founderId, transcript: 'x', persona: 'gp', createdAt: new Date().toISOString(),
  });
}

test('applyGymReward: first rep bumps 1 → 2, second → 3', async () => {
  const id = await makeFounder(1);
  await addRep(id);
  assert.equal(await treadmill.applyGymReward(id), 2);
  let f = await db.query.founders.findFirst({ where: eq(founders.id, id) });
  assert.equal(f.introTargetPerWeek, 2);

  await addRep(id);
  assert.equal(await treadmill.applyGymReward(id), 3);
});

test('applyGymReward: existing founder at 2 → 3', async () => {
  const id = await makeFounder(2);
  await addRep(id);
  assert.equal(await treadmill.applyGymReward(id), 3);
});

test('applyGymReward: caps at 5 and never lowers a target above the cap', async () => {
  const capped = await makeFounder(5);
  await addRep(capped);
  assert.equal(await treadmill.applyGymReward(capped), 5);   // stays at cap

  const high = await makeFounder(20);       // future sprint could set this
  await addRep(high);
  assert.equal(await treadmill.applyGymReward(high), 20);    // never lowered
});

test('getTreadmillReading: surfaces the next unlock (calibrated founder)', async () => {
  const id = await makeFounder(1);
  await db.update(founders).set({ calibratedAt: new Date().toISOString() }).where(eq(founders.id, id));
  const r0 = await treadmill.getTreadmillReading(id);
  assert.equal(r0.calibrating, false);
  assert.equal(r0.requestsPerWeek, 1);
  assert.equal(r0.gymRepsDone, 0);
  assert.ok(r0.nextUnlock, 'should offer a next unlock at base');

  await addRep(id);
  await treadmill.applyGymReward(id);
  const r1 = await treadmill.getTreadmillReading(id);
  assert.equal(r1.requestsPerWeek, 2);
  assert.equal(r1.gymRepsDone, 1);
});

// ── Calibration ──────────────────────────────────────────────────────────────

test('speedFromAcceptRate: data-calibrated bands', () => {
  const { speedFromAcceptRate } = treadmill;
  assert.equal(speedFromAcceptRate(0.40), 5);  // exceptional (top bracket)
  assert.equal(speedFromAcceptRate(0.30), 5);  // top bracket threshold
  assert.equal(speedFromAcceptRate(0.29), 4);  // strong
  assert.equal(speedFromAcceptRate(0.25), 4);  // healthy line
  assert.equal(speedFromAcceptRate(0.20), 2);  // normal pack
  assert.equal(speedFromAcceptRate(0.15), 2);  // floor of normal
  assert.equal(speedFromAcceptRate(0.10), 1);  // messaging problem
});

test('isCalibrationSending: burst window', () => {
  const { isCalibrationSending } = treadmill;
  assert.equal(isCalibrationSending(null, 5), true);
  assert.equal(isCalibrationSending(null, 10), false);   // burst filled
  assert.equal(isCalibrationSending('2026-01-01', 3), false); // already calibrated
});

test('calibrationView: phases', () => {
  const { calibrationView } = treadmill;
  const sent = (status: string) => ({ status, createdAt: new Date().toISOString() });

  // < 10 sent → sending
  const sending = calibrationView([...Array(4)].map(() => sent('intro_request_sent')));
  assert.equal(sending.phase, 'sending');

  // 10 sent, only 2 decided, recent → waiting
  const wait = calibrationView([
    ...[...Array(8)].map(() => sent('intro_request_sent')),
    sent('introduced'), sent('passed'),
  ]);
  assert.equal(wait.phase, 'waiting');
  assert.equal(wait.ready, false);

  // 10 sent, 8 decided (3 accepted, 5 passed) → ready, rate 3/8=0.375 → target 5
  const ready = calibrationView([
    sent('introduced'), sent('introduced'), sent('introduced'),
    sent('passed'), sent('passed'), sent('passed'), sent('passed'), sent('passed'),
    sent('intro_request_sent'), sent('intro_request_sent'),
  ]);
  assert.equal(ready.phase, 'ready');
  assert.equal(ready.recommendedTarget, 5);
  assert.equal(ready.messagingConcern, false);

  // low accept (1/10) → target 1 + messaging concern
  const weak = calibrationView([
    sent('introduced'),
    ...[...Array(9)].map(() => sent('passed')),
  ]);
  assert.equal(weak.recommendedTarget, 1);
  assert.equal(weak.messagingConcern, true);
});

let sharedNodeId = 0, sharedInvestorId = 0;
async function ensureNodeInvestor() {
  if (sharedNodeId) return;
  const nodesTbl = (await import('../src/db/index.js')).nodes;
  const investorsTbl = (await import('../src/db/index.js')).investors;
  const [n] = await db.insert(nodesTbl).values({ name: 'Node', email: 'node@example.com' }).returning();
  const [i] = await db.insert(investorsTbl).values({ name: 'Investor' }).returning();
  sharedNodeId = n.id; sharedInvestorId = i.id;
}
async function addIntro(founderId: number, status: string) {
  await ensureNodeInvestor();
  await db.insert(introRequests).values({
    founderId, nodeId: sharedNodeId, investorId: sharedInvestorId, status,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
}

test('finalizeCalibrationIfReady: sets speed from accept rate and stamps', async () => {
  const id = await makeFounder(1);   // calibrated_at null, cadence active
  // 3 accepted, 5 passed, 2 pending → decided 8, rate 3/8=0.375 → target 5
  for (const s of ['introduced', 'introduced', 'introduced', 'passed', 'passed', 'passed', 'passed', 'passed', 'intro_request_sent', 'intro_request_sent']) {
    await addIntro(id, s);
  }
  const view = await treadmill.finalizeCalibrationIfReady(id);
  assert.ok(view, 'should finalize');
  assert.equal(view.recommendedTarget, 5);
  const f = await db.query.founders.findFirst({ where: eq(founders.id, id) });
  assert.equal(f.introTargetPerWeek, 5);
  assert.ok(f.calibratedAt, 'calibratedAt stamped');

  // Idempotent: already calibrated → no-op
  assert.equal(await treadmill.finalizeCalibrationIfReady(id), null);
});

test('finalizeCalibrationIfReady: still sending → no change', async () => {
  const id = await makeFounder(1);
  for (const s of ['intro_request_sent', 'introduced', 'passed']) await addIntro(id, s);
  assert.equal(await treadmill.finalizeCalibrationIfReady(id), null);
  const f = await db.query.founders.findFirst({ where: eq(founders.id, id) });
  assert.equal(f.calibratedAt, null);
});

test('getTreadmillReading: shows calibration state while sending', async () => {
  const id = await makeFounder(1);   // calibrated_at null, active
  for (const s of ['intro_request_sent', 'introduced', 'passed']) await addIntro(id, s);
  const r = await treadmill.getTreadmillReading(id);
  assert.equal(r.calibrating, true);
  assert.equal(r.calibration.phase, 'sending');
  assert.equal(r.calibration.sentCount, 3);
  assert.equal(r.calibration.target, 10);
});
