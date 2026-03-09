import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, founders, founderNodeRelationships, nodes, founderCategoryAssignments, investorCategories, investorCategoryAssignments, introRequests, investors, nodeInvestorConnections } from '../db/index.js';
import { z } from 'zod';

const app = new Hono();

const createFounderSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  companyName: z.string().min(1),
  companyStage: z.enum(['idea', 'pre_seed', 'seed', 'series_a']),
  roundStatus: z.enum(['pre_round', 'round_open', 'round_closed']).optional(),
  hidden: z.boolean().optional(),
});

const updateFounderSchema = createFounderSchema.partial().extend({
  introTargetPerWeek: z.number().int().min(0).optional(),
  introCadenceActive: z.boolean().optional(),
  cadenceStartDate: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
});

// List all founders (with categories)
app.get('/', async (c) => {
  const allFounders = await db.select().from(founders);

  // Get all founder category assignments
  const allCategoryAssignments = await db.select({
    founderId: founderCategoryAssignments.founderId,
    categoryId: founderCategoryAssignments.categoryId,
    categoryName: investorCategories.name,
    categoryType: investorCategories.type,
    categoryColor: investorCategories.color,
  }).from(founderCategoryAssignments)
    .innerJoin(investorCategories, eq(founderCategoryAssignments.categoryId, investorCategories.id));

  const categoryMap = new Map<number, { id: number; name: string; type: string; color: string | null }[]>();
  for (const a of allCategoryAssignments) {
    if (!categoryMap.has(a.founderId)) categoryMap.set(a.founderId, []);
    categoryMap.get(a.founderId)!.push({ id: a.categoryId, name: a.categoryName, type: a.categoryType, color: a.categoryColor });
  }

  const result = allFounders.map(f => ({
    ...f,
    categories: categoryMap.get(f.id) || [],
  }));

  return c.json(result);
});

