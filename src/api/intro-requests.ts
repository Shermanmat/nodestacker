import { Hono } from 'hono';
import { eq, and, lt, isNull, inArray, sql, desc } from 'drizzle-orm';
import { db, introRequests, founderNodeRelationships, nodeInvestorConnections, followupLogs } from '../db/index.js';
import { z } from 'zod';

const app = new Hono();

const introStatusValues = [
  'intro_request_sent',
  'introduced',
  'passed',
  'ignored',
  'first_meeting_complete',
  'second_meeting_complete',
  'follow_up_questions',
  'circle_back_round_opens',
  'invested',
] as const;

const createIntroRequestSchema = z.object({
  founderId: z.number(),
  nodeId: z.number(),
  investorId: z.number(),
  status: z.enum(introStatusValues).optional(),
  dateRequested: z.string().optional(),
  notes: z.string().optional(),
});

const updateIntroRequestSchema = z.object({
  nodeId: z.number().optional(),
  status: z.enum(introStatusValues).optional(),
  dateNodeAsked: z.string().nullable().optional(),
  dateIntroduced: z.string().nullable().optional(),
  firstMeetingDate: z.string().nullable().optional(),
  secondMeetingDate: z.string().nullable().optional(),
  nextFollowupDate: z.string().nullable().optional(),
  lastFollowupDate: z.string().nullable().optional(),
  followupOwner: z.enum(['founder', 'admin']).nullable().optional(),
  passReason: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
}).strip();

// List all intro requests with filters
app.get('/', async (c) => {
  const status = c.req.query('status');
  const founderId = c.req.query('founderId');
  const nodeId = c.req.query('nodeId');
  const investorId = c.req.query('investorId');

  const requests = await db.query.introRequests.findMany({
    with: {
      founder: true,
      node: true,
      investor: true,
    },
    orderBy: desc(introRequests.createdAt),
  });

  let filtered = requests;
  if (status) {
    filtered = filtered.filter(r => r.status === status);
  }
  if (founderId) {
    filtered = filtered.filter(r => r.founderId === parseInt(founderId));
  }
  if (nodeId) {
    filtered = filtered.filter(r => r.nodeId === parseInt(nodeId));
  }
  if (investorId) {
    filtered = filtered.filter(r => r.investorId === parseInt(investorId));
  }

  return c.json(filtered);
});

// Get single intro request
app.get('/:id', async (c) => {
  const id = parseInt(c.req.param('id'));
  const request = await db.query.introRequests.findFirst({
    where: eq(introRequests.id, id),
    with: {
      founder: true,
      node: true,
      investor: true,
      followupLogs: true,
    },
  });

  if (!request) {
    return c.json({ error: 'Intro request not found' }, 404);
  }
  return c.json(request);
});

// Create intro request with validation
app.post('/', async (c) => {
  const body = await c.req.json();
  const parsed = createIntroRequestSchema.safeParse(body);

  if (!parsed.success) {
    const errorMsg = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ');
    return c.json({ error: errorMsg || 'Invalid data' }, 400);
  }

  // Validate founder-node relationship exists
  const fnRelation = await db.query.founderNodeRelationships.findFirst({
    where: and(
      eq(founderNodeRelationships.founderId, parsed.data.founderId),
      eq(founderNodeRelationships.nodeId, parsed.data.nodeId)
    ),
  });

  if (!fnRelation) {
    return c.json({ error: 'Founder does not have a relationship with this node' }, 400);
  }

  // Validate node-investor connection exists
  const niConnection = await db.query.nodeInvestorConnections.findFirst({
    where: and(
      eq(nodeInvestorConnections.nodeId, parsed.data.nodeId),
      eq(nodeInvestorConnections.investorId, parsed.data.investorId)
    ),
  });

  if (!niConnection) {
    return c.json({ error: 'Node does not have a connection to this investor' }, 400);
  }

  // Check for existing active intro request for this founder-investor pair
  const existingRequest = await db.query.introRequests.findFirst({
    where: and(
      eq(introRequests.founderId, parsed.data.founderId),
      eq(introRequests.investorId, parsed.data.investorId),
      inArray(introRequests.status, [
        'intro_request_sent',
        'introduced',
        'first_meeting_complete',
        'second_meeting_complete',
        'follow_up_questions',
      ])
    ),
  });

  if (existingRequest) {
    return c.json({ error: 'Active intro request already exists for this founder-investor pair' }, 400);
  }

  const now = new Date().toISOString();
  const result = await db.insert(introRequests).values({
    ...parsed.data,
    dateRequested: parsed.data.dateRequested || now.split('T')[0],
    status: parsed.data.status || 'intro_request_sent',
    createdAt: now,
    updatedAt: now,
  }).returning();

  return c.json(result[0], 201);
});

