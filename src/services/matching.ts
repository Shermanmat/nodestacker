import { eq, and, inArray, lt, sql } from 'drizzle-orm';
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
  // Unresolved = intro_request_sent (waiting for investor response), only if < 2 weeks old
  const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
  const unresolved = investorIntros.filter(ir => {
    if (ir.status !== 'intro_request_sent') return false;
    const d = ir.createdAt ? new Date(ir.createdAt).getTime()
      : ir.dateRequested ? new Date(ir.dateRequested).getTime() : 0;
    return d > twoWeeksAgo;
  });
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
    // Use dateIntroduced, fall back to updatedAt for older records missing the date
    const d = ir.dateIntroduced ? new Date(ir.dateIntroduced).getTime()
      : ir.updatedAt ? new Date(ir.updatedAt).getTime() : 0;
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

// Firm names that represent individual investors, not actual firms.
// These should never trigger firm-level dedup.
const NON_FIRM_NAMES = new Set(['angel', 'angel investor', 'independent', 'individual']);

/**
 * Get the set of firm names (normalized) that are blocked for a given founder.
 * A firm is blocked if any investor at that firm already has an intro request
 * for this founder (any status).
 */
export async function getFounderBlockedFirms(founderId: number): Promise<Set<string>> {
  const founderIntros = await db.select({ investorId: introRequests.investorId })
    .from(introRequests)
    .where(eq(introRequests.founderId, founderId));

  const investorIds = founderIntros.map(ir => ir.investorId);
  if (investorIds.length === 0) return new Set();

  const relevantInvestors = await db.select({ id: investors.id, firm: investors.firm })
    .from(investors)
    .where(inArray(investors.id, investorIds));

  const firms = new Set<string>();
  for (const inv of relevantInvestors) {
    if (inv.firm) {
      const normalized = inv.firm.trim().toLowerCase();
      if (!NON_FIRM_NAMES.has(normalized)) firms.add(normalized);
    }
  }
  return firms;
}

/**
 * Check if an investor's firm is blocked for a given founder.
 * Returns the firm name if blocked, null if OK.
 */
export async function checkFirmBlocked(founderId: number, investorId: number): Promise<string | null> {
  const investor = await db.select({ firm: investors.firm })
    .from(investors)
    .where(eq(investors.id, investorId))
    .get();

  if (!investor?.firm) return null;

  const normalizedFirm = investor.firm.trim().toLowerCase();
  if (NON_FIRM_NAMES.has(normalizedFirm)) return null;

  const blockedFirms = await getFounderBlockedFirms(founderId);
  return blockedFirms.has(normalizedFirm) ? investor.firm : null;
}

// --- Inverse Match Scoring ---

/**
 * Core inverse matching logic. Returns 0-130 (with optional recency bonus).
 *
 * `recencyBonus` adds 0–30 points based on how many weeks since this investor
 * was last contacted (mirrors the client-side bonus in admin.html). The cap is
 * raised from 100 to 130 to preserve ordering among stale investors — without
 * it, every fresh investor with strong fit would tie at 100 and the recency
 * signal would be lost. Display surfaces should treat anything ≥ 100 as a
 * "strong fit + needs attention" rank.
 */
export function computeInverseMatchScore(
  founderHeat: number,
  investorReliability: number,
  connectionStrength: string,
  recencyBonus: number = 0,
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
    strengthBonus +
    Math.max(0, Math.min(30, recencyBonus))
  );

  return Math.max(0, Math.min(130, baseScore));
}

/**
 * Classify the quality of a founder↔investor match across the three category
 * axes. The hard category filter (passesCategoryFilter) has already screened
 * for compatibility — this just rates HOW well they fit, so scoring can reward
 * tight fits over generalist coverage.
 */
