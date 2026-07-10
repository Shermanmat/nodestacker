/**
 * Apply the system's accept-rate-based weekly intro-request pace to founders.
 *
 * For each founder that has FINISHED calibration (calibrated_at set — i.e. not a
 * new founder mid-burst), compute their pace from their intro-request acceptance
 * rate and set founders.intro_target_per_week to it. Founders still calibrating
 * are skipped (their pace comes from the calibration burst, not this).
 *
 * Bands (src/services/treadmill.ts): >=30% -> 5, >=25% -> 4, >=15% -> 2, <15% -> 1;
 * fewer than 4 decided requests -> 2 (neutral, insufficient signal).
 *
 * Lives at src/ (not src/scripts, which tsconfig excludes from the build) so it
 * compiles into dist/ and can run in the production image.
 *
 * DRY RUN by default — prints the plan and changes nothing:
 *   node dist/apply-system-paces.js
 * Pass --apply to actually write:
 *   node dist/apply-system-paces.js --apply
 *
 * Against PRODUCTION (runs on the Fly machine, writes the live DB — deploy first):
 *   fly ssh console --app nodestacker -C "node dist/apply-system-paces.js"
 *   fly ssh console --app nodestacker -C "node dist/apply-system-paces.js --apply"
 */

import { eq, and, isNotNull } from 'drizzle-orm';
import { db, founders, introRequests } from './db/index.js';
import { acceptRateOf } from './services/treadmill.js';

const APPLY = process.argv.includes('--apply');

// NEW bands (preview of the "pace = acceptance only" model — computed inline here
// so it doesn't change live behavior until we build the full model):
//   >=30% -> 5, >=25% -> 4, >=20% -> 2, 17-19% -> 2 + WARNING, <17% -> 1.
//   <4 decided -> 2 (neutral, insufficient signal).
function paceFor(rate: number | null): { pace: number; warn: boolean } {
  if (rate === null) return { pace: 2, warn: false };
  if (rate >= 0.30) return { pace: 5, warn: false };
  if (rate >= 0.25) return { pace: 4, warn: false };
  if (rate >= 0.20) return { pace: 2, warn: false };
  if (rate >= 0.17) return { pace: 2, warn: true };   // warning zone
  return { pace: 1, warn: false };                     // <17% → 1
}

async function main() {
  const rows = await db.select({ id: founders.id, name: founders.name, cur: founders.introTargetPerWeek })
    .from(founders)
    .where(and(eq(founders.introCadenceActive, true), isNotNull(founders.calibratedAt)));   // actively raising, done calibrating

  const plan: Array<{ id: number; name: string; cur: number; next: number; warn: boolean; pct: number | null; decided: number }> = [];
  for (const f of rows) {
    const intros = await db.select({ status: introRequests.status })
      .from(introRequests).where(eq(introRequests.founderId, f.id));
    if (intros.length === 0) continue;   // no requests → nothing to base a pace on
    const { rate, decided } = acceptRateOf(intros);
    const { pace, warn } = paceFor(rate);
    const cur = f.cur ?? 1;
    plan.push({ id: f.id, name: f.name, cur, next: pace, warn, pct: rate !== null ? Math.round(rate * 100) : null, decided });
  }

  plan.sort((a, b) => b.next - a.next);
  const changes = plan.filter(p => p.next !== p.cur);

  console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'} (actively-raising founders) — ${plan.length} evaluated, ${changes.length} would change:\n`);
  console.log('FOUNDER'.padEnd(22), 'ACCEPT%', 'DECIDED', 'CUR', '->', 'NEW');
  console.log('-'.repeat(60));
  for (const p of plan) {
    const mark = p.next !== p.cur ? (p.next > p.cur ? ' up' : ' dn') : '';
    console.log(
      p.name.slice(0, 21).padEnd(22),
      (p.pct === null ? '—' : p.pct + '%').padStart(7),
      String(p.decided).padStart(7),
      String(p.cur).padStart(3), '->', String(p.next).padStart(3),
      mark + (p.warn ? ' ⚠️warn' : ''),
    );
  }

  if (!APPLY) {
    console.log('\nDry run only. Re-run with --apply to write these values.');
    return;
  }

  let written = 0;
  for (const p of changes) {
    await db.update(founders).set({ introTargetPerWeek: p.next }).where(eq(founders.id, p.id));
    written++;
  }
  console.log(`\nDone — updated ${written} founders.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