// Update intro request
app.put('/:id', async (c) => {
  const id = parseInt(c.req.param('id'));
  const body = await c.req.json();
  const parsed = updateIntroRequestSchema.safeParse(body);

  if (!parsed.success) {
    const errorMsg = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ');
    return c.json({ error: errorMsg || 'Invalid data' }, 400);
  }

  const now = new Date().toISOString();
  const result = await db.update(introRequests)
    .set({
      ...parsed.data,
      updatedAt: now,
    })
    .where(eq(introRequests.id, id))
    .returning();

  if (result.length === 0) {
    return c.json({ error: 'Intro request not found' }, 404);
  }
  return c.json(result[0]);
});

// Delete intro request
app.delete('/:id', async (c) => {
  const id = parseInt(c.req.param('id'));
  const result = await db.delete(introRequests).where(eq(introRequests.id, id)).returning();

  if (result.length === 0) {
    return c.json({ error: 'Intro request not found' }, 404);
  }
  return c.json({ success: true });
});

// Add followup log
app.post('/:id/followups', async (c) => {
  const introRequestId = parseInt(c.req.param('id'));
  const body = await c.req.json();

  const schema = z.object({
    followupType: z.enum(['node_check', 'meeting_update', 'node_update']),
    completedBy: z.enum(['founder', 'admin']),
    notes: z.string().optional(),
    nextAction: z.string().optional(),
  });

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const errorMsg = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ');
    return c.json({ error: errorMsg || 'Invalid data' }, 400);
  }

  const now = new Date().toISOString();
  const result = await db.insert(followupLogs).values({
    introRequestId,
    ...parsed.data,
    completedAt: now,
  }).returning();

  // Update last followup date on intro request
  await db.update(introRequests)
    .set({ lastFollowupDate: now.split('T')[0], updatedAt: now })
    .where(eq(introRequests.id, introRequestId));

  return c.json(result[0], 201);
});

// Get followup logs for intro request
app.get('/:id/followups', async (c) => {
  const introRequestId = parseInt(c.req.param('id'));
  const logs = await db.select()
    .from(followupLogs)
    .where(eq(followupLogs.introRequestId, introRequestId));
  return c.json(logs);
});

// Dashboard Views

// View 1: Pending Node Response (node hasn't acted after 3+ days)
app.get('/views/pending-node-response', async (c) => {
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  const results = await db.query.introRequests.findMany({
    where: and(
      eq(introRequests.status, 'intro_request_sent'),
      isNull(introRequests.dateNodeAsked),
      lt(introRequests.dateRequested, threeDaysAgo)
    ),
    with: {
      founder: true,
      node: true,
      investor: true,
    },
    orderBy: introRequests.dateRequested,
  });

  return c.json(results);
});

