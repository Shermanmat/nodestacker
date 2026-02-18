import { Hono } from 'hono';
import { eq, and, inArray, notInArray, desc, sql } from 'drizzle-orm';
import { db, founders, nodes, investors, founderNodeRelationships, nodeInvestorConnections, introRequests, followupLogs, investorResearch } from '../db/index.js';
import { getSessionFounderId } from './auth.js';
import { z } from 'zod';

type Variables = {
  founderId: number;
};

const app = new Hono<{ Variables: Variables }>();

// Auth middleware
app.use('*', async (c, next) => {
  const sessionId = c.req.header('X-Session-Id');
  const founderId = getSessionFounderId(sessionId);

  if (!founderId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  c.set('founderId', founderId);
  await next();
});

// Get founder's dashboard
app.get('/dashboard', async (c) => {
  const founderId = c.get('founderId') as number;

  const founder = await db.query.founders.findFirst({
    where: eq(founders.id, founderId),
  });

  // Get counts
  const allIntros = await db.query.introRequests.findMany({
    where: eq(introRequests.founderId, founderId),
  });

  const today = new Date().toISOString().split('T')[0];

  const stats = {
    totalIntros: allIntros.length,
    activeIntros: allIntros.filter(i =>
      !['passed', 'ignored', 'invested', 'circle_back_round_opens'].includes(i.status)
    ).length,
    invested: allIntros.filter(i => i.status === 'invested').length,
    overdueFollowups: allIntros.filter(i =>
      i.nextFollowupDate && i.nextFollowupDate < today &&
      !['passed', 'ignored', 'invested'].includes(i.status)
    ).length,
  };

  return c.json({ founder, stats });
});

// Get founder's nodes (people they know)
app.get('/my-nodes', async (c) => {
  const founderId = c.get('founderId') as number;

  const relationships = await db.query.founderNodeRelationships.findMany({
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

  // Transform to show useful info
  const myNodes = relationships.map(rel => ({
    relationshipId: rel.id,
    node: {
      id: rel.node.id,
      name: rel.node.name,
      company: rel.node.company,
      role: rel.node.role,
    },
    relationshipStrength: rel.relationshipStrength,
    howConnected: rel.howConnected,
    investorCount: rel.node.investorConnections.length,
    investors: rel.node.investorConnections.map(conn => ({
      id: conn.investor.id,
      name: conn.investor.name,
      firm: conn.investor.firm,
      connectionStrength: conn.connectionStrength,
    })),
  }));

  return c.json(myNodes);
});

// Get available investors (through founder's nodes)
app.get('/available-investors', async (c) => {
  const founderId = c.get('founderId') as number;

  // Get founder's nodes
  const fnRels = await db.query.founderNodeRelationships.findMany({
    where: eq(founderNodeRelationships.founderId, founderId),
  });
  const nodeIds = fnRels.map(r => r.nodeId);

  if (nodeIds.length === 0) {
    return c.json([]);
  }

  // Get all investors reachable through these nodes
  const niConns = await db.query.nodeInvestorConnections.findMany({
    where: inArray(nodeInvestorConnections.nodeId, nodeIds),
    with: {
      node: true,
      investor: true,
    },
  });

  // Get existing intro requests to filter out
  const existingIntros = await db.query.introRequests.findMany({
    where: and(
      eq(introRequests.founderId, founderId),
      inArray(introRequests.status, [
        'intro_request_sent', 'introduced', 'first_meeting_complete',
        'second_meeting_complete', 'follow_up_questions', 'invested',
      ])
    ),
  });
  const activeInvestorIds = new Set(existingIntros.map(i => i.investorId));

  // Get research data for all investors
  const investorIds = [...new Set(niConns.map(c => c.investorId))];
  const researchData = await db.query.investorResearch.findMany({
    where: and(
      inArray(investorResearch.investorId, investorIds),
      eq(investorResearch.status, 'completed')
    ),
    orderBy: desc(investorResearch.researchedAt),
  });

  // Create map of latest research per investor
  const researchMap = new Map<number, {
    investmentThesis: string | null;
    portfolioCompanies: string | null;
    founderPreferences: string | null;
    recentActivity: string | null;
  }>();
  for (const r of researchData) {
    if (!researchMap.has(r.investorId)) {
      researchMap.set(r.investorId, {
        investmentThesis: r.investmentThesis,
        portfolioCompanies: r.portfolioCompanies,
        founderPreferences: r.founderPreferences,
        recentActivity: r.recentActivity,
      });
    }
  }

  // Group by investor, showing which nodes can intro
  const investorMap = new Map<number, {
    investor: any;
    nodes: { nodeId: number; nodeName: string; connectionStrength: string }[];
    hasActiveIntro: boolean;
    research: {
      investmentThesis: string | null;
      portfolioCompanies: string | null;
      founderPreferences: string | null;
      recentActivity: string | null;
    } | null;
  }>();

  for (const conn of niConns) {
    if (!investorMap.has(conn.investorId)) {
      investorMap.set(conn.investorId, {
        investor: conn.investor,
        nodes: [],
        hasActiveIntro: activeInvestorIds.has(conn.investorId),
        research: researchMap.get(conn.investorId) || null,
      });
    }
    investorMap.get(conn.investorId)!.nodes.push({
      nodeId: conn.nodeId,
      nodeName: conn.node.name,
      connectionStrength: conn.connectionStrength,
    });
  }

  return c.json(Array.from(investorMap.values()));
});

// Get founder's active intro requests
app.get('/my-intros', async (c) => {
  const founderId = c.get('founderId') as number;
  const status = c.req.query('status');

  let intros = await db.query.introRequests.findMany({
    where: eq(introRequests.founderId, founderId),
    with: {
      node: true,
      investor: true,
      followupLogs: true,
    },
    orderBy: desc(introRequests.createdAt),
  });

  if (status) {
    intros = intros.filter(i => i.status === status);
  }

  return c.json(intros);
});

// Request an intro
app.post('/request-intro', async (c) => {
  const founderId = c.get('founderId') as number;
  const body = await c.req.json();

  const schema = z.object({
    nodeId: z.number(),
    investorId: z.number(),
    notes: z.string().optional(),
  });

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues }, 400);
  }

  // Verify founder has relationship with node
  const fnRel = await db.query.founderNodeRelationships.findFirst({
    where: and(
      eq(founderNodeRelationships.founderId, founderId),
      eq(founderNodeRelationships.nodeId, parsed.data.nodeId)
    ),
  });

  if (!fnRel) {
    return c.json({ error: 'You don\'t have a relationship with this node' }, 400);
  }

  // Verify node has connection to investor
  const niConn = await db.query.nodeInvestorConnections.findFirst({
    where: and(
      eq(nodeInvestorConnections.nodeId, parsed.data.nodeId),
      eq(nodeInvestorConnections.investorId, parsed.data.investorId)
    ),
  });

  if (!niConn) {
    return c.json({ error: 'This node doesn\'t have a connection to this investor' }, 400);
  }

  // Check for existing active intro
  const existing = await db.query.introRequests.findFirst({
    where: and(
      eq(introRequests.founderId, founderId),
      eq(introRequests.investorId, parsed.data.investorId),
      inArray(introRequests.status, [
        'intro_request_sent', 'introduced', 'first_meeting_complete',
        'second_meeting_complete', 'follow_up_questions',
      ])
    ),
  });

  if (existing) {
    return c.json({ error: 'You already have an active intro request to this investor' }, 400);
  }

  const now = new Date().toISOString();
  const result = await db.insert(introRequests).values({
    founderId,
    nodeId: parsed.data.nodeId,
    investorId: parsed.data.investorId,
    status: 'intro_request_sent',
    dateRequested: now.split('T')[0],
    notes: parsed.data.notes,
    createdAt: now,
    updatedAt: now,
  }).returning();

  return c.json(result[0], 201);
});

