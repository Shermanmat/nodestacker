import { eq, and, inArray } from 'drizzle-orm';
import {
  db,
  founders,
  investors,
  nodes,
  introRequests,
  founderNodeRelationships,
  nodeInvestorConnections,
  founderCategoryAssignments,
  investorCategoryAssignments,
  investorCategoryExclusions,
  investorCategories,
  personaHotnessTiers,
  matchSuggestions,
  type IntroRequest,
  type MatchSuggestion,
} from '../db/index.js';

// --- Scoring Functions ---

/**
 * Compute the static component of founder heat based on persona tier.
 * Returns 0-100.
 */
export function computeFounderStaticHeat(
  founderCategories: { id: number; name: string; type: string }[],
  personaTiers: Map<string, number>, // persona key -> tier (1-7)
): number {
  const personaCats = founderCategories.filter(c => c.type === 'persona');

  if (personaCats.length === 0) return 50; // Default middle score if no persona assigned

  let maxTier = 0;
  for (const cat of personaCats) {
    // Normalize: category name like "High Slope Builder" -> "high_slope_builder"
    const tierKey = cat.name.toLowerCase().replace(/ /g, '_');
    const tier = personaTiers.get(tierKey) || 0;
    if (tier > maxTier) maxTier = tier;
  }

  // Scale tier (1-7) to 0-100
  return Math.round((maxTier / 7) * 100);
}

/**
 * Compute the dynamic component of founder heat based on intro responsiveness.
 * Returns 0-100.
 */
export function computeFounderDynamicHeat(founderIntros: IntroRequest[]): number {
  if (founderIntros.length === 0) return 50; // Neutral if new

  // Metric 1: Engagement rate — did founder progress past "introduced" to meetings?
  const introduced = founderIntros.filter(ir =>
    ['introduced', 'first_meeting_complete', 'second_meeting_complete',
      'invested', 'circle_back_round_opens', 'follow_up_questions'].includes(ir.status)
  );
  const progressed = founderIntros.filter(ir =>
    ['first_meeting_complete', 'second_meeting_complete', 'invested'].includes(ir.status)
  );
  const engagementRate = introduced.length > 0
    ? progressed.length / introduced.length
    : 0;

  // Metric 2: Speed to first meeting (median days from dateIntroduced to firstMeetingDate)
  const meetingDelays: number[] = [];
  for (const ir of founderIntros) {
    if (ir.dateIntroduced && ir.firstMeetingDate) {
      const days = (new Date(ir.firstMeetingDate).getTime() - new Date(ir.dateIntroduced).getTime())
        / (1000 * 60 * 60 * 24);
      if (days > 0 && days < 90) meetingDelays.push(days);
    }
  }
  const medianDelay = meetingDelays.length > 0
    ? meetingDelays.sort((a, b) => a - b)[Math.floor(meetingDelays.length / 2)]
    : 30;
  // Speed score: 7 days or less = 100, 30+ days = 0
  const speedScore = Math.max(0, Math.min(100, Math.round((1 - (medianDelay - 7) / 23) * 100)));

  // Metric 3: Recency of activity
  const now = Date.now();
  const recentActivity = founderIntros.some(ir => {
    const updated = ir.updatedAt ? new Date(ir.updatedAt).getTime() : 0;
    return (now - updated) < 30 * 24 * 60 * 60 * 1000;
  });
  const recencyBonus = recentActivity ? 15 : 0;

  const score = Math.round(
    (engagementRate * 100) * 0.5 +
    speedScore * 0.35 +
    recencyBonus
  );

  return Math.max(0, Math.min(100, score));
}

/**
 * Combined founder heat score. Static (persona) + Dynamic (responsiveness).
 */
export function computeFounderHeatScore(staticHeat: number, dynamicHeat: number): number {
  return Math.round(staticHeat * 0.4 + dynamicHeat * 0.6);
}

/**
 * Compute investor reliability score from their intro history.
 * Weighted toward response behavior. Returns 0-100.
 */