// View 2: Ignored by Investors (grouped by investor)
app.get('/views/ignored-by-investor', async (c) => {
  const results = await db.query.introRequests.findMany({
    where: eq(introRequests.status, 'ignored'),
    with: {
      founder: true,
      node: true,
      investor: true,
    },
  });

  // Group by investor
  const grouped = results.reduce((acc, r) => {
    const key = r.investorId;
    if (!acc[key]) {
      acc[key] = {
        investor: r.investor,
        count: 0,
        requests: [],
      };
    }
    acc[key].count++;
    acc[key].requests.push(r);
    return acc;
  }, {} as Record<number, { investor: typeof results[0]['investor']; count: number; requests: typeof results }>);

  return c.json(Object.values(grouped).sort((a, b) => b.count - a.count));
});

// View 3: Needs Follow-Up Scheduled
app.get('/views/needs-followup', async (c) => {
  const results = await db.query.introRequests.findMany({
    where: and(
      inArray(introRequests.status, ['first_meeting_complete', 'second_meeting_complete']),
      isNull(introRequests.nextFollowupDate)
    ),
    with: {
      founder: true,
      node: true,
      investor: true,
    },
  });

  return c.json(results);
});

// View 4: Overdue Follow-Ups
app.get('/views/overdue', async (c) => {
  const today = new Date().toISOString().split('T')[0];

  const results = await db.query.introRequests.findMany({
    where: and(
      lt(introRequests.nextFollowupDate, today),
      inArray(introRequests.status, [
        'intro_request_sent',
        'introduced',
        'first_meeting_complete',
        'second_meeting_complete',
        'follow_up_questions',
        'circle_back_round_opens',
      ])
    ),
    with: {
      founder: true,
      node: true,
      investor: true,
    },
    orderBy: introRequests.nextFollowupDate,
  });

  return c.json(results);
});

// View 5: Circle Back Pipeline
app.get('/views/circle-back', async (c) => {
  const results = await db.query.introRequests.findMany({
    where: eq(introRequests.status, 'circle_back_round_opens'),
    with: {
      founder: true,
      node: true,
      investor: true,
    },
    orderBy: [introRequests.founderId, introRequests.lastFollowupDate],
  });

  return c.json(results);
});

