import 'dotenv/config';
import { db } from '../db/index.js';
import { investorCategoryExclusions, investorCategoryAssignments, investorCategories } from '../db/index.js';
import { eq } from 'drizzle-orm';

async function main() {
  // Look up categories by name so IDs don't need to be hardcoded
  const allCats = await db.select().from(investorCategories);
  const findCat = (name: string) => allCats.find(c => c.name === name);

  const generalistCat = findCat('Generalist');
  if (!generalistCat) { console.error('Generalist category not found'); return; }

  const excludedNames = ['HardTech / DeepTech', 'Climate / Energy', 'Defense / Government'];
  const EXCLUDED_CAT_IDS = excludedNames.map(name => {
    const cat = findCat(name);
    if (!cat) { console.error(`Category "${name}" not found`); process.exit(1); }
    return cat.id;
  });

  console.log(`Generalist category ID: ${generalistCat.id}, excluded IDs: ${EXCLUDED_CAT_IDS}`);

  const genAssignments = await db.select()
    .from(investorCategoryAssignments)
    .where(eq(investorCategoryAssignments.categoryId, generalistCat.id));

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