// Pipeline Health endpoint
app.get('/pipeline-health', async (c) => {
  const allFounders = await db.select().from(founders);
  const activeFounders = allFounders.filter(f => f.introCadenceActive);

  // Load all data we need
  const allIntroRequests = await db.select().from(introRequests);
  const allInvestors = await db.select().from(investors);
  const allFnRels = await db.select().from(founderNodeRelationships);
  const allNiConns = await db.select().from(nodeInvestorConnections);

  // Load all category assignments
  const founderCatAssignments = await db.select({
    founderId: founderCategoryAssignments.founderId,
    categoryId: founderCategoryAssignments.categoryId,
    categoryName: investorCategories.name,
    categoryType: investorCategories.type,
    categoryColor: investorCategories.color,
  }).from(founderCategoryAssignments)
    .innerJoin(investorCategories, eq(founderCategoryAssignments.categoryId, investorCategories.id));

  const investorCatAssignments = await db.select({
    investorId: investorCategoryAssignments.investorId,
    categoryId: investorCategoryAssignments.categoryId,
  }).from(investorCategoryAssignments);

  // Build maps
  const founderCatMap = new Map<number, { id: number; name: string; type: string; color: string | null }[]>();
  for (const a of founderCatAssignments) {
    if (!founderCatMap.has(a.founderId)) founderCatMap.set(a.founderId, []);
    founderCatMap.get(a.founderId)!.push({ id: a.categoryId, name: a.categoryName, type: a.categoryType, color: a.categoryColor });
  }

  const investorCatMap = new Map<number, Set<number>>();
  for (const a of investorCatAssignments) {
    if (!investorCatMap.has(a.investorId)) investorCatMap.set(a.investorId, new Set());
    investorCatMap.get(a.investorId)!.add(a.categoryId);
  }

  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - now.getDay()); // Sunday
  weekStart.setHours(0, 0, 0, 0);

  const lastWeekStart = new Date(weekStart);
  lastWeekStart.setDate(lastWeekStart.getDate() - 7);

  const founderResults = activeFounders.map(founder => {
    const founderCategories = founderCatMap.get(founder.id) || [];
    const founderCategoryIds = new Set(founderCategories.map(c => c.id));

    // Get founder's nodes
    const founderNodes = allFnRels.filter(r => r.founderId === founder.id);
    const nodeIds = new Set(founderNodes.map(r => r.nodeId));

    // Get all investors reachable through those nodes (active only)
    const reachableInvestorIds = new Set<number>();
    for (const conn of allNiConns) {
      if (nodeIds.has(conn.nodeId)) {
        const inv = allInvestors.find(i => i.id === conn.investorId);
        if (inv && inv.active !== false) {
          reachableInvestorIds.add(conn.investorId);
        }
      }
    }

    // Fit filter
    let fitInvestorIds: Set<number>;
    if (founderCategoryIds.size === 0) {
      // No categories on founder = all reachable investors count
      fitInvestorIds = reachableInvestorIds;
    } else {
      fitInvestorIds = new Set<number>();
      for (const investorId of reachableInvestorIds) {
        const investorCats = investorCatMap.get(investorId);
        if (!investorCats) continue; // Uncategorized = excluded
        // Check overlap
        for (const catId of investorCats) {
          if (founderCategoryIds.has(catId)) {
            fitInvestorIds.add(investorId);
            break;
          }
        }
      }
    }

    // Get intro'd investors for this founder
    const founderIntros = allIntroRequests.filter(ir => ir.founderId === founder.id);
    const alreadyIntrodSet = new Set(founderIntros.map(ir => ir.investorId));

    const fitInvestors = fitInvestorIds.size;
    const alreadyIntrod = [...alreadyIntrodSet].filter(id => fitInvestorIds.has(id)).length;
    const remaining = fitInvestors - alreadyIntrod;
    const exhaustionPercent = fitInvestors > 0 ? Math.round((alreadyIntrod / fitInvestors) * 100) : 0;

    // Weekly stats
    const introsThisWeek = founderIntros.filter(ir => {
      const d = ir.dateRequested || ir.createdAt;
      return d && new Date(d) >= weekStart;
    }).length;

    const introsLastWeek = founderIntros.filter(ir => {
      const d = ir.dateRequested || ir.createdAt;
      return d && new Date(d) >= lastWeekStart && new Date(d) < weekStart;
    }).length;

    // Weekly rate (over actual history, not cadence start)
    const firstIntroDate = founderIntros.reduce((earliest: Date | null, ir) => {
      const d = ir.dateRequested || ir.createdAt;
      if (!d) return earliest;
      const date = new Date(d);
      return !earliest || date < earliest ? date : earliest;
    }, null as Date | null);
    const rateStart = firstIntroDate || new Date(founder.createdAt);
    const weeksActive = Math.max(1, Math.ceil((now.getTime() - rateStart.getTime()) / (7 * 24 * 60 * 60 * 1000)));
    const weeklyRate = Math.round((founderIntros.length / weeksActive) * 10) / 10;

    // Active intros (not passed/ignored/invested)
    const activeIntros = founderIntros.filter(ir =>
      !['passed', 'ignored', 'invested'].includes(ir.status)
    ).length;

    const pendingResponse = founderIntros.filter(ir =>
      ir.status === 'intro_request_sent'
    ).length;

    // Status determination
    const target = founder.introTargetPerWeek || 2;
    let status: string;
    if (!founder.introCadenceActive) {
      status = 'paused';
    } else if (remaining === 0 && fitInvestors > 0) {
      status = 'exhausted';
    } else if (fitInvestors === 0) {
      status = 'starved';
    } else if (introsThisWeek < target && introsLastWeek < target) {
      status = 'behind';
    } else {
      status = 'on_track';
    }

    return {
      founder: {
        id: founder.id,
        name: founder.name,
        companyName: founder.companyName,
        categories: founderCategories,
      },
      cadence: {
        targetPerWeek: target,
        active: founder.introCadenceActive,
        startDate: founder.cadenceStartDate,
      },
      introsThisWeek,
      introsLastWeek,
      weeklyRate,
      status,
      fitInvestors,
      alreadyIntrod,
      remaining,
      exhaustionPercent,
      activeIntros,
      pendingResponse,
    };
  });

  // Summary
  const summary = {
    total: founderResults.length,
    onTrack: founderResults.filter(f => f.status === 'on_track').length,
    behind: founderResults.filter(f => f.status === 'behind').length,
    starved: founderResults.filter(f => f.status === 'starved').length,
    exhausted: founderResults.filter(f => f.status === 'exhausted').length,
  };

  // Sort by urgency: exhausted > starved > behind > on_track > paused
  const statusOrder: Record<string, number> = { exhausted: 0, starved: 1, behind: 2, on_track: 3, paused: 4 };
  founderResults.sort((a, b) => (statusOrder[a.status] ?? 5) - (statusOrder[b.status] ?? 5));

  return c.json({ founders: founderResults, summary });
});