// Trends/Stats Over Time
app.get('/stats/trends', async (c) => {
  const nodeId = c.req.query('nodeId');

  let allRequests;
  if (nodeId) {
    allRequests = await db.select().from(introRequests).where(eq(introRequests.nodeId, parseInt(nodeId)));
  } else {
    allRequests = await db.select().from(introRequests);
  }

  // Group by month using dateRequested (YYYY-MM)
  const monthlyData: Record<string, {
    total: number;
    introduced: number;
    meetings: number; // first_meeting_complete or beyond
    passed: number;
    ignored: number;
    invested: number;
  }> = {};

  for (const req of allRequests) {
    const dateStr = req.dateRequested || req.createdAt;
    if (!dateStr) continue;

    const month = dateStr.substring(0, 7); // YYYY-MM

    if (!monthlyData[month]) {
      monthlyData[month] = { total: 0, introduced: 0, meetings: 0, passed: 0, ignored: 0, invested: 0 };
    }

    monthlyData[month].total++;

    // Count statuses
    // Note: follow_up_questions is PRE-intro (investor asking questions before deciding), not POST-intro
    if (req.status === 'introduced' || ['first_meeting_complete', 'second_meeting_complete', 'circle_back_round_opens', 'invested'].includes(req.status)) {
      monthlyData[month].introduced++;
    }
    if (['first_meeting_complete', 'second_meeting_complete', 'circle_back_round_opens', 'invested'].includes(req.status)) {
      monthlyData[month].meetings++;
    }
    if (req.status === 'passed') {
      monthlyData[month].passed++;
    }
    if (req.status === 'ignored') {
      monthlyData[month].ignored++;
    }
    if (req.status === 'invested') {
      monthlyData[month].invested++;
    }
  }

  // Ensure current month is included even if empty
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  if (!monthlyData[currentMonth]) {
    monthlyData[currentMonth] = { total: 0, introduced: 0, meetings: 0, passed: 0, ignored: 0, invested: 0 };
  }

  // Sort months and get last 6
  const sortedMonths = Object.keys(monthlyData).sort().reverse().slice(0, 6);

  // Calculate rates and format for response
  const monthlyStats = sortedMonths.map(month => {
    const data = monthlyData[month];
    // data.introduced already includes all accepted statuses (introduced, meetings, invested)
    // Decided = accepted + passed + ignored (excludes pending)
    const decided = data.introduced + data.passed + data.ignored;
    return {
      month,
      label: formatMonthLabel(month),
      total: data.total,
      introduced: data.introduced,
      meetings: data.meetings,
      passed: data.passed,
      ignored: data.ignored,
      invested: data.invested,
      // Accept Rate = accepted / (accepted + passed + ignored)
      acceptRate: decided > 0 ? Math.round((data.introduced / decided) * 100) : 0,
    };
  });

  // Current vs previous month comparison
  const current = monthlyStats[0] || { total: 0, introduced: 0, meetings: 0, passed: 0, ignored: 0, invested: 0, acceptRate: 0 };
  const previous = monthlyStats[1] || { total: 0, introduced: 0, meetings: 0, passed: 0, ignored: 0, invested: 0, acceptRate: 0 };

  const comparison = {
    intros: {
      current: current.total,
      previous: previous.total,
      change: current.total - previous.total,
      direction: current.total > previous.total ? 'up' : current.total < previous.total ? 'down' : 'same',
    },
    introduced: {
      current: current.introduced,
      previous: previous.introduced,
      change: current.introduced - previous.introduced,
      direction: current.introduced > previous.introduced ? 'up' : current.introduced < previous.introduced ? 'down' : 'same',
    },
    acceptRate: {
      current: current.acceptRate,
      previous: previous.acceptRate,
      change: current.acceptRate - previous.acceptRate,
      direction: current.acceptRate > previous.acceptRate ? 'up' : current.acceptRate < previous.acceptRate ? 'down' : 'same',
    },
    invested: {
      current: current.invested,
      previous: previous.invested,
      change: current.invested - previous.invested,
      direction: current.invested > previous.invested ? 'up' : current.invested < previous.invested ? 'down' : 'same',
    },
    ignored: {
      current: current.ignored,
      previous: previous.ignored,
      change: current.ignored - previous.ignored,
      direction: current.ignored < previous.ignored ? 'up' : current.ignored > previous.ignored ? 'down' : 'same', // Lower is better
    },
  };

  return c.json({
    monthlyStats: monthlyStats.reverse(), // Oldest first for charting
    comparison,
    currentMonth: current.label || 'This Month',
    previousMonth: previous.label || 'Last Month',
  });
});

function formatMonthLabel(month: string): string {
  const [year, m] = month.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthIndex = parseInt(m) - 1;
  if (isNaN(monthIndex) || monthIndex < 0 || monthIndex > 11) {
    return month; // Return raw month if parsing fails
  }
  return `${months[monthIndex]} ${year}`;
}

// Pipeline Stats
app.get('/stats/pipeline', async (c) => {
  const allRequests = await db.select().from(introRequests);

  const stats = {
    total: allRequests.length,
    byStatus: {} as Record<string, number>,
    overdueCount: 0,
    pendingNodeResponse: 0,
  };

  const today = new Date().toISOString().split('T')[0];
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  for (const req of allRequests) {
    stats.byStatus[req.status] = (stats.byStatus[req.status] || 0) + 1;

    if (req.nextFollowupDate && req.nextFollowupDate < today) {
      stats.overdueCount++;
    }

    if (req.status === 'intro_request_sent' && !req.dateNodeAsked && req.dateRequested && req.dateRequested < threeDaysAgo) {
      stats.pendingNodeResponse++;
    }
  }

  return c.json(stats);
});