export function classifyMatchFit(
  founderCategories: { id: number; name: string; type: string }[],
  investorCategories: { id: number; name: string; type: string }[] | undefined,
): {
  sector: 'exact' | 'generalist' | 'untagged';
  stage: 'exact' | 'untagged';
  persona: 'exact' | 'untagged';
} {
  const invCats = investorCategories || [];
  const founderSectors = new Set(founderCategories.filter(c => c.type === 'sector').map(c => c.id));
  const investorSectors = invCats.filter(c => c.type === 'sector');
  const investorSectorIds = new Set(investorSectors.map(c => c.id));
  const isGeneralist = investorSectors.some(c => c.name.toLowerCase() === 'generalist');

  let sector: 'exact' | 'generalist' | 'untagged' = 'untagged';
  if (founderSectors.size > 0 && investorSectors.length > 0) {
    let exactOverlap = false;
    for (const id of founderSectors) {
      if (investorSectorIds.has(id)) { exactOverlap = true; break; }
    }
    sector = exactOverlap ? 'exact' : (isGeneralist ? 'generalist' : 'untagged');
  } else if (isGeneralist) {
    sector = 'generalist';
  }

  const founderStages = new Set(founderCategories.filter(c => c.type === 'stage').map(c => c.id));
  const investorStages = new Set(invCats.filter(c => c.type === 'stage').map(c => c.id));
  let stage: 'exact' | 'untagged' = 'untagged';
  if (founderStages.size > 0 && investorStages.size > 0) {
    for (const id of founderStages) {
      if (investorStages.has(id)) { stage = 'exact'; break; }
    }
  }

  const founderPersonas = new Set(founderCategories.filter(c => c.type === 'persona').map(c => c.id));
  const investorPersonas = new Set(invCats.filter(c => c.type === 'persona').map(c => c.id));
  let persona: 'exact' | 'untagged' = 'untagged';
  if (founderPersonas.size > 0 && investorPersonas.size > 0) {
    for (const id of founderPersonas) {
      if (investorPersonas.has(id)) { persona = 'exact'; break; }
    }
  }

  return { sector, stage, persona };
}

/**
 * Fit-based match score, 0–100. Optimizes for "will the node forward this?"
 * given that the only outcome tracked is whether the intro happens.
 *
 *  - Connection strength (your relationship): up to 30
 *  - Sector fit (exact > generalist): up to 25
 *  - Stage fit: up to 10
 *  - Persona fit: up to 5
 *  - Recency / staleness pressure: up to 30
 *
 * Founder heat + investor reliability are intentionally NOT factored in —
 * the former is behavior, not quality, and the latter measures downstream
 * conversion which isn't tracked. Both still exist as standalone metrics for
 * dashboards; they just don't drive ranking anymore.
 */