export function computeInvestorReliabilityScore(investorIntros: IntroRequest[]): number {
  const totalIntros = investorIntros.length;
  if (totalIntros === 0) return 50; // Unknown = neutral

  const ignored = investorIntros.filter(ir => ir.status === 'ignored').length;
  const responded = investorIntros.filter(ir =>
    ['introduced', 'first_meeting_complete', 'second_meeting_complete',
      'invested', 'circle_back_round_opens', 'follow_up_questions', 'passed'].includes(ir.status)
  ).length;

  // Component 1: Response rate (60% weight)
  const responseRate = totalIntros > 0 ? responded / totalIntros : 0;

  // Component 2: Ignore rate inverse (25% weight) — lower ignore rate = higher score
  const ignoreRate = totalIntros > 0 ? ignored / totalIntros : 0;
  const ignoreInverse = 1 - ignoreRate;

  // Component 3: Recency (15% weight) — how recently they've engaged
  const introductionDates = investorIntros
    .filter(ir => ir.dateIntroduced || ir.updatedAt)
    .map(ir => new Date(ir.dateIntroduced || ir.updatedAt).getTime());
  const lastActivityDate = introductionDates.length > 0
    ? Math.max(...introductionDates) : 0;
  const daysSince = lastActivityDate > 0
    ? (Date.now() - lastActivityDate) / (1000 * 60 * 60 * 24) : 180;
  const recencyScore = daysSince < 30 ? 100 : daysSince < 90 ? 60 : daysSince < 180 ? 30 : 10;

  const score = Math.round(
    (responseRate * 100) * 0.6 +
    (ignoreInverse * 100) * 0.25 +
    recencyScore * 0.15
  );

  return Math.max(0, Math.min(100, score));
}

// --- Cooldown Logic ---

export interface CooldownResult {
  onCooldown: boolean;
  reason: string | null;
  unresolvedCount: number;
}

/**
 * Check if an investor is on cooldown (should not receive new intros).
 */
export function isInvestorOnCooldown(investorIntros: IntroRequest[]): CooldownResult {
  // Unresolved = intro_request_sent (waiting for investor response)
  const unresolved = investorIntros.filter(ir => ir.status === 'intro_request_sent');
  if (unresolved.length > 0) {
    return {
      onCooldown: true,
      reason: `${unresolved.length} pending intro(s) awaiting response`,
      unresolvedCount: unresolved.length,
    };
  }

  // Throttle if 1+ intros made in last 3 weeks
  const threeWeeksAgo = Date.now() - 21 * 24 * 60 * 60 * 1000;
  const recentlyIntroduced = investorIntros.filter(ir => {
    if (ir.status !== 'introduced') return false;
    const d = ir.dateIntroduced ? new Date(ir.dateIntroduced).getTime() : 0;
    return d > threeWeeksAgo;
  });

  if (recentlyIntroduced.length >= 1) {
    return {
      onCooldown: true,
      reason: `${recentlyIntroduced.length} intro(s) made in last 3 weeks`,
      unresolvedCount: recentlyIntroduced.length,
    };
  }

  return { onCooldown: false, reason: null, unresolvedCount: 0 };
}

// --- Inverse Match Scoring ---

/**
 * Core inverse matching logic. Returns 0-100.
 */
export function computeInverseMatchScore(
  founderHeat: number,
  investorReliability: number,
  connectionStrength: string,
): number {
  // Connection strength bonus
  const strengthBonus = connectionStrength === 'strong' ? 15
    : connectionStrength === 'medium' ? 8
      : 0;

  let inverseBonus = 0;

  if (founderHeat < 40) {
    // Cold founder: strong preference for reliable investors
    if (investorReliability >= 70) {
      inverseBonus = 25;
    } else if (investorReliability >= 50) {
      inverseBonus = 10;
    }
    // Low reliability + cold founder = no bonus (low score)
  } else if (founderHeat > 70) {
    // Hot founder: solid baseline with any investor
    inverseBonus = 10; // baseline for hot founders
    if (investorReliability >= 40 && investorReliability < 70) {
      inverseBonus += 10; // slight preference for mid-tier (save hot investors for cold founders)
    } else if (investorReliability >= 70) {
      inverseBonus += 5; // still good, just lower priority
    }
  } else {
    // Mid founder: balanced, slight preference for better investors
    inverseBonus = Math.round(investorReliability * 0.15);
  }

  const baseScore = Math.round(
    (founderHeat + investorReliability) / 2 * 0.5 +
    inverseBonus +
    strengthBonus
  );

  return Math.max(0, Math.min(100, baseScore));
}

