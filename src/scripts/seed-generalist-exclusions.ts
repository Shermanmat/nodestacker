import 'dotenv/config';
import { db } from '../db/index.js';
import { investorCategoryExclusions, investorCategoryAssignments } from '../db/index.js';
import { eq } from 'drizzle-orm';

async function main() {
  const GENERALIST_CAT_ID = 186;
  const EXCLUDED_CAT_IDS = [154, 148, 160]; // HardTech, Climate, Defense

  const genAssignments = await db.select()
    .from(investorCategoryAssignments)
    .where(eq(investorCategoryAssignments.categoryId, GENERALIST_CAT_ID));

  console.log(`Found ${genAssignments.length} generalist investors`);

  let created = 0;
  let skipped = 0;

  for (const assignment of genAssignments) {
    // Get all sector assignments for this investor
    const allAssignments = await db.select()
      .from(investorCategoryAssignments)
      .where(eq(investorCategoryAssignments.investorId, assignment.investorId));
    const assignedCatIds = new Set(allAssignments.map(a => a.categoryId));

    for (const catId of EXCLUDED_CAT_IDS) {
      // Skip if they have an explicit assignment to this sector
      if (assignedCatIds.has(catId)) {
        skipped++;
        continue;
      }
      await db.insert(investorCategoryExclusions).values({
        investorId: assignment.investorId,
        categoryId: catId,
      });
      created++;
    }
  }

  console.log(`Created ${created} exclusions, skipped ${skipped} (investor had explicit sector assignment)`);
}

main();