export function computeFitScore(
  connectionStrength: string,
  fit: { sector: 'exact' | 'generalist' | 'untagged'; stage: 'exact' | 'untagged'; persona: 'exact' | 'untagged' },
  recencyBonus: number,
): number {
  const strengthPoints = connectionStrength === 'strong' ? 30
    : connectionStrength === 'medium' ? 15
    : 5;
  const sectorPoints = fit.sector === 'exact' ? 25 : fit.sector === 'generalist' ? 10 : 0;
  const stagePoints = fit.stage === 'exact' ? 10 : 0;
  const personaPoints = fit.persona === 'exact' ? 5 : 0;
  const recency = Math.max(0, Math.min(30, recencyBonus));
  return Math.max(0, Math.min(100, strengthPoints + sectorPoints + stagePoints + personaPoints + recency));
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
    allNodes,
  ] = await Promise.all([
    db.select().from(founders),
    db.select().from(investors),
    db.select().from(introRequests),
    db.select().from(founderNodeRelationships),
    db.select().from(nodeInvestorConnections),
    db.select().from(personaHotnessTiers),
    db.select().from(nodes),
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
    allNodes,
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
export function passesCategoryFilter(
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

  // --- Persona filter (hard gate) ---
  // Persona is a strict preference — if an investor specifies a persona
  // (e.g. "College / Recent Grad Hustler"), the founder MUST match it.
  // Unlike stage, an untagged founder is rejected here: we don't know if
  // they fit, and the investor was explicit about who they want.
  const investorPersonas = investorCategories
    ? investorCategories.filter(c => c.type === 'persona')
    : [];
  if (investorPersonas.length > 0) {
    const founderPersonas = founderCategories.filter(c => c.type === 'persona');
    if (founderPersonas.length === 0) return false;
    const investorPersonaIds = new Set(investorPersonas.map(c => c.id));
    const hasPersonaOverlap = founderPersonas.some(c => investorPersonaIds.has(c.id));
    if (!hasPersonaOverlap) return false;
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
  return Math.max(recommended, currentTarget);
}

// Runway-based target: spread the available-investor pool across ~8 weeks.
// Combines with heat (faster cadence for hot founders) and respects an
// explicit manual baseline from founder.introTargetPerWeek when set > 0.
// Clamped to [1, 5] so we always offer at least 1/week and never blow out
// momentum with more than 5 fresh intros in a week.
export const DYNAMIC_RUNWAY_WEEKS = 8;
export const DYNAMIC_MIN = 1;
export const DYNAMIC_MAX = 5;

export function computeDynamicIntroTarget(opts: {
  availableInvestors: number;
  heatScore: number;
  manualBaseline?: number | null;
}): { target: number; supplyBased: number; heatBased: number; manualBaseline: number } {
  const supplyBased = opts.availableInvestors > 0
    ? Math.ceil(opts.availableInvestors / DYNAMIC_RUNWAY_WEEKS)
    : DYNAMIC_MIN;
  let heatBased: number;
  if (opts.heatScore >= 80) heatBased = 4;
  else if (opts.heatScore >= 60) heatBased = 3;
  else if (opts.heatScore >= 40) heatBased = 2;
  else heatBased = 1;
  const manualBaseline = opts.manualBaseline ?? 0;
  const combined = Math.max(supplyBased, heatBased, manualBaseline);
  const target = Math.max(DYNAMIC_MIN, Math.min(DYNAMIC_MAX, combined));
  return { target, supplyBased, heatBased, manualBaseline };
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

interface FounderLiquidity {
  founderId: number;
  founderName: string;
  weeklyTarget: number;
  usedThisWeek: number;
  remaining: number;
  totalReachableInvestors: number;
  availableInvestors: number;
  blockedByCooldown: number;
  blockedByFirm: number;
  blockedByExisting: number;
  blockedByClaimed: number;
  blockedByTripleDup: number;
  blockedByVipGate: number;
  blockedByVipNode: number;
  blockedByGeo: number;
  blockedByCategory: number;
  generated: number;
  status: 'healthy' | 'tight' | 'dry';
  targetSource: 'dynamic' | 'manual';
  targetSupplyBased: number;
  targetHeatBased: number;
  targetManualBaseline: number;
}

/**
 * Generate match suggestions for eligible founders.
 */
export async function generateMatchSuggestions(
  targetFounderId?: number,
): Promise<{ suggestions: GeneratedSuggestion[]; batchId: string; rampUps: RampUp[]; liquidity: FounderLiquidity[] }> {
  const data = await loadMatchingData();
  const batchId = crypto.randomUUID();

  // Auto-expire pending suggestions older than 14 days. They were generated but
  // never reviewed by the admin — leaving them pending claims investors forever
  // (claimedInvestorIds), starving other founders. We flip them to 'rejected'
  // so they release the investor lock; the triple stays blocked for 90 days
  // via the existingTriples window below, then re-opens for new suggestions.
  const STALE_PENDING_DAYS = 14;
  const fourteenDaysAgo = new Date(Date.now() - STALE_PENDING_DAYS * 86400 * 1000).toISOString();
  await db.update(matchSuggestions)
    .set({ status: 'rejected' })
    .where(and(
      eq(matchSuggestions.status, 'pending'),
      lt(matchSuggestions.createdAt, fourteenDaysAgo),
    ));

  // existingTriples blocks re-suggesting the same (founder, node, investor):
  //   - pending: actively in queue
  //   - rejected within last 90 days: admin (or auto-expiry) rejected recently
  // Older rejections age out so circumstances can change (founder pivots,
  // investor pivots) without permanently blocking the triple.
  const REJECTED_LOOKBACK_DAYS = 90;
  const rejectedCutoff = new Date(Date.now() - REJECTED_LOOKBACK_DAYS * 86400 * 1000).toISOString();
  const existingSuggestions = await db.select().from(matchSuggestions)
    .where(and(
      inArray(matchSuggestions.status, ['pending', 'rejected']),
      sql`(${matchSuggestions.status} = 'pending' OR ${matchSuggestions.createdAt} >= ${rejectedCutoff})`,
    ));
  const existingTriples = new Set(
    existingSuggestions.map(s => `${s.founderId}-${s.nodeId}-${s.investorId}`)
  );

  // Track investors already claimed by a pending suggestion (1 suggestion at a time per investor)
  const claimedInvestorIds = new Set(
    existingSuggestions.filter(s => s.status === 'pending').map(s => s.investorId)
  );

  // Count intros in last 7 days per founder — only those actually sent (or
  // beyond). Pending_suggestion rows are agent-generated proposals that
  // haven't been approved/sent yet; counting them against the weekly quota
  // would let unreviewed drafts block new generation. Drafts age out via
  // discard/reject/mark-sent, not via "quota use."
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const SENT_OR_PROGRESSED_STATUSES = new Set([
    'intro_request_sent', 'introduced', 'first_meeting_complete',
    'second_meeting_complete', 'invested', 'follow_up_questions',
    'circle_back_round_opens', 'passed',
  ]);
  const weeklyIntroCount = new Map<number, number>();
  for (const ir of data.allIntroRequests) {
    if (!ir.createdAt) continue;
    if (new Date(ir.createdAt).getTime() <= sevenDaysAgo) continue;
    if (!SENT_OR_PROGRESSED_STATUSES.has(ir.status)) continue;
    weeklyIntroCount.set(ir.founderId, (weeklyIntroCount.get(ir.founderId) || 0) + 1);
  }

  // Track ramp-ups and effective targets
  const rampUps: RampUp[] = [];
  const effectiveTargets = new Map<number, number>();

  // Filter to eligible founders
  const eligibleFoundersUnsorted = data.allFounders.filter(f => {
    if (targetFounderId && f.id !== targetFounderId) return false;
    if (f.hidden) return false;
    if (!f.introCadenceActive) return false;
    if (f.roundStatus === 'round_closed') return false;
    return true;
  });

  // Round-robin ordering: founders with fewer recent intros get priority
  // so the "first pick" advantage rotates fairly across batches
  const eligibleFounders = [...eligibleFoundersUnsorted].sort((a, b) => {
    const aCount = weeklyIntroCount.get(a.id) || 0;
    const bCount = weeklyIntroCount.get(b.id) || 0;
    const aTarget = a.introTargetPerWeek || 2;
    const bTarget = b.introTargetPerWeek || 2;
    // Sort by fill rate ascending (least filled founders go first)
    const aFillRate = aCount / aTarget;
    const bFillRate = bCount / bTarget;
    return aFillRate - bFillRate;
  });

  // Build VIP node set — VIP nodes only get suggested if founder is doing well with non-VIP networks
  const vipNodeIds = new Set<number>();
  for (const node of data.allNodes) {
    if (node.vip) vipNodeIds.add(node.id);
  }

  // Pre-compute investor scores, cooldowns, VIP status, and geo restrictions
  const investorScores = new Map<number, number>();
  const investorCooldowns = new Map<number, CooldownResult>();
  const investorVip = new Set<number>();
  const investorGeoMap = new Map<number, string>();
  const investorFirmMap = new Map<number, string>(); // investorId → normalized firm name
  // weeksSinceContact per investor — used as a recency bonus in scoring so the
  // matching algorithm naturally biases toward investors we haven't pinged in a
  // while. Mirrors the client-side `weeksSinceContact * 5, cap 30` from
  // admin.html so manual planning + auto-generation rank investors consistently.
  // Never-contacted investors default to 52 weeks (1 year stale) → max bonus.
  const nowMs = Date.now();
  const investorWeeksSinceContact = new Map<number, number>();
  for (const inv of data.allInvestors) {
    if (inv.firm) {
      const normalized = inv.firm.trim().toLowerCase();
      if (!NON_FIRM_NAMES.has(normalized)) investorFirmMap.set(inv.id, normalized);
    }
    if (!inv.active) continue;
    // Skip paused investors (e.g. raising their fund)
    if (inv.pausedUntil && new Date(inv.pausedUntil) > new Date()) continue;
    const intros = data.investorIntroMap.get(inv.id) || [];
    investorScores.set(inv.id, computeInvestorReliabilityScore(intros));
    if (inv.geography) investorGeoMap.set(inv.id, inv.geography.toLowerCase().trim());
    investorCooldowns.set(inv.id, isInvestorOnCooldown(intros));
    if (inv.vip) investorVip.add(inv.id);

    // Find most recent contact date across all intros for this investor
    let mostRecentMs = 0;
    for (const ir of intros) {
      const dateStr = ir.dateRequested || ir.createdAt;
      if (!dateStr) continue;
      const t = new Date(dateStr).getTime();
      if (!isNaN(t) && t > mostRecentMs) mostRecentMs = t;
    }
    const weeks = mostRecentMs === 0
      ? 52
      : Math.floor((nowMs - mostRecentMs) / (1000 * 60 * 60 * 24 * 7));
    investorWeeksSinceContact.set(inv.id, Math.max(0, weeks));
  }

  const suggestions: GeneratedSuggestion[] = [];
  const liquidityStats: FounderLiquidity[] = [];

  for (const founder of eligibleFounders) {
    const founderCats = data.founderCatMap.get(founder.id) || [];
    const founderIntros = data.founderIntroMap.get(founder.id) || [];
    const alreadyIntrodInvestorIds = new Set(founderIntros.map(ir => ir.investorId));

    // Firm-level dedup: if any investor at a firm has been intro'd for this founder, block the whole firm
    const blockedFirms = new Set<string>();
    for (const ir of founderIntros) {
      const firm = investorFirmMap.get(ir.investorId);
      if (firm) blockedFirms.add(firm);
    }

    // VIP gating: gate on intro volume only, not acceptance rate. We don't
    // track meeting/decline outcomes reliably — we assume every sent intro
    // means a meeting happened. So "earning VIP access" = "has put 3 intros
    // through the network" (proves the founder is real + the system is
    // working for them). Drop the 50%-acceptance filter that previously
    // gated on follow_up_questions / first_meeting_complete progression.
    const VIP_INTROS_REQUIRED = 3;
    const SENT_OR_PROGRESSED = new Set([
      'intro_request_sent', 'introduced', 'first_meeting_complete',
      'second_meeting_complete', 'invested', 'follow_up_questions',
      'circle_back_round_opens', 'passed',
    ]);
    const introsSent = founderIntros.filter(ir => SENT_OR_PROGRESSED.has(ir.status));
    const qualifiesForVip = introsSent.length >= VIP_INTROS_REQUIRED;

    // VIP node gate: same threshold, but counted across non-VIP node intros
    // only — founder must have proven they can absorb intros through the
    // primary network before VIP nodes open up.
    const nonVipIntrosSent = introsSent.filter(ir => !vipNodeIds.has(ir.nodeId));
    const qualifiesForVipNode = nonVipIntrosSent.length >= VIP_INTROS_REQUIRED;

    // Compute founder heat
    const staticHeat = computeFounderStaticHeat(founderCats, data.personaTierMap);
    const dynamicHeat = computeFounderDynamicHeat(founderIntros);
    const founderHeat = computeFounderHeatScore(staticHeat, dynamicHeat);

    // Manual baseline: an admin-set introTargetPerWeek > 0 acts as a floor.
    // We default to 0 if unset so the dynamic calc (supply + heat) drives.
    const manualBaseline = founder.introTargetPerWeek || 0;

    // Get founder's nodes and track liquidity
    const founderNodes = data.allFnRels.filter(r => r.founderId === founder.id);
    let totalReachable = 0;
    let blockedByExisting = 0;
    let blockedByFirm = 0;
    let blockedByCooldown = 0;
    let blockedByClaimed = 0;
    let blockedByTripleDup = 0;
    let blockedByVipGate = 0;
    let blockedByVipNode = 0;
    let blockedByGeo = 0;
    let blockedByCategory = 0;
    let availableCount = 0;

    for (const fnRel of founderNodes) {
      const nodeConnections = data.allNiConns.filter(c => c.nodeId === fnRel.nodeId);

      for (const conn of nodeConnections) {
        const investorId = conn.investorId;

        // Skip inactive investors (not in investorScores means inactive/paused)
        if (!investorScores.has(investorId)) continue;

        totalReachable++;

        // Skip already introduced
        if (alreadyIntrodInvestorIds.has(investorId)) { blockedByExisting++; continue; }

        // Skip investors at a firm that already has an intro for this founder
        const investorFirm = investorFirmMap.get(investorId);
        if (investorFirm && blockedFirms.has(investorFirm)) { blockedByFirm++; continue; }

        // Skip investors on cooldown
        const cooldown = investorCooldowns.get(investorId);
        if (cooldown?.onCooldown) { blockedByCooldown++; continue; }

        // Skip investors already claimed by another pending suggestion
        if (claimedInvestorIds.has(investorId)) { blockedByClaimed++; continue; }

        // Skip existing pending suggestions for same triple
        const tripleKey = `${founder.id}-${fnRel.nodeId}-${investorId}`;
        if (existingTriples.has(tripleKey)) { blockedByTripleDup++; continue; }

        // VIP gate: only match VIP investors with founders who have strong acceptance rates
        if (investorVip.has(investorId) && !qualifiesForVip) { blockedByVipGate++; continue; }

        // VIP node gate: only match investors from VIP nodes with founders doing well in non-VIP networks
        if (vipNodeIds.has(fnRel.nodeId) && !qualifiesForVipNode) { blockedByVipNode++; continue; }

        // Geography gate: if investor has a specific geography, founder must be located there
        const invGeo = investorGeoMap.get(investorId);
        if (invGeo) {
          const founderCity = (founder.city || '').toLowerCase();
          const founderCountry = (founder.country || '').toLowerCase();
          if (!founderCity && !founderCountry) { blockedByGeo++; continue; }
          const geoMatch = founderCity.includes(invGeo) || invGeo.includes(founderCity) ||
                           founderCountry.includes(invGeo) || invGeo.includes(founderCountry);
          if (!geoMatch) { blockedByGeo++; continue; }
        }

        // Category filter (hard gate)
        const investorCats = data.investorCatMap.get(investorId);
        const investorExclusions = data.investorExclusionMap.get(investorId);
        if (!passesCategoryFilter(founderCats, investorCats, investorExclusions)) { blockedByCategory++; continue; }

        availableCount++;

        const investorReliability = investorScores.get(investorId)!;
        const weeksSinceContact = investorWeeksSinceContact.get(investorId) ?? 52;
        const recencyBonus = Math.min(30, weeksSinceContact * 5);
        const fit = classifyMatchFit(founderCats, data.investorCatMap.get(investorId));
        const matchScore = computeFitScore(conn.connectionStrength, fit, recencyBonus);

        suggestions.push({
          founderId: founder.id,
          nodeId: fnRel.nodeId,
          investorId,
          founderHeatScore: founderHeat,
          investorReliabilityScore: investorReliability,
          matchScore,
          matchReasoning: JSON.stringify({
            connectionStrength: conn.connectionStrength,
            sectorFit: fit.sector,
            stageFit: fit.stage,
            personaFit: fit.persona,
            weeksSinceContact,
          }),
          batchId,
        });

        // Claim this investor so they aren't suggested for another founder in this batch
        claimedInvestorIds.add(investorId);
      }
    }

    const usedThisWeek = weeklyIntroCount.get(founder.id) || 0;
    const dyn = computeDynamicIntroTarget({
      availableInvestors: availableCount,
      heatScore: founderHeat,
      manualBaseline,
    });
    const target = dyn.target;
    effectiveTargets.set(founder.id, target);
    const targetSource: 'dynamic' | 'manual' = manualBaseline > 0 && manualBaseline >= dyn.supplyBased && manualBaseline >= dyn.heatBased ? 'manual' : 'dynamic';
    if (manualBaseline > 0 && target > manualBaseline) {
      rampUps.push({
        founderId: founder.id,
        previousTarget: manualBaseline,
        newTarget: target,
        heatScore: founderHeat,
      });
    }
    const weeksOfRunway = target > 0 ? Math.floor(availableCount / target) : 999;
    liquidityStats.push({
      founderId: founder.id,
      founderName: founder.name,
      weeklyTarget: target,
      usedThisWeek,
      remaining: Math.max(0, target - usedThisWeek),
      totalReachableInvestors: totalReachable,
      availableInvestors: availableCount,
      blockedByCooldown,
      blockedByFirm,
      blockedByExisting,
      blockedByClaimed,
      blockedByTripleDup,
      blockedByVipGate,
      blockedByVipNode,
      blockedByGeo,
      blockedByCategory,
      generated: 0, // filled after filtering
      status: weeksOfRunway >= 4 ? 'healthy' : weeksOfRunway >= 2 ? 'tight' : 'dry',
      targetSource,
      targetSupplyBased: dyn.supplyBased,
      targetHeatBased: dyn.heatBased,
      targetManualBaseline: dyn.manualBaseline,
    });
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

  // Fill in generated counts
  for (const s of filtered) {
    const ls = liquidityStats.find(l => l.founderId === s.founderId);
    if (ls) ls.generated++;
  }

  return { suggestions: filtered, batchId, rampUps, liquidity: liquidityStats };
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

/**
 * One-shot rescore: walks every pending match_suggestion and recomputes
 * matchScore + matchReasoning using the current scoring formula. Useful
 * after we change the algorithm (or hard-tweak weights) so the existing
 * queue doesn't show stale scores from the old formula. Untouched: the
 * status itself — pending suggestions stay pending.
 */
export async function rescorePendingSuggestions(): Promise<{
  total: number;
  updated: number;
  skipped: number;
}> {
  const data = await loadMatchingData();

  const pending = await db.select().from(matchSuggestions)
    .where(eq(matchSuggestions.status, 'pending'));

  const connByPair = new Map<string, string>(); // `${nodeId}-${investorId}` -> strength
  for (const conn of data.allNiConns) {
    connByPair.set(`${conn.nodeId}-${conn.investorId}`, conn.connectionStrength);
  }

  const nowMs = Date.now();
  const investorWeeksSinceContact = new Map<number, number>();
  for (const inv of data.allInvestors) {
    const intros = data.investorIntroMap.get(inv.id) || [];
    let mostRecentMs = 0;
    for (const ir of intros) {
      const dateStr = ir.dateRequested || ir.createdAt;
      if (!dateStr) continue;
      const t = new Date(dateStr).getTime();
      if (!isNaN(t) && t > mostRecentMs) mostRecentMs = t;
    }
    const weeks = mostRecentMs === 0
      ? 52
      : Math.floor((nowMs - mostRecentMs) / (1000 * 60 * 60 * 24 * 7));
    investorWeeksSinceContact.set(inv.id, Math.max(0, weeks));
  }

  let updated = 0;
  let skipped = 0;
  for (const s of pending) {
    const strength = connByPair.get(`${s.nodeId}-${s.investorId}`);
    if (!strength) { skipped++; continue; }
    const founderCats = data.founderCatMap.get(s.founderId) || [];
    const investorCats = data.investorCatMap.get(s.investorId);
    const weeksSinceContact = investorWeeksSinceContact.get(s.investorId) ?? 52;
    const recencyBonus = Math.min(30, weeksSinceContact * 5);
    const fit = classifyMatchFit(founderCats, investorCats);
    const matchScore = computeFitScore(strength, fit, recencyBonus);
    const matchReasoning = JSON.stringify({
      connectionStrength: strength,
      sectorFit: fit.sector,
      stageFit: fit.stage,
      personaFit: fit.persona,
      weeksSinceContact,
    });
    await db.update(matchSuggestions)
      .set({ matchScore, matchReasoning })
      .where(eq(matchSuggestions.id, s.id));
    updated++;
  }

  return { total: pending.length, updated, skipped };
}
