/**
 * One-off script: Fix intro requests from March 11 that were accidentally
 * assigned to Mat instead of Dylan Rose.
 *
 * Investors: Maddie (Boost VC), Arian, Ryan Hoover, Pat Matthews
 *
 * Usage: tsx src/scripts/fix-dylan-intros.ts
 */
import Database from 'better-sqlite3';

const dbPath = process.env.DATABASE_PATH || 'nodestacker.db';
const db = new Database(dbPath);

// Find Dylan Rose
const dylan = db.prepare(`SELECT id, name FROM founders WHERE name LIKE '%Dylan Rose%'`).get() as any;
if (!dylan) {
  console.error('Could not find Dylan Rose in founders table');
  process.exit(1);
}
console.log(`Found Dylan Rose: id=${dylan.id}`);

// Find the 4 investors
const investorPatterns = ['%Maddie%', '%Arian%', '%Ryan Hoover%', '%Pat Matthews%'];
const investorIds: number[] = [];

for (const pattern of investorPatterns) {
  const inv = db.prepare(`SELECT id, name, firm FROM investors WHERE name LIKE ?`).all(pattern) as any[];
  if (inv.length === 0) {
    console.warn(`⚠️  No investor found matching "${pattern}"`);
  } else if (inv.length > 1) {
    console.warn(`⚠️  Multiple investors matching "${pattern}":`);
    inv.forEach((i: any) => console.log(`   id=${i.id} ${i.name} ${i.firm || ''}`));
    // Still collect them all
    inv.forEach((i: any) => investorIds.push(i.id));
  } else {
    console.log(`Found investor: ${inv[0].name} (id=${inv[0].id})`);
    investorIds.push(inv[0].id);
  }
}

if (investorIds.length === 0) {
  console.error('No investors found, aborting');
  process.exit(1);
}

// Find intro requests from March 11 for those investors that are NOT Dylan's
const placeholders = investorIds.map(() => '?').join(',');
const intros = db.prepare(`
  SELECT ir.id, ir.founderId, ir.investorId, ir.dateRequested, ir.createdAt, f.name as founderName, i.name as investorName
  FROM intro_requests ir
  JOIN founders f ON f.id = ir.founderId
  JOIN investors i ON i.id = ir.investorId
  WHERE ir.investorId IN (${placeholders})
    AND ir.founderId != ?
    AND (ir.createdAt LIKE '2025-03-11%' OR ir.dateRequested LIKE '2025-03-11%'
      OR ir.createdAt LIKE '2026-03-11%' OR ir.dateRequested LIKE '2026-03-11%')
`).all(...investorIds, dylan.id) as any[];

console.log(`\nFound ${intros.length} intro requests to fix:`);
intros.forEach((ir: any) => {
  console.log(`  #${ir.id}: ${ir.founderName} → ${ir.investorName} (created ${ir.createdAt})`);
});

if (intros.length === 0) {
  console.log('Nothing to fix!');
  process.exit(0);
}

// Update them
const update = db.prepare(`UPDATE intro_requests SET founderId = ?, updatedAt = ? WHERE id = ?`);
const now = new Date().toISOString();

for (const ir of intros) {
  update.run(dylan.id, now, ir.id);
  console.log(`✅ Updated #${ir.id}: founderId ${ir.founderId} → ${dylan.id}`);
}

console.log(`\nDone! Updated ${intros.length} intro requests to Dylan Rose.`);