// Update intro request status (limited options for founders)
app.put('/my-intros/:id', async (c) => {
  const founderId = c.get('founderId') as number;
  const introId = parseInt(c.req.param('id'));
  const body = await c.req.json();

  // Verify ownership
  const intro = await db.query.introRequests.findFirst({
    where: and(
      eq(introRequests.id, introId),
      eq(introRequests.founderId, founderId)
    ),
  });

  if (!intro) {
    return c.json({ error: 'Intro request not found' }, 404);
  }

  const schema = z.object({
    status: z.enum([
      'first_meeting_complete',
      'second_meeting_complete',
      'follow_up_questions',
      'circle_back_round_opens',
      'invested',
      'not_a_fit',
    ]).optional(),
    firstMeetingDate: z.string().optional(),
    secondMeetingDate: z.string().optional(),
    nextFollowupDate: z.string().optional(),
    notes: z.string().optional(),
  });

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues }, 400);
  }

  const now = new Date().toISOString();
  const result = await db.update(introRequests)
    .set({ ...parsed.data, updatedAt: now })
    .where(eq(introRequests.id, introId))
    .returning();

  return c.json(result[0]);
});

// Log a follow-up
app.post('/my-intros/:id/followup', async (c) => {
  const founderId = c.get('founderId') as number;
  const introId = parseInt(c.req.param('id'));
  const body = await c.req.json();

  // Verify ownership
  const intro = await db.query.introRequests.findFirst({
    where: and(
      eq(introRequests.id, introId),
      eq(introRequests.founderId, founderId)
    ),
  });

  if (!intro) {
    return c.json({ error: 'Intro request not found' }, 404);
  }

  const schema = z.object({
    followupType: z.enum(['node_check', 'meeting_update', 'node_update']),
    notes: z.string().optional(),
    nextAction: z.string().optional(),
  });

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues }, 400);
  }

  const now = new Date().toISOString();
  const result = await db.insert(followupLogs).values({
    introRequestId: introId,
    followupType: parsed.data.followupType,
    completedBy: 'founder',
    completedAt: now,
    notes: parsed.data.notes,
    nextAction: parsed.data.nextAction,
  }).returning();

  // Update last followup date
  await db.update(introRequests)
    .set({ lastFollowupDate: now.split('T')[0], updatedAt: now })
    .where(eq(introRequests.id, introId));

  return c.json(result[0], 201);
});