// Investor MAU (Monthly Active Investors) - unique investors engaged per month
app.get('/stats/investor-mau', async (c) => {
  const allRequests = await db.select().from(introRequests);

  // Group by month and count unique investors that received at least one intro
  const monthlyInvestors: Record<string, Set<number>> = {};

  for (const req of allRequests) {
    // Use dateIntroduced as primary date (when investor was actually contacted)
    // Fall back to dateRequested or createdAt
    const dateStr = req.dateIntroduced || req.dateRequested || req.createdAt;
    if (!dateStr) continue;

    // Only count if intro was actually made (not just requested)
    // Status must be beyond 'intro_request_sent' OR have dateIntroduced set
    const wasIntroduced = req.dateIntroduced ||
      ['introduced', 'first_meeting_complete', 'second_meeting_complete',
       'circle_back_round_opens', 'invested', 'passed', 'ignored'].includes(req.status);

    if (!wasIntroduced) continue;

    const month = (req.dateIntroduced || dateStr).substring(0, 7); // YYYY-MM

    if (!monthlyInvestors[month]) {
      monthlyInvestors[month] = new Set();
    }
    monthlyInvestors[month].add(req.investorId);
  }

  // Ensure current month is included
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  if (!monthlyInvestors[currentMonth]) {
    monthlyInvestors[currentMonth] = new Set();
  }

  // Sort months and get last 12
  const sortedMonths = Object.keys(monthlyInvestors).sort().reverse().slice(0, 12);

  const monthlyStats = sortedMonths.map(month => ({
    month,
    label: formatMonthLabel(month),
    uniqueInvestors: monthlyInvestors[month].size,
  }));

  return c.json({
    monthlyStats: monthlyStats.reverse(), // Oldest first for charting
  });
});

