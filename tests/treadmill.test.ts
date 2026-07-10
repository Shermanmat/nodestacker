/**
 * Momentum tests — pace = acceptance rate.
 *  - speedFromAcceptRate / acceptBracket / isWarning: the 5-4-3-2-1 ladder
 *  - recomputePace: writes introTargetPerWeek from a founder's acceptance rate
 *  - calibration: new founders set from the burst
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

let db: any, founders: any, introRequests: any, eq: any;
let treadmill: typeof import('../src/services/treadmill.js');

before(async () => {
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
  db = dbMod.db; founders = dbMod.founders; introRequests = dbMod.introRequests;
  ({ eq } = await import('drizzle-orm'));
  treadmill = await import('../src/services/treadmill.js');
});

after(() => { if (existsSync(TMP_DB)) rmSync(TMP_DB); });

// ── The ladder ───────────────────────────────────────────────────────────────

test('speedFromAcceptRate: 5-4-3-2-1 ladder', () => {
  const { speedFromAcceptRate } = treadmill;
  assert.equal(speedFromAcceptRate(0.40), 5);  // exceptional
  assert.equal(speedFromAcceptRate(0.30), 5);  // top threshold
  assert.equal(speedFromAcceptRate(0.29), 4);  // strong
  assert.equal(speedFromAcceptRate(0.25), 4);
  assert.equal(speedFromAcceptRate(0.24), 3);  // solid
  assert.equal(speedFromAcceptRate(0.20), 3);
  assert.equal(speedFromAcceptRate(0.19), 2);  // slipping
  assert.equal(speedFromAcceptRate(0.17), 2);
  assert.equal(speedFromAcceptRate(0.169), 1); // <17% → 1
  assert.equal(speedFromAcceptRate(0.00), 1);
});

test('acceptBracket: labels + supported pace', () => {
  const { acceptBracket } = treadmill;
  assert.deepEqual(acceptBracket(0.35), { label: 'exceptional', supports: 5 });
  assert.deepEqual(acceptBracket(0.27), { label: 'strong', supports: 4 });
  assert.deepEqual(acceptBracket(0.22), { label: 'solid', supports: 3 });
  assert.deepEqual(acceptBracket(0.18), { label: 'slipping', supports: 2 });
  assert.deepEqual(acceptBracket(0.10), { label: 'at risk', supports: 1 });
});

test('isWarning: only the 17–19% zone', () => {
  const { isWarning } = treadmill;
  assert.equal(isWarning(0.18), true);
  assert.equal(isWarning(0.17), true);
  assert.equal(isWarning(0.20), false);  // solid, not warning
  assert.equal(isWarning(0.169), false); // already dropped to 1
  assert.equal(isWarning(null), false);
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

let seq = 0;
async function makeFounder(opts: { target?: number; calibrated?: boolean; active?: boolean } = {}): Promise<number> {
  const [f] = await db.insert(founders).values({
    name: 'Test Founder', email: `treadmill-test-${++seq}@example.com`,
    companyName: 'Test Co', companyStage: 'pre-seed',
    introTargetPerWeek: opts.target ?? 2,
    introCadenceActive: opts.active ?? true,
    calibratedAt: opts.calibrated ? new Date().toISOString() : null,
    createdAt: new Date().toISOString(),
  }).returning();
  return f.id;
}
let sharedNodeId = 0, sharedInvestorId = 0;
async function ensureNodeInvestor() {
  if (sharedNodeId) return;
  const dbMod = await import('../src/db/index.js');
  const [n] = await db.insert(dbMod.nodes).values({ name: 'Node', email: 'node@example.com' }).returning();
  const [i] = await db.insert(dbMod.investors).values({ name: 'Investor' }).returning();
  sharedNodeId = n.id; sharedInvestorId = i.id;
}
async function addIntros(founderId: number, statuses: string[]) {
  await ensureNodeInvestor();
  for (const status of statuses) {
    await db.insert(introRequests).values({
      founderId, nodeId: sharedNodeId, investorId: sharedInvestorId, status,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
  }
}

// ── Continuous pace = acceptance ─────────────────────────────────────────────

test('recomputePace: writes pace from acceptance rate', async () => {
  const id = await makeFounder({ target: 2, calibrated: true, active: true });
  // 3 accepted / 8 decided = 37.5% → 5
  await addIntros(id, ['introduced', 'introduced', 'introduced', 'passed', 'passed', 'passed', 'passed', 'passed']);
  assert.equal(await treadmill.recomputePace(id), 5);
  const f = await db.query.founders.findFirst({ where: eq(founders.id, id) });
  assert.equal(f.introTargetPerWeek, 5);
});

test('recomputePace: 20% → 3 (solid)', async () => {
  const id = await makeFounder({ target: 5, calibrated: true, active: true });
  // 2 accepted / 10 decided = 20% → 3
  await addIntros(id, ['introduced', 'introduced', ...Array(8).fill('passed')]);
  assert.equal(await treadmill.recomputePace(id), 3);
});

test('recomputePace: skips uncalibrated and paused founders', async () => {
  const uncal = await makeFounder({ calibrated: false, active: true });
  await addIntros(uncal, ['introduced', 'passed', 'passed', 'passed', 'passed']);
  assert.equal(await treadmill.recomputePace(uncal), null);

  const paused = await makeFounder({ calibrated: true, active: false });
  await addIntros(paused, ['introduced', 'passed', 'passed', 'passed', 'passed']);
  assert.equal(await treadmill.recomputePace(paused), null);
});

test('recomputePace: too little data → neutral 2', async () => {
  const id = await makeFounder({ target: 4, calibrated: true, active: true });
  await addIntros(id, ['introduced', 'passed']); // 2 decided < MIN_SAMPLE
  assert.equal(await treadmill.recomputePace(id), 2);
});

// ── Calibration ──────────────────────────────────────────────────────────────

test('calibrationView: phases + recommended target', () => {
  const { calibrationView } = treadmill;
  const sent = (status: string) => ({ status, createdAt: new Date().toISOString() });

  assert.equal(calibrationView([...Array(4)].map(() => sent('intro_request_sent'))).phase, 'sending');

  const wait = calibrationView([...[...Array(8)].map(() => sent('intro_request_sent')), sent('introduced'), sent('passed')]);
  assert.equal(wait.phase, 'waiting');

  // 3 accepted / 8 decided = 37.5% → 5
  const ready = calibrationView([
    sent('introduced'), sent('introduced'), sent('introduced'),
    sent('passed'), sent('passed'), sent('passed'), sent('passed'), sent('passed'),
    sent('intro_request_sent'), sent('intro_request_sent'),
  ]);
  assert.equal(ready.phase, 'ready');
  assert.equal(ready.recommendedTarget, 5);

  // 1 accepted / 10 → 10% → 1 + messaging concern
  const weak = calibrationView([sent('introduced'), ...[...Array(9)].map(() => sent('passed'))]);
  assert.equal(weak.recommendedTarget, 1);
  assert.equal(weak.messagingConcern, true);
});

test('finalizeCalibrationIfReady: sets pace from accept rate and stamps', async () => {
  const id = await makeFounder({ target: 1, calibrated: false, active: true });
  await addIntros(id, ['introduced', 'introduced', 'introduced', 'passed', 'passed', 'passed', 'passed', 'passed', 'intro_request_sent', 'intro_request_sent']);
  const view = await treadmill.finalizeCalibrationIfReady(id);
  assert.ok(view, 'should finalize');
  assert.equal(view.recommendedTarget, 5);
  const f = await db.query.founders.findFirst({ where: eq(founders.id, id) });
  assert.equal(f.introTargetPerWeek, 5);
  assert.ok(f.calibratedAt);
  assert.equal(await treadmill.finalizeCalibrationIfReady(id), null); // idempotent
});

// ── Reading ──────────────────────────────────────────────────────────────────

test('getTreadmillReading: calibrating state while sending', async () => {
  const id = await makeFounder({ calibrated: false, active: true });
  await addIntros(id, ['intro_request_sent', 'introduced', 'passed']);
  const r = await treadmill.getTreadmillReading(id);
  assert.equal(r.calibrating, true);
  assert.equal(r.calibration.phase, 'sending');
  assert.equal(r.calibration.sentCount, 3);
});

test('getTreadmillReading: explainer shows bracket + warning', async () => {
  const id = await makeFounder({ target: 2, calibrated: true, active: true });
  // 2 accepted / 11 decided ≈ 18% → slipping/warning
  await addIntros(id, ['introduced', 'introduced', ...Array(9).fill('passed')]);
  const r = await treadmill.getTreadmillReading(id);
  assert.equal(r.calibrating, false);
  assert.equal(r.explainer.bracket, 'slipping');
  assert.equal(r.explainer.warning, true);
  assert.equal(r.explainer.acceptRatePct, 18);
});