// Get follow-up tasks (things founder needs to do - post-intro only)
// Once a founder updates a task, suppress for 14 days, then resurface
app.get('/tasks', async (c) => {
  const founderId = c.get('founderId') as number;
  const today = new Date().toISOString().split('T')[0];
  const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

  const allIntros = await db.query.introRequests.findMany({
    where: eq(introRequests.founderId, founderId),
    with: { node: true, investor: true, followupLogs: true },
  });

  const tasks: {
    type: string;
    priority: 'high' | 'medium' | 'low';
    intro: any;
    message: string;
  }[] = [];

  for (const intro of allIntros) {
    // Skip terminal statuses and pre-intro (node's responsibility)
    if (['passed', 'ignored', 'invested', 'not_a_fit', 'intro_request_sent'].includes(intro.status)) {
      continue;
    }

    // 1. Explicit follow-up dates always trigger (overdue = high priority)
    if (intro.nextFollowupDate && intro.nextFollowupDate < today) {
      tasks.push({
        type: 'overdue_followup',
        priority: 'high',
        intro,
        message: `Follow up with ${intro.investor.name} @ ${intro.investor.firm} (was due ${intro.nextFollowupDate})`,
      });
      continue;
    }

    // 2. Due today (high priority)
    if (intro.nextFollowupDate === today) {
      tasks.push({
        type: 'due_today',
        priority: 'high',
        intro,
        message: `Follow up with ${intro.investor.name} @ ${intro.investor.firm} today`,
      });
      continue;
    }

    // Determine if founder has taken action on this intro
    // If updatedAt is more than 1 minute after createdAt, founder has touched it
    const createdTime = new Date(intro.createdAt).getTime();
    const updatedTime = new Date(intro.updatedAt || intro.createdAt).getTime();
    const founderHasTouched = (updatedTime - createdTime) > 60000; // 1 minute buffer

    // 3. If founder has touched it within last 14 days, suppress
    if (founderHasTouched && intro.updatedAt && intro.updatedAt > fourteenDaysAgo) {
      continue;
    }

    // 4. If founder touched it 14+ days ago, show check-in
    if (founderHasTouched) {
      tasks.push({
        type: 'check_in',
        priority: 'medium',
        intro,
        message: `Check in: Any update on ${intro.investor.name} @ ${intro.investor.firm}?`,
      });
      continue;
    }

    // 5. Founder hasn't touched it yet - show task based on status
    // (No grace period - show immediately so founders know to update)

    let message = '';
    switch (intro.status) {
      case 'introduced':
        message = `Update needed: ${intro.investor.name} @ ${intro.investor.firm} - how did it go?`;
        break;
      case 'first_meeting_complete':
        message = `Update needed: ${intro.investor.name} @ ${intro.investor.firm} - next steps?`;
        break;
      case 'second_meeting_complete':
        message = `Update needed: ${intro.investor.name} @ ${intro.investor.firm} - what's the outcome?`;
        break;
      case 'follow_up_questions':
        message = `Action needed: ${intro.investor.name} @ ${intro.investor.firm} has follow-up questions`;
        break;
      case 'circle_back_round_opens':
        message = `Time to reconnect with ${intro.investor.name} @ ${intro.investor.firm}?`;
        break;
      default:
        message = `Update needed: ${intro.investor.name} @ ${intro.investor.firm}`;
    }

    tasks.push({
      type: 'needs_update',
      priority: 'high',
      intro,
      message,
    });
  }

  // Sort by priority
  const priorityOrder = { high: 0, medium: 1, low: 2 };
  tasks.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

  return c.json(tasks);
});

