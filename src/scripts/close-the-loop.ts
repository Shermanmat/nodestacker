/**
 * Close-the-loop nudge — manual runner / verifier.
 *
 *   npx tsx src/scripts/close-the-loop.ts            # dry run: print who WOULD be nudged
 *   npx tsx src/scripts/close-the-loop.ts --sample   # send ONE real-looking email to ADMIN_EMAIL
 *   npx tsx src/scripts/close-the-loop.ts --live      # actually send to founders + advance counters
 *
 * The daily cron in index.ts calls runCloseTheLoop() directly; this script is for
 * local verification and one-off manual sends.
 */
import { runCloseTheLoop, sendCloseLoopSampleToAdmin } from '../services/close-the-loop.js';

async function main() {
  const arg = process.argv[2];

  if (arg === '--sample') {
    const r = await sendCloseLoopSampleToAdmin();
    console.log(`Sample nudge sent to ${r.sentTo} (based on: ${r.basedOn}).`);
    return;
  }

  const dryRun = arg !== '--live';
  const result = await runCloseTheLoop({ dryRun });

  console.log(`\n${dryRun ? 'DRY RUN — nothing sent' : 'LIVE — emails sent'}`);
  console.log(`Founders due: ${result.preview.length} · intros: ${result.intros} · sent: ${result.sent}`);
  if (result.preview.length) {
    console.log('\n  founder                email                          intros  subject');
    console.log('  ' + '-'.repeat(90));
    for (const p of result.preview) {
      console.log(`  ${p.founder.padEnd(22).slice(0, 22)} ${p.email.padEnd(30).slice(0, 30)} ${String(p.intros).padStart(6)}  ${p.subject}`);
    }
  }
  if (result.errors.length) {
    console.log('\n  errors:');
    for (const e of result.errors) console.log('   - ' + e);
  }
  if (dryRun) console.log('\nRun with --sample to email yourself a preview, or --live to send for real.');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