// Network availability drill-down
app.get('/:id/network-availability', async (c) => {
  const founderId = parseInt(c.req.param('id'));

  const founder = await db.query.founders.findFirst({
    where: eq(founders.id, founderId),
  });
  if (!founder) return c.json({ error: 'Founder not found' }, 404);

  // Get founder categories
  const founderCats = await db.select({
    categoryId: founderCategoryAssignments.categoryId,
    categoryName: investorCategories.name,
  }).from(founderCategoryAssignments)
    .innerJoin(investorCategories, eq(founderCategoryAssignments.categoryId, investorCategories.id))
    .where(eq(founderCategoryAssignments.founderId, founderId));

  const founderCategoryIds = new Set(founderCats.map(c => c.categoryId));

  // Get founder's nodes with their investor connections
  const founderNodes = await db.query.founderNodeRelationships.findMany({
    where: eq(founderNodeRelationships.founderId, founderId),
    with: {
      node: {
        with: {
          investorConnections: {
            with: {
              investor: true,
            },
          },
        },
      },
    },
  });

  // Get all intro requests for this founder
  const founderIntros = await db.select().from(introRequests).where(eq(introRequests.founderId, founderId));
  const introdInvestorIds = new Set(founderIntros.map(ir => ir.investorId));

  // Get all investor category assignments
  const allInvCats = await db.select().from(investorCategoryAssignments);
  const investorCatMap = new Map<number, Set<number>>();
  for (const a of allInvCats) {
    if (!investorCatMap.has(a.investorId)) investorCatMap.set(a.investorId, new Set());
    investorCatMap.get(a.investorId)!.add(a.categoryId);
  }

  // Get all categories for display
  const allCategories = await db.select().from(investorCategories);
  const catNameMap = new Map(allCategories.map(c => [c.id, c.name]));

  const nodeGroups = founderNodes.map(fnRel => {
    const node = fnRel.node;
    const investorList = node.investorConnections
      .filter(conn => conn.investor.active !== false)
      .map(conn => {
        const inv = conn.investor;
        const invCats = investorCatMap.get(inv.id);
        const categoryNames = invCats ? [...invCats].map(id => catNameMap.get(id)).filter(Boolean) : [];

        let fits = false;
        if (founderCategoryIds.size === 0) {
          fits = true;
        } else if (invCats) {
          for (const catId of invCats) {
            if (founderCategoryIds.has(catId)) { fits = true; break; }
          }
        }

        return {
          id: inv.id,
          name: inv.name,
          firm: inv.firm,
          categories: categoryNames,
          fits,
          introd: introdInvestorIds.has(inv.id),
          status: introdInvestorIds.has(inv.id)
            ? founderIntros.find(ir => ir.investorId === inv.id)?.status || 'unknown'
            : 'available',
        };
      });

    return {
      node: { id: node.id, name: node.name },
      total: investorList.length,
      fit: investorList.filter(i => i.fits).length,
      introd: investorList.filter(i => i.introd).length,
      available: investorList.filter(i => i.fits && !i.introd).length,
      investors: investorList,
    };
  });

  return c.json({
    founder: { id: founder.id, name: founder.name, companyName: founder.companyName },
    founderCategories: founderCats.map(c => c.categoryName),
    nodes: nodeGroups,
  });
});