// Admin/Node Tasks - tasks for the node (person making intros)
// Timeline: Day 3 = "schedule meeting?", Day 14 = "did they meet?"
// Only intros after May 2025
app.get('/tasks/node/:nodeId', async (c) => {
  const nodeId = parseInt(c.req.param('nodeId'));
  const now = Date.now();
  const threeDaysAgo = new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString();
  const fourteenDaysAgo = new Date(now - 14 * 24 * 60 * 60 * 1000).toISOString();
  const may2025 = '2025-05-01T00:00:00.000Z';

  const allIntros = await db.query.introRequests.findMany({
    where: eq(introRequests.nodeId, nodeId),
    with: { founder: true, node: true, investor: true },
  });

  const tasks: {
    type: string;
    priority: 'high' | 'medium' | 'low';
    intro: any;
    message: string;
  }[] = [];

  for (const intro of allIntros) {
    // Skip intros before May 2025 (use dateRequested as the real date)
    const introRealDate = intro.dateRequested || intro.createdAt;
    if (introRealDate < may2025) {
      continue;
    }

    // Skip terminal statuses and pre-intro (not made yet)
    if (['passed', 'ignored', 'invested', 'intro_request_sent'].includes(intro.status)) {
      continue;
    }

    // Check if founder/admin has updated this intro (updatedAt differs from createdAt by > 1 min)
    const createdTime = new Date(intro.createdAt).getTime();
    const updatedTime = new Date(intro.updatedAt || intro.createdAt).getTime();
    const hasBeenUpdated = (updatedTime - createdTime) > 60000;

    // If updated within last 14 days, suppress all tasks
    if (hasBeenUpdated && intro.updatedAt && intro.updatedAt > fourteenDaysAgo) {
      continue;
    }

    // If updated 14+ days ago, show check-in
    if (hasBeenUpdated) {
      tasks.push({
        type: 'check_in',
        priority: 'medium',
        intro,
        message: `Check in with ${intro.founder.name} on ${intro.investor.name} @ ${intro.investor.firm}`,
      });
      continue;
    }

    // Not updated yet - check timing based on status
    if (intro.status === 'introduced') {
      // Use dateIntroduced, then dateRequested, then createdAt as fallback
      const introDate = intro.dateIntroduced || intro.dateRequested || intro.createdAt;

      if (introDate < fourteenDaysAgo) {
        // 14+ days: Did they meet?
        tasks.push({
          type: 'check_meeting',
          priority: 'high',
          intro,
          message: `Did ${intro.founder.name} meet with ${intro.investor.name} @ ${intro.investor.firm}?`,
        });
      } else if (introDate < threeDaysAgo) {
        // 3-14 days: Did they schedule?
        tasks.push({
          type: 'check_schedule',
          priority: 'medium',
          intro,
          message: `Did ${intro.founder.name} schedule a meeting with ${intro.investor.name} @ ${intro.investor.firm}?`,
        });
      }
      // Less than 3 days: no task yet
      continue;
    }

    // Other statuses - show appropriate task
    let message = '';
    let priority: 'high' | 'medium' | 'low' = 'medium';

    switch (intro.status) {
      case 'first_meeting_complete':
        message = `How did ${intro.founder.name}'s meeting with ${intro.investor.name} go?`;
        break;
      case 'second_meeting_complete':
        message = `${intro.founder.name} + ${intro.investor.name} - any outcome yet?`;
        break;
      case 'follow_up_questions':
        message = `${intro.investor.name} had questions for ${intro.founder.name} - resolved?`;
        priority = 'high';
        break;
      case 'circle_back_round_opens':
        message = `Time to reconnect ${intro.founder.name} with ${intro.investor.name}?`;
        priority = 'low';
        break;
      default:
        message = `Check on ${intro.founder.name} + ${intro.investor.name} @ ${intro.investor.firm}`;
    }

    tasks.push({
      type: intro.status,
      priority,
      intro,
      message,
    });
  }

  // Sort by priority
  const priorityOrder = { high: 0, medium: 1, low: 2 };
  tasks.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

  // Group by founder
  const grouped: Record<number, {
    founder: { id: number; name: string; companyName: string };
    tasks: typeof tasks;
    highPriorityCount: number;
  }> = {};

  for (const task of tasks) {
    const founderId = task.intro.founderId;
    if (!grouped[founderId]) {
      grouped[founderId] = {
        founder: {
          id: task.intro.founder.id,
          name: task.intro.founder.name,
          companyName: task.intro.founder.companyName,
        },
        tasks: [],
        highPriorityCount: 0,
      };
    }
    grouped[founderId].tasks.push(task);
    if (task.priority === 'high') {
      grouped[founderId].highPriorityCount++;
    }
  }

  // Sort founders by high priority count desc
  const sortedGroups = Object.values(grouped).sort((a, b) => b.highPriorityCount - a.highPriorityCount);

  return c.json(sortedGroups);
});

// One-time migration: convert 'not_a_fit' to 'passed'
(async () => {
  try {
    const result = await db
      .update(introRequests)
      .set({ status: 'passed' })
      .where(eq(introRequests.status, 'not_a_fit'));
    console.log('✅ Migrated not_a_fit statuses to passed');
  } catch (err) {
    console.error('Failed to migrate not_a_fit statuses:', err);
  }
})();

// Auto-ignore stale intro requests (unchanged for 3 weeks)
// Runs every hour
setInterval(async () => {
  try {
    const threeWeeksAgo = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000).toISOString();

    // Find requests that are still in 'intro_request_sent' status and haven't been updated in 3 weeks
    const staleRequests = await db
      .select({ id: introRequests.id })
      .from(introRequests)
      .where(
        and(
          eq(introRequests.status, 'intro_request_sent'),
          lt(introRequests.updatedAt, threeWeeksAgo)
        )
      );

    if (staleRequests.length > 0) {
      const staleIds = staleRequests.map(r => r.id);
      await db
        .update(introRequests)
        .set({
          status: 'ignored',
          updatedAt: new Date().toISOString()
        })
        .where(inArray(introRequests.id, staleIds));

      console.log(`🧹 Auto-ignored ${staleRequests.length} stale intro requests`);
    }
  } catch (err) {
    console.error('Failed to auto-ignore stale requests:', err);
  }
}, 60 * 60 * 1000); // Every hour

export default app;