function describeMatchLogic(founderHeat: number, investorReliability: number): string {
  if (founderHeat < 40 && investorReliability >= 70) {
    return 'Cold founder paired with reliable investor to maximize conversion chance';
  }
  if (founderHeat > 70 && investorReliability < 70) {
    return 'Hot founder paired with mid-tier investor (saving reliable investors for cooler founders)';
  }
  if (founderHeat > 70) {
    return 'Hot founder — strong conversion likelihood with most investors';
  }
  return 'Balanced pairing based on overall quality';
}

// --- Data Loading ---

async function loadMatchingData() {
  const [
    allFounders,
    allInvestors,
    allIntroRequests,
    allFnRels,
    allNiConns,
    allPersonaTiers,
  ] = await Promise.all([
    db.select().from(founders),
    db.select().from(investors),
    db.select().from(introRequests),
    db.select().from(founderNodeRelationships),
    db.select().from(nodeInvestorConnections),
    db.select().from(personaHotnessTiers),
  ]);

  // Category assignments
  const founderCatAssignments = await db.select({
    founderId: founderCategoryAssignments.founderId,
    categoryId: founderCategoryAssignments.categoryId,
    categoryName: investorCategories.name,
    categoryType: investorCategories.type,
  }).from(founderCategoryAssignments)
    .innerJoin(investorCategories, eq(founderCategoryAssignments.categoryId, investorCategories.id));

  const investorCatAssignments = await db.select({
    investorId: investorCategoryAssignments.investorId,
    categoryId: investorCategoryAssignments.categoryId,
    categoryName: investorCategories.name,
    categoryType: investorCategories.type,
  }).from(investorCategoryAssignments)
    .innerJoin(investorCategories, eq(investorCategoryAssignments.categoryId, investorCategories.id));

  // Investor exclusions
  const exclusionAssignments = await db.select({
    investorId: investorCategoryExclusions.investorId,
    categoryId: investorCategoryExclusions.categoryId,
  }).from(investorCategoryExclusions);

  // Load all categories for parent/child expansion
  const allCats = await db.select().from(investorCategories);
  const parentChildMap = new Map<number, { id: number; name: string; type: string }[]>();
  for (const cat of allCats) {
    if (cat.parentId) {
      if (!parentChildMap.has(cat.parentId)) parentChildMap.set(cat.parentId, []);
      parentChildMap.get(cat.parentId)!.push({ id: cat.id, name: cat.name, type: cat.type });
    }
  }

  // Build maps
  const founderCatMap = new Map<number, { id: number; name: string; type: string }[]>();
  for (const a of founderCatAssignments) {
    if (!founderCatMap.has(a.founderId)) founderCatMap.set(a.founderId, []);
    founderCatMap.get(a.founderId)!.push({ id: a.categoryId, name: a.categoryName, type: a.categoryType });
  }

  const investorCatMap = new Map<number, { id: number; name: string; type: string }[]>();
  for (const a of investorCatAssignments) {
    if (!investorCatMap.has(a.investorId)) investorCatMap.set(a.investorId, []);
    investorCatMap.get(a.investorId)!.push({ id: a.categoryId, name: a.categoryName, type: a.categoryType });
  }

  // Expand parent sectors: if investor has a parent sector, add all its children
  for (const [investorId, cats] of investorCatMap) {
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
    if (expanded.length > 0) {
      cats.push(...expanded);
    }
  }

  const investorExclusionMap = new Map<number, Set<number>>();
  for (const e of exclusionAssignments) {
    if (!investorExclusionMap.has(e.investorId)) investorExclusionMap.set(e.investorId, new Set());
    investorExclusionMap.get(e.investorId)!.add(e.categoryId);
  }

  // Expand parent exclusions: if investor excludes a parent sector, exclude all children
  for (const [investorId, excludedIds] of investorExclusionMap) {
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

  const personaTierMap = new Map<string, number>();
  for (const pt of allPersonaTiers) {
    personaTierMap.set(pt.persona, pt.tier);
  }

  // Group intro requests
  const investorIntroMap = new Map<number, IntroRequest[]>();
  const founderIntroMap = new Map<number, IntroRequest[]>();
  for (const ir of allIntroRequests) {
    if (!investorIntroMap.has(ir.investorId)) investorIntroMap.set(ir.investorId, []);
    investorIntroMap.get(ir.investorId)!.push(ir);
    if (!founderIntroMap.has(ir.founderId)) founderIntroMap.set(ir.founderId, []);
    founderIntroMap.get(ir.founderId)!.push(ir);
  }

  return {
    allFounders,
    allInvestors,
    allIntroRequests,
    allFnRels,
    allNiConns,
    founderCatMap,
    investorCatMap,
    investorExclusionMap,
    personaTierMap,
    investorIntroMap,
    founderIntroMap,
  };
}

// --- Category Matching ---

/**
 * Check if a founder-investor pair passes category/sector filters.
 * Returns true if they're compatible.
 */
function passesCategoryFilter(
  founderCategories: { id: number; name: string; type: string }[],
  investorCategories: { id: number; name: string; type: string }[] | undefined,
  investorExclusions: Set<number> | undefined,
): boolean {
  const founderSectorIds = new Set(
    founderCategories.filter(c => c.type === 'sector').map(c => c.id)
  );

  // Check exclusions: if investor excludes any of the founder's sectors, reject
  if (investorExclusions && founderSectorIds.size > 0) {
    for (const sectorId of founderSectorIds) {
      if (investorExclusions.has(sectorId)) return false;
    }
  }

  // --- Sector filter ---
  // If investor has no sector categories, they default to generalist — any founder is fine
  const investorSectors = investorCategories
    ? investorCategories.filter(c => c.type === 'sector')
    : [];

  let sectorPass = true;
  if (investorSectors.length > 0) {
    // If investor has "Generalist" category, any founder sector is acceptable
    const isGeneralist = investorSectors.some(c => c.name.toLowerCase() === 'generalist');
    if (!isGeneralist) {
      // Strict match: founder must share at least one sector with investor
      if (founderSectorIds.size > 0) {
        const investorSectorIds = new Set(investorSectors.map(c => c.id));
        sectorPass = false;
        for (const id of founderSectorIds) {
          if (investorSectorIds.has(id)) { sectorPass = true; break; }
        }
      }
      // Founder has no sectors = matches anyone (sectorPass stays true)
    }
  }

  if (!sectorPass) return false;

  // --- Stage filter ---
  // If both investor and founder have stage categories, require at least one overlap.
  // If either side has no stage categories, skip the check (don't penalize untagged).
  const investorStages = investorCategories
    ? investorCategories.filter(c => c.type === 'stage')
    : [];
  const founderStages = founderCategories.filter(c => c.type === 'stage');

  if (investorStages.length > 0 && founderStages.length > 0) {
    const investorStageIds = new Set(investorStages.map(c => c.id));
    const hasStageOverlap = founderStages.some(c => investorStageIds.has(c.id));
    if (!hasStageOverlap) return false;
  }

  return true;
}

// --- Auto-Ramp ---

export interface RampUp {
  founderId: number;
  previousTarget: number;
  newTarget: number;
  heatScore: number;
}

export function computeRecommendedIntroTarget(heatScore: number, currentTarget: number): number {
  let recommended: number;
  if (heatScore >= 80) recommended = 4;
  else if (heatScore >= 60) recommended = 3;
  else if (heatScore >= 40) recommended = 2;
  else recommended = 1;
  // Only ramp up, never decrease automatically
  return Math.max(recommended, currentTarget);
}

// --- Match Generation ---

interface GeneratedSuggestion {
  founderId: number;
  nodeId: number;
  investorId: number;
  founderHeatScore: number;
  investorReliabilityScore: number;
  matchScore: number;
  matchReasoning: string;
  batchId: string;
}

/**
 * Generate match suggestions for eligible founders.
 */
export async function generateMatchSuggestions(
  targetFounderId?: number,
): Promise<{ suggestions: GeneratedSuggestion[]; batchId: string; rampUps: RampUp[] }> {
  const data = await loadMatchingData();
  const batchId = crypto.randomUUID();

  // Get existing pending/rejected suggestions to avoid duplicates and re-suggestions
  const existingSuggestions = await db.select().from(matchSuggestions)
    .where(inArray(matchSuggestions.status, ['pending', 'rejected']));
  const existingTriples = new Set(
    existingSuggestions.map(s => `${s.founderId}-${s.nodeId}-${s.investorId}`)
  );

  // Count intros in last 7 days per founder (including pending_suggestion — counts toward quota)
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const weeklyIntroCount = new Map<number, number>();
  for (const ir of data.allIntroRequests) {
    if (ir.createdAt && new Date(ir.createdAt).getTime() > sevenDaysAgo) {
      weeklyIntroCount.set(ir.founderId, (weeklyIntroCount.get(ir.founderId) || 0) + 1);
    }
  }

  // Track ramp-ups and effective targets
  const rampUps: RampUp[] = [];
  const effectiveTargets = new Map<number, number>();

  // Filter to eligible founders
  const eligibleFounders = data.allFounders.filter(f => {
    if (targetFounderId && f.id !== targetFounderId) return false;
    if (f.hidden) return false;
    if (!f.introCadenceActive) return false;
    if (f.roundStatus === 'round_closed') return false;
    return true;
  });

  // Pre-compute investor scores, cooldowns, and VIP status
  const investorScores = new Map<number, number>();
  const investorCooldowns = new Map<number, CooldownResult>();
  const investorVip = new Set<number>();
  for (const inv of data.allInvestors) {
    if (!inv.active) continue;
    const intros = data.investorIntroMap.get(inv.id) || [];
    investorScores.set(inv.id, computeInvestorReliabilityScore(intros));
    investorCooldowns.set(inv.id, isInvestorOnCooldown(intros));
    if (inv.vip) investorVip.add(inv.id);
  }

  const suggestions: GeneratedSuggestion[] = [];

  for (const founder of eligibleFounders) {
    const founderCats = data.founderCatMap.get(founder.id) || [];
    const founderIntros = data.founderIntroMap.get(founder.id) || [];
    const alreadyIntrodInvestorIds = new Set(founderIntros.map(ir => ir.investorId));

    // Compute founder intro acceptance rate for VIP gating.
    // Acceptance = intros that progressed to meeting or beyond, out of all introduced.
    // Requires minimum 3 intros to qualify (otherwise not enough data).
    const introduced = founderIntros.filter(ir =>
      ['introduced', 'first_meeting_complete', 'second_meeting_complete',
        'invested', 'follow_up_questions', 'circle_back_round_opens'].includes(ir.status)
    );
    const accepted = founderIntros.filter(ir =>
      ['first_meeting_complete', 'second_meeting_complete',
        'invested', 'follow_up_questions'].includes(ir.status)
    );
    const founderAcceptRate = introduced.length >= 3
      ? accepted.length / introduced.length
      : 0;
    // VIP threshold: founder needs ≥50% acceptance rate with at least 3 intros
    const qualifiesForVip = founderAcceptRate >= 0.5 && introduced.length >= 3;

    // Compute founder heat
    const staticHeat = computeFounderStaticHeat(founderCats, data.personaTierMap);
    const dynamicHeat = computeFounderDynamicHeat(founderIntros);
    const founderHeat = computeFounderHeatScore(staticHeat, dynamicHeat);

    // Auto-ramp intro target based on heat
    const currentTarget = founder.introTargetPerWeek || 2;
    const recommendedTarget = computeRecommendedIntroTarget(founderHeat, currentTarget);
    effectiveTargets.set(founder.id, recommendedTarget);
    if (recommendedTarget > currentTarget) {
      rampUps.push({
        founderId: founder.id,
        previousTarget: currentTarget,
        newTarget: recommendedTarget,
        heatScore: founderHeat,
      });
    }

    // Get founder's nodes
    const founderNodes = data.allFnRels.filter(r => r.founderId === founder.id);

    for (const fnRel of founderNodes) {
      const nodeConnections = data.allNiConns.filter(c => c.nodeId === fnRel.nodeId);

      for (const conn of nodeConnections) {
        const investorId = conn.investorId;

        // Skip already introduced
        if (alreadyIntrodInvestorIds.has(investorId)) continue;

        // Skip inactive investors
        if (!investorScores.has(investorId)) continue;

        // Skip investors on cooldown
        const cooldown = investorCooldowns.get(investorId);
        if (cooldown?.onCooldown) continue;

        // Skip existing pending suggestions for same triple
        const tripleKey = `${founder.id}-${fnRel.nodeId}-${investorId}`;
        if (existingTriples.has(tripleKey)) continue;

        // VIP gate: only match VIP investors with founders who have strong acceptance rates
        if (investorVip.has(investorId) && !qualifiesForVip) continue;

        // Category filter (hard gate)
        const investorCats = data.investorCatMap.get(investorId);
        const investorExclusions = data.investorExclusionMap.get(investorId);
        if (!passesCategoryFilter(founderCats, investorCats, investorExclusions)) continue;

        const investorReliability = investorScores.get(investorId)!;
        const matchScore = computeInverseMatchScore(founderHeat, investorReliability, conn.connectionStrength);

        suggestions.push({
          founderId: founder.id,
          nodeId: fnRel.nodeId,
          investorId,
          founderHeatScore: founderHeat,
          investorReliabilityScore: investorReliability,
          matchScore,
          matchReasoning: JSON.stringify({
            founderStaticHeat: staticHeat,
            founderDynamicHeat: dynamicHeat,
            connectionStrength: conn.connectionStrength,
            logic: describeMatchLogic(founderHeat, investorReliability),
          }),
          batchId,
        });
      }
    }
  }

  // Sort by match score descending
  suggestions.sort((a, b) => b.matchScore - a.matchScore);

  // Limit to remaining weekly quota per founder
  const perFounderCount = new Map<number, number>();
  const filtered = suggestions.filter(s => {
    const count = perFounderCount.get(s.founderId) || 0;
    const target = effectiveTargets.get(s.founderId) || 2;
    const usedThisWeek = weeklyIntroCount.get(s.founderId) || 0;
    const remaining = Math.max(0, target - usedThisWeek);
    if (count >= remaining) return false;
    perFounderCount.set(s.founderId, count + 1);
    return true;
  });

  return { suggestions: filtered, batchId, rampUps };
}

// --- Score Computation (for visibility endpoints) ---

export async function computeAllFounderScores() {
  const data = await loadMatchingData();

  return data.allFounders
    .filter(f => !f.hidden)
    .map(founder => {
      const founderCats = data.founderCatMap.get(founder.id) || [];
      const founderIntros = data.founderIntroMap.get(founder.id) || [];
      const staticHeat = computeFounderStaticHeat(founderCats, data.personaTierMap);
      const dynamicHeat = computeFounderDynamicHeat(founderIntros);
      const heatScore = computeFounderHeatScore(staticHeat, dynamicHeat);

      return {
        id: founder.id,
        name: founder.name,
        companyName: founder.companyName,
        staticHeat,
        dynamicHeat,
        heatScore,
        totalIntros: founderIntros.length,
        persona: founderCats.filter(c => c.type === 'persona').map(c => c.name),
      };
    })
    .sort((a, b) => b.heatScore - a.heatScore);
}

export async function computeAllInvestorScores() {
  const data = await loadMatchingData();

  return data.allInvestors
    .filter(inv => inv.active)
    .map(inv => {
      const intros = data.investorIntroMap.get(inv.id) || [];
      const reliabilityScore = computeInvestorReliabilityScore(intros);
      const cooldown = isInvestorOnCooldown(intros);

      return {
        id: inv.id,
        name: inv.name,
        firm: inv.firm,
        reliabilityScore,
        totalIntros: intros.length,
        onCooldown: cooldown.onCooldown,
        cooldownReason: cooldown.reason,
      };
    })
    .sort((a, b) => b.reliabilityScore - a.reliabilityScore);
}