// Get single founder with relationships
app.get('/:id', async (c) => {
  const id = parseInt(c.req.param('id'));
  const founder = await db.query.founders.findFirst({
    where: eq(founders.id, id),
    with: {
      nodeRelationships: {
        with: {
          node: true,
        },
      },
      introRequests: {
        with: {
          node: true,
          investor: true,
        },
      },
    },
  });

  if (!founder) {
    return c.json({ error: 'Founder not found' }, 404);
  }
  return c.json(founder);
});

// Create founder
app.post('/', async (c) => {
  const body = await c.req.json();
  const parsed = createFounderSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: parsed.error.issues }, 400);
  }

  const now = new Date().toISOString();
  const result = await db.insert(founders).values({
    ...parsed.data,
    createdAt: now,
  }).returning();

  return c.json(result[0], 201);
});

// Update founder
app.put('/:id', async (c) => {
  const id = parseInt(c.req.param('id'));
  const body = await c.req.json();
  const parsed = updateFounderSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: parsed.error.issues }, 400);
  }

  const result = await db.update(founders)
    .set(parsed.data)
    .where(eq(founders.id, id))
    .returning();

  if (result.length === 0) {
    return c.json({ error: 'Founder not found' }, 404);
  }
  return c.json(result[0]);
});

// Delete founder
app.delete('/:id', async (c) => {
  const id = parseInt(c.req.param('id'));
  const result = await db.delete(founders).where(eq(founders.id, id)).returning();

  if (result.length === 0) {
    return c.json({ error: 'Founder not found' }, 404);
  }
  return c.json({ success: true });
});

// Assign categories to founder (replaces existing)
app.post('/:id/categories', async (c) => {
  const id = parseInt(c.req.param('id'));
  const body = await c.req.json();
  const parsed = z.object({ categoryIds: z.array(z.number()) }).safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues }, 400);
  }

  // Delete existing assignments
  await db.delete(founderCategoryAssignments).where(eq(founderCategoryAssignments.founderId, id));

  // Insert new assignments
  if (parsed.data.categoryIds.length > 0) {
    await db.insert(founderCategoryAssignments).values(
      parsed.data.categoryIds.map(categoryId => ({ founderId: id, categoryId }))
    );
  }

  // Return updated categories
  const assignments = await db.select({
    id: investorCategories.id,
    name: investorCategories.name,
    type: investorCategories.type,
    color: investorCategories.color,
  }).from(founderCategoryAssignments)
    .innerJoin(investorCategories, eq(founderCategoryAssignments.categoryId, investorCategories.id))
    .where(eq(founderCategoryAssignments.founderId, id));

  return c.json({ categories: assignments });
});

// Get founder's nodes
app.get('/:id/nodes', async (c) => {
  const id = parseInt(c.req.param('id'));
  const relationships = await db.query.founderNodeRelationships.findMany({
    where: eq(founderNodeRelationships.founderId, id),
    with: {
      node: {
        with: {
          investorConnections: {
            with: {
              investor: true,
            },
          },
        },
      },
    },
  });
  return c.json(relationships);
});

// Add node relationship
app.post('/:id/nodes', async (c) => {
  const founderId = parseInt(c.req.param('id'));
  const body = await c.req.json();

  const schema = z.object({
    nodeId: z.number(),
    relationshipStrength: z.enum(['strong', 'medium', 'weak']).optional(),
    howConnected: z.string().optional(),
  });

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues }, 400);
  }

  const now = new Date().toISOString();
  const result = await db.insert(founderNodeRelationships).values({
    founderId,
    nodeId: parsed.data.nodeId,
    relationshipStrength: parsed.data.relationshipStrength || 'medium',
    howConnected: parsed.data.howConnected,
    createdAt: now,
  }).returning();

  return c.json(result[0], 201);
});

export default app;
