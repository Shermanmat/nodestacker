import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import {
  db,
  founders,
  investors,
  introRequests,
  founderCategoryAssignments,
  investorCategoryAssignments,
  investorCategoryExclusions,
  investorCategories,
  personaHotnessTiers,
  nodeInvestorConnections,
  type IntroRequest,
} from '../db/index.js';
import {
  computeFounderStaticHeat,
  computeFounderDynamicHeat,
  computeFounderHeatScore,
  computeInvestorReliabilityScore,
  isInvestorOnCooldown,
} from '../services/matching.js';

const app = new Hono();

app.get('/', async (c) => {
  // --- Bulk load all data ---
  const [
    allFounders,
    allInvestors,
    allIntroRequests,
    allNiConns,
    allPersonaTiers,
  ] = await Promise.all([
    db.select().from(founders),
    db.select().from(investors),
    db.select().from(introRequests),
    db.select().from(nodeInvestorConnections),
    db.select().from(personaHotnessTiers),
  ]);

  // Category assignments with joins
  const [founderCatAssignments, investorCatAssignments, exclusionAssignments, allCats] = await Promise.all([
    db.select({
      founderId: founderCategoryAssignments.founderId,
      categoryId: founderCategoryAssignments.categoryId,
      categoryName: investorCategories.name,
      categoryType: investorCategories.type,
    }).from(founderCategoryAssignments)
      .innerJoin(investorCategories, eq(founderCategoryAssignments.categoryId, investorCategories.id)),
    db.select({
      investorId: investorCategoryAssignments.investorId,
      categoryId: investorCategoryAssignments.categoryId,
      categoryName: investorCategories.name,
      categoryType: investorCategories.type,
    }).from(investorCategoryAssignments)
      .innerJoin(investorCategories, eq(investorCategoryAssignments.categoryId, investorCategories.id)),
    db.select({
      investorId: investorCategoryExclusions.investorId,
      categoryId: investorCategoryExclusions.categoryId,
    }).from(investorCategoryExclusions),
    db.select().from(investorCategories),
  ]);

  // --- Build parent/child category expansion ---
  const parentChildMap = new Map<number, { id: number; name: string; type: string }[]>();
  for (const cat of allCats) {
    if (cat.parentId) {
      if (!parentChildMap.has(cat.parentId)) parentChildMap.set(cat.parentId, []);
      parentChildMap.get(cat.parentId)!.push({ id: cat.id, name: cat.name, type: cat.type });
    }
  }

  // --- Build founder category map ---
  const founderCatMap = new Map<number, { id: number; name: string; type: string }[]>();
  for (const a of founderCatAssignments) {
    if (!founderCatMap.has(a.founderId)) founderCatMap.set(a.founderId, []);
    founderCatMap.get(a.founderId)!.push({ id: a.categoryId, name: a.categoryName, type: a.categoryType });
  }

  // --- Build investor category map with parent expansion ---
  const investorCatMap = new Map<number, { id: number; name: string; type: string }[]>();
  for (const a of investorCatAssignments) {
    if (!investorCatMap.has(a.investorId)) investorCatMap.set(a.investorId, []);
    investorCatMap.get(a.investorId)!.push({ id: a.categoryId, name: a.categoryName, type: a.categoryType });
  }
  for (const [, cats] of investorCatMap) {
    const expanded: { id: number; name: string; type: string }[] = [];
    for (const cat of cats) {
      const children = parentChildMap.get(cat.id);
      if (children) {
        for (const child of children) {
          if (!cats.some(c => c.id === child.id) && !expanded.some(c => c.id === child.id)) {
            expanded.push(child);
          }
        }
      }
    }
    if (expanded.length > 0) cats.push(...expanded);
  }

  // --- Build investor exclusion map with parent expansion ---
  const investorExclusionMap = new Map<number, Set<number>>();
  for (const e of exclusionAssignments) {
    if (!investorExclusionMap.has(e.investorId)) investorExclusionMap.set(e.investorId, new Set());
    investorExclusionMap.get(e.investorId)!.add(e.categoryId);
  }
  for (const [, excludedIds] of investorExclusionMap) {
    const expanded: number[] = [];
    for (const catId of excludedIds) {
      const children = parentChildMap.get(catId);
      if (children) {
        for (const child of children) {
          if (!excludedIds.has(child.id)) expanded.push(child.id);
        }
      }
    }
    for (const id of expanded) excludedIds.add(id);
  }

  // --- Build persona tier map ---
  const personaTierMap = new Map<string, number>();
  for (const pt of allPersonaTiers) {
    personaTierMap.set(pt.persona, pt.tier);
  }

  // --- Group intro requests ---
  const investorIntroMap = new Map<number, IntroRequest[]>();
  const founderIntroMap = new Map<number, IntroRequest[]>();
  for (const ir of allIntroRequests) {
    if (!investorIntroMap.has(ir.investorId)) investorIntroMap.set(ir.investorId, []);
    investorIntroMap.get(ir.investorId)!.push(ir);
    if (!founderIntroMap.has(ir.founderId)) founderIntroMap.set(ir.founderId, []);
    founderIntroMap.get(ir.founderId)!.push(ir);
  }

  // --- Eligible founders ---
  const eligibleFounders = allFounders.filter(f =>
    !f.hidden && f.introCadenceActive && f.roundStatus !== 'round_closed'
  );

  // --- Compute investor metrics ---
  const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;
  const activeInvestors = allInvestors.filter(inv => inv.active);

  const investorMetrics = activeInvestors.map(inv => {
    const intros = investorIntroMap.get(inv.id) || [];
    const reliabilityScore = computeInvestorReliabilityScore(intros);
    const cooldown = isInvestorOnCooldown(intros);
    const introsLast90Days = intros.filter(ir =>
      ir.createdAt && new Date(ir.createdAt).getTime() > ninetyDaysAgo
    ).length;
    const cats = investorCatMap.get(inv.id) || [];
    const sectors = cats.filter(c => c.type === 'sector').map(c => c.name);
    const isGeneralist = sectors.some(s => s.toLowerCase() === 'generalist');

    // Dormancy check (same logic as /api/investors/health)
    const lastIntroDate = intros
      .filter(ir => ir.dateIntroduced)
      .sort((a, b) => new Date(b.dateIntroduced!).getTime() - new Date(a.dateIntroduced!).getTime())[0]?.dateIntroduced;
    const daysSinceLastIntro = lastIntroDate
      ? Math.floor((Date.now() - new Date(lastIntroDate).getTime()) / (1000 * 60 * 60 * 24))
      : null;
    const isDormant = (daysSinceLastIntro !== null && daysSinceLastIntro > 90) ||
      (intros.length >= 3 && intros.every(ir => ir.status === 'ignored'));

    let utilizationStatus: string;
    if (isDormant) utilizationStatus = 'dormant';
    else if (cooldown.onCooldown) utilizationStatus = 'cooldown';
    else if (introsLast90Days > 6) utilizationStatus = 'over';
    else if (introsLast90Days === 0) utilizationStatus = 'under';
    else utilizationStatus = 'normal';

    return {
      id: inv.id,
      name: inv.name,
      firm: inv.firm,
      introsLast90Days,
      onCooldown: cooldown.onCooldown,
      cooldownReason: cooldown.onCooldown ? cooldown.reason : null,
      reliabilityScore,
      sectors,
      isGeneralist,
      utilizationStatus,
      sectorCategoryIds: cats.filter(c => c.type === 'sector').map(c => c.id),
      excludedCategoryIds: Array.from(investorExclusionMap.get(inv.id) || []),
    };
  });

  // --- Sector Balance ---
  const sectorCategories = allCats.filter(c => c.type === 'sector' && c.name.toLowerCase() !== 'generalist');

  const sectorBalanceData = sectorCategories.map(sector => {
    // Count eligible founders with this sector
    const founderCount = eligibleFounders.filter(f => {
      const cats = founderCatMap.get(f.id) || [];
      return cats.some(c => c.id === sector.id && c.type === 'sector');
    }).length;

    // Count active investors covering this sector (including generalists)
    const matchingInvestors = investorMetrics.filter(inv =>
      inv.sectorCategoryIds.includes(sector.id) ||
      (inv.isGeneralist && !inv.excludedCategoryIds.includes(sector.id))
    );
    const investorCountTotal = matchingInvestors.length;
    const investorsAvailable = matchingInvestors.filter(inv => !inv.onCooldown && inv.utilizationStatus !== 'dormant').length;
    const investorsOnCooldown = matchingInvestors.filter(inv => inv.onCooldown).length;

    const ratio = investorsAvailable > 0 ? founderCount / investorsAvailable : founderCount > 0 ? Infinity : 0;

    let status: string;
    if (founderCount === 0) status = 'no_demand';
    else if (investorsAvailable === 0) status = 'severe';
    else if (ratio > 15) status = 'severe';
    else if (ratio > 5) status = 'tight';
    else status = 'balanced';

    return {
      categoryId: sector.id,
      categoryName: sector.name,
      founderCount,
      investorCount: investorsAvailable,
      investorCountTotal,
      ratio: ratio === Infinity ? null : Math.round(ratio * 10) / 10,
      status,
      investorsOnCooldown,
      investorsAvailable,
    };
  }).sort((a, b) => {
    // Sort severe first, then tight, then balanced, then no_demand
    const order: Record<string, number> = { severe: 0, tight: 1, balanced: 2, no_demand: 3 };
    return (order[a.status] ?? 4) - (order[b.status] ?? 4);
  });

  const sectorSummary = {
    totalSectors: sectorBalanceData.length,
    balanced: sectorBalanceData.filter(s => s.status === 'balanced').length,
    tight: sectorBalanceData.filter(s => s.status === 'tight').length,
    severe: sectorBalanceData.filter(s => s.status === 'severe').length,
  };

  // --- Investor Utilization Summary ---
  const utilizationSummary = {
    totalActive: investorMetrics.length,
    overUtilized: investorMetrics.filter(i => i.utilizationStatus === 'over').length,
    underUtilized: investorMetrics.filter(i => i.utilizationStatus === 'under').length,
    onCooldown: investorMetrics.filter(i => i.utilizationStatus === 'cooldown').length,
    utilizationRate: investorMetrics.length > 0
      ? Math.round((investorMetrics.filter(i => i.introsLast90Days > 0).length / investorMetrics.length) * 100)
      : 0,
  };

  // --- Coverage Gaps & Waitlist ---
  // A gap exists when a sector has founders but zero or insufficient investors
  const gapSectors = sectorBalanceData.filter(s => s.status === 'severe' || s.status === 'tight');

  // Compute heat scores for all eligible founders
  const founderHeatScores = new Map<number, number>();
  for (const founder of eligibleFounders) {
    const founderCats = founderCatMap.get(founder.id) || [];
    const founderIntros = founderIntroMap.get(founder.id) || [];
    const staticHeat = computeFounderStaticHeat(founderCats, personaTierMap);
    const dynamicHeat = computeFounderDynamicHeat(founderIntros);
    founderHeatScores.set(founder.id, computeFounderHeatScore(staticHeat, dynamicHeat));
  }

  const coverageGaps = gapSectors.map(sector => {
    // Find founders in this sector
    const waitlistedFounders = eligibleFounders
      .filter(f => {
        const cats = founderCatMap.get(f.id) || [];
        return cats.some(c => c.id === sector.categoryId && c.type === 'sector');
      })
      .map(f => ({
        id: f.id,
        name: f.name,
        companyName: f.companyName,
        heatScore: founderHeatScores.get(f.id) || 0,
        waitlistPosition: 0, // filled after sort
        reason: sector.investorCount === 0
          ? `0 available investors in ${sector.categoryName}`
          : `Only ${sector.investorCount} investor(s) for ${sector.founderCount} founders in ${sector.categoryName}`,
      }))
      .sort((a, b) => b.heatScore - a.heatScore);

    // Assign positions
    waitlistedFounders.forEach((f, i) => { f.waitlistPosition = i + 1; });

    return {
      categoryId: sector.categoryId,
      categoryName: sector.categoryName,
      founderCount: sector.founderCount,
      investorCount: sector.investorCount,
      gap: sector.investorCount === 0 ? 'zero_coverage' : 'insufficient',
      waitlistedFounders,
    };
  });

  // --- Aggregated Waitlist ---
  // Deduplicate founders across gap sectors, keep highest position
  const founderWaitlistMap = new Map<number, {
    id: number;
    name: string;
    companyName: string | null;
    heatScore: number;
    sectors: string[];
    gapSectors: string[];
  }>();

  for (const gap of coverageGaps) {
    for (const f of gap.waitlistedFounders) {
      const existing = founderWaitlistMap.get(f.id);
      if (existing) {
        existing.gapSectors.push(gap.categoryName);
      } else {
        const cats = founderCatMap.get(f.id) || [];
        founderWaitlistMap.set(f.id, {
          id: f.id,
          name: f.name,
          companyName: f.companyName,
          heatScore: f.heatScore,
          sectors: cats.filter(c => c.type === 'sector').map(c => c.name),
          gapSectors: [gap.categoryName],
        });
      }
    }
  }

  const waitlistFounders = Array.from(founderWaitlistMap.values())
    .sort((a, b) => b.heatScore - a.heatScore)
    .map((f, i) => ({ ...f, waitlistPosition: i + 1 }));

  return c.json({
    sectorBalance: {
      summary: sectorSummary,
      sectors: sectorBalanceData,
    },
    investorUtilization: {
      summary: utilizationSummary,
      investors: investorMetrics.map(({ sectorCategoryIds, isGeneralist, excludedCategoryIds, ...rest }) => rest),
    },
    coverageGaps,
    waitlist: {
      total: waitlistFounders.length,
      founders: waitlistFounders,
    },
  });
});

export default app;
