import { Hono } from 'hono';
import { eq, and, lt, isNull, inArray, or } from 'drizzle-orm';
import { db, introRequests, founders, nodes, investors } from '../db/index.js';

const app = new Hono();

// Get daily digest data for a founder
app.get('/founder/:founderId', async (c) => {
  const founderId = parseInt(c.req.param('founderId'));
  const today = new Date().toISOString().split('T')[0];
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  // Get founder info
  const founder = await db.query.founders.findFirst({
    where: eq(founders.id, founderId),
  });

  if (!founder) {
    return c.json({ error: 'Founder not found' }, 404);
  }

  // Overdue follow-ups (founder is responsible)
  const overdueFollowups = await db.query.introRequests.findMany({
    where: and(
      eq(introRequests.founderId, founderId),
      eq(introRequests.followupOwner, 'founder'),
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
    with: { node: true, investor: true },
  });

  // Due today
  const dueToday = await db.query.introRequests.findMany({
    where: and(
      eq(introRequests.founderId, founderId),
      eq(introRequests.followupOwner, 'founder'),
      eq(introRequests.nextFollowupDate, today)
    ),
    with: { node: true, investor: true },
  });

  // Pending node response (sent 3+ days ago, no response)
  const pendingNodeResponse = await db.query.introRequests.findMany({
    where: and(
      eq(introRequests.founderId, founderId),
      eq(introRequests.status, 'intro_request_sent'),
      isNull(introRequests.dateNodeAsked),
      lt(introRequests.dateRequested, threeDaysAgo)
    ),
    with: { node: true, investor: true },
  });

  // Nodes to update (meetings complete but no node update logged)
  const needsNodeUpdate = await db.query.introRequests.findMany({
    where: and(
      eq(introRequests.founderId, founderId),
      inArray(introRequests.status, ['first_meeting_complete', 'second_meeting_complete', 'invested'])
    ),
    with: {
      node: true,
      investor: true,
      followupLogs: true,
    },
  });

  // Filter to those without a node_update log
  const nodesNeedingUpdate = needsNodeUpdate.filter(req =>
    !req.followupLogs.some(log => log.followupType === 'node_update')
  );

  return c.json({
    founder,
    digest: {
      overdueFollowups,
      dueToday,
      pendingNodeResponse,
      nodesNeedingUpdate,
    },
    summary: {
      overdueCount: overdueFollowups.length,
      dueTodayCount: dueToday.length,
      pendingNodeCount: pendingNodeResponse.length,
      nodesNeedingUpdateCount: nodesNeedingUpdate.length,
    },
  });
});

// Get all founders who need a digest email today
app.get('/pending', async (c) => {
  const today = new Date().toISOString().split('T')[0];
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  // Get all active intro requests that need attention
  const needsAttention = await db.query.introRequests.findMany({
    where: or(
      // Overdue
      and(
        lt(introRequests.nextFollowupDate, today),
        inArray(introRequests.status, [
          'intro_request_sent',
          'introduced',
          'first_meeting_complete',
          'second_meeting_complete',
          'follow_up_questions',
        ])
      ),
      // Due today
      eq(introRequests.nextFollowupDate, today),
      // Pending node response
      and(
        eq(introRequests.status, 'intro_request_sent'),
        isNull(introRequests.dateNodeAsked),
        lt(introRequests.dateRequested, threeDaysAgo)
      )
    ),
    with: { founder: true },
  });

  // Group by founder
  const founderIds = [...new Set(needsAttention.map(r => r.founderId))];

  const foundersNeedingDigest = await Promise.all(
    founderIds.map(async (id) => {
      const founder = await db.query.founders.findFirst({
        where: eq(founders.id, id),
      });
      const actionCount = needsAttention.filter(r => r.founderId === id).length;
      return { founder, actionCount };
    })
  );

  return c.json(foundersNeedingDigest);
});

// Admin digest - all overdue and pending items
app.get('/admin', async (c) => {
  const today = new Date().toISOString().split('T')[0];
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  // Escalated items (5+ days no node response)
  const escalated = await db.query.introRequests.findMany({
    where: and(
      eq(introRequests.status, 'intro_request_sent'),
      isNull(introRequests.dateNodeAsked),
      lt(introRequests.dateRequested, fiveDaysAgo)
    ),
    with: { founder: true, node: true, investor: true },
  });

  // All overdue (admin-owned)
  const adminOverdue = await db.query.introRequests.findMany({
    where: and(
      eq(introRequests.followupOwner, 'admin'),
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
    with: { founder: true, node: true, investor: true },
  });

  // Founders with round now open (for circle-back re-engagement)
  const roundOpenFounders = await db.query.founders.findMany({
    where: eq(founders.roundStatus, 'round_open'),
  });

  const circleBackOpportunities = await db.query.introRequests.findMany({
    where: and(
      eq(introRequests.status, 'circle_back_round_opens'),
      inArray(introRequests.founderId, roundOpenFounders.map(f => f.id))
    ),
    with: { founder: true, node: true, investor: true },
  });

  return c.json({
    escalated,
    adminOverdue,
    circleBackOpportunities,
    summary: {
      escalatedCount: escalated.length,
      adminOverdueCount: adminOverdue.length,
      circleBackCount: circleBackOpportunities.length,
    },
  });
});

export default app;
