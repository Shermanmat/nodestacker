/**
 * One-off: analyze a mock VC call transcript from a text file and print the
 * readout. Stores the result on mock_call_analyses too.
 *
 *   tsx src/scripts/analyze-mock-call.ts <transcript.txt> [--founder <id>] [--company <id>]
 *
 * Requires ANTHROPIC_API_KEY in the environment (same as the app).
 */

import 'dotenv/config';
import { readFileSync } from 'fs';
import { analyzeMockCall } from '../services/mock-call-analyzer.js';

function argVal(flag: string): number | undefined {
  const i = process.argv.indexOf(flag);
  if (i === -1) return undefined;
  const n = parseInt(process.argv[i + 1]);
  return Number.isFinite(n) ? n : undefined;
}

async function main() {
  const file = process.argv[2];
  if (!file || file.startsWith('--')) {
    console.error('Usage: tsx src/scripts/analyze-mock-call.ts <transcript.txt> [--founder <id>] [--company <id>]');
    process.exit(1);
  }
  const transcript = readFileSync(file, 'utf8');

  const result = await analyzeMockCall({
    transcript,
    founderId: argVal('--founder'),
    publicCompanyId: argVal('--company'),
  });
  if (!result) {
    console.error('Analyzer returned nothing — is ANTHROPIC_API_KEY set?');
    process.exit(1);
  }

  const { id, analysis } = result;
  console.log(`\n=== Mock call analysis #${id} ===`);
  console.log(`Overall readiness: ${analysis.overallScore}/10`);
  console.log(`\n${analysis.summary}\n`);

  console.log('Scorecard:');
  for (const s of analysis.scorecard) console.log(`  ${s.dimension}: ${s.score}/5 — ${s.note}`);

  console.log('\nBlind spots:');
  for (const b of analysis.blindSpots) console.log(`  • ${b.issue}\n    moment: ${b.moment}\n    why it matters: ${b.whyItMatters}`);

  console.log('\nCoaching (before the next call):');
  for (const cc of analysis.coaching) console.log(`  → ${cc.fix}\n    how: ${cc.how}`);

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