// Get nodes for founder (working with + available)
app.get('/nodes', async (c) => {
  const founderId = c.get('founderId') as number;

  // Get all intro requests for this founder to find nodes they're working with
  const founderIntros = await db.query.introRequests.findMany({
    where: eq(introRequests.founderId, founderId),
    with: {
      node: true,
      investor: true,
    },
  });

  // Group intros by node
  const nodeIntroMap = new Map<number, {
    node: any;
    intros: any[];
    activeCount: number;
    investedCount: number;
  }>();

  for (const intro of founderIntros) {
    if (!nodeIntroMap.has(intro.nodeId)) {
      nodeIntroMap.set(intro.nodeId, {
        node: intro.node,
        intros: [],
        activeCount: 0,
        investedCount: 0,
      });
    }
    const entry = nodeIntroMap.get(intro.nodeId)!;
    entry.intros.push(intro);
    if (!['passed', 'ignored', 'invested', 'not_a_fit'].includes(intro.status)) {
      entry.activeCount++;
    }
    if (intro.status === 'invested') {
      entry.investedCount++;
    }
  }

  const workingWithNodes = Array.from(nodeIntroMap.values()).map(entry => ({
    id: entry.node.id,
    name: entry.node.name,
    company: entry.node.company,
    role: entry.node.role,
    totalIntros: entry.intros.length,
    activeIntros: entry.activeCount,
    invested: entry.investedCount,
  }));

  // Get all other nodes that this founder is NOT working with
  const workingNodeIds = Array.from(nodeIntroMap.keys());

  let availableNodes: any[] = [];
  if (workingNodeIds.length > 0) {
    availableNodes = await db.query.nodes.findMany({
      where: notInArray(nodes.id, workingNodeIds),
    });
  } else {
    availableNodes = await db.query.nodes.findMany();
  }

  // Get investor counts for available nodes
  const availableNodesWithCounts = await Promise.all(
    availableNodes.map(async (node) => {
      const connections = await db.query.nodeInvestorConnections.findMany({
        where: eq(nodeInvestorConnections.nodeId, node.id),
      });
      return {
        id: node.id,
        name: node.name,
        company: node.company,
        role: node.role,
        investorCount: connections.length,
      };
    })
  );

  // Sort: working nodes by active intros desc, available by investor count desc
  workingWithNodes.sort((a, b) => b.activeIntros - a.activeIntros);
  availableNodesWithCounts.sort((a, b) => b.investorCount - a.investorCount);

  return c.json({
    workingWith: workingWithNodes,
    available: availableNodesWithCounts,
  });
});

export default app;
