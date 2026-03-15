import { Hono } from 'hono';
import { eq, and, inArray, notInArray, desc, sql } from 'drizzle-orm';
import { db, founders, nodes, investors, founderNodeRelationships, nodeInvestorConnections, introRequests, followupLogs, investorResearch, portfolioCompanies, onboardingWorkflows, onboardingEvents, boardMembers, OnboardingStatus, OnboardingEventType, OnboardingActor } from '../db/index.js';
import { getSessionFounderId } from './auth.js';
import { z } from 'zod';
import * as onboardingEmails from '../services/onboarding-emails.js';
import * as esign from '../services/esign.js';
import { checkFirmBlocked } from '../services/matching.js';

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

  // Get founder's intro requests
  const allIntros = await db.query.introRequests.findMany({
    where: eq(introRequests.founderId, founderId),
  });

  // Get global stats for comparison
  const allGlobalIntros = await db.query.introRequests.findMany();

  const today = new Date().toISOString().split('T')[0];

  // Count by status
  const totalRequests = allIntros.length;
  const introduced = allIntros.filter(i =>
    ['introduced', 'first_meeting_complete', 'second_meeting_complete', 'follow_up_questions', 'invested', 'circle_back_round_opens'].includes(i.status)
  ).length;
  const passed = allIntros.filter(i => i.status === 'passed').length;
  const ignored = allIntros.filter(i => i.status === 'ignored').length;
  const pending = allIntros.filter(i => i.status === 'intro_request_sent').length;
  const invested = allIntros.filter(i => i.status === 'invested').length;

  // Calculate accept rates
  const acceptRate = totalRequests > 0 ? Math.round((introduced / totalRequests) * 100) : 0;

  // Global accept rate
  const globalTotal = allGlobalIntros.length;
  const globalIntroduced = allGlobalIntros.filter(i =>
    ['introduced', 'first_meeting_complete', 'second_meeting_complete', 'follow_up_questions', 'invested', 'circle_back_round_opens'].includes(i.status)
  ).length;
  const globalAcceptRate = globalTotal > 0 ? Math.round((globalIntroduced / globalTotal) * 100) : 0;

  const stats = {
    totalRequests,
    introduced,
    passed,
    ignored,
    pending,
    invested,
    acceptRate,
    globalAcceptRate,
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

  // Firm-level dedup: block if another investor at this firm already has an intro for this founder
  const blockedFirm = await checkFirmBlocked(founderId, parsed.data.investorId);
  if (blockedFirm) {
    return c.json({ error: `Another investor at ${blockedFirm} already has an intro request for you` }, 400);
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
      'passed',
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
    if (['passed', 'ignored', 'invested', 'intro_request_sent'].includes(intro.status)) {
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
    // Give a 3-day grace period for newly introduced intros before showing task
    if (intro.status === 'introduced' && intro.createdAt > threeDaysAgo) {
      continue;
    }

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
    if (!['passed', 'ignored', 'invested'].includes(intro.status)) {
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

// ============== ONBOARDING ENDPOINTS ==============

// Helper function to log onboarding events
async function logOnboardingEvent(
  workflowId: number,
  eventType: string,
  actorEmail?: string,
  details?: Record<string, any>
) {
  await db.insert(onboardingEvents).values({
    workflowId,
    eventType,
    actor: OnboardingActor.FOUNDER,
    actorEmail,
    details: details ? JSON.stringify(details) : undefined,
    createdAt: new Date().toISOString(),
  });
}

// Get current onboarding status
app.get('/onboarding/status', async (c) => {
  const founderId = c.get('founderId') as number;

  // Find portfolio company for this founder
  const portfolioCompany = await db.query.portfolioCompanies.findFirst({
    where: eq(portfolioCompanies.founderId, founderId),
    with: {
      founder: true,
    },
  });

  if (!portfolioCompany) {
    return c.json({ hasOnboarding: false, message: 'Not yet a portfolio company' });
  }

  // Find onboarding workflow
  const workflow = await db.query.onboardingWorkflows.findFirst({
    where: eq(onboardingWorkflows.portfolioCompanyId, portfolioCompany.id),
    with: {
      events: true,
      boardMembers: true,
    },
  });

  if (!workflow) {
    return c.json({ hasOnboarding: false, message: 'No onboarding workflow started' });
  }

  // Calculate share details if available
  let shareDetails = null;
  if (workflow.authorizedShares && workflow.offerEquityPercent && workflow.sharePrice) {
    const shareCount = Math.round(workflow.authorizedShares * (parseFloat(workflow.offerEquityPercent) / 100));
    shareDetails = {
      shareCount,
      sharePrice: workflow.sharePrice,
      totalAmount: (shareCount * parseFloat(workflow.sharePrice)).toFixed(2),
    };
  }

  // Determine next action for founder
  let nextAction = null;
  switch (workflow.status) {
    case OnboardingStatus.OFFER_PENDING:
      if (workflow.offerSentAt) {
        nextAction = { type: 'accept_offer', message: 'Accept or decline the offer' };
      }
      break;
    case OnboardingStatus.OFFER_ACCEPTED:
      if (workflow.incorporated === null || workflow.incorporated === undefined) {
        nextAction = { type: 'incorporation_question', message: 'Is your company incorporated?' };
      } else if (workflow.incorporated === false && !workflow.equityCommitmentSignedAt) {
        nextAction = { type: 'equity_commitment', message: 'Sign the pre-incorporation equity commitment' };
      } else {
        nextAction = { type: 'entity_info', message: 'Submit your company details' };
      }
      break;
    case OnboardingStatus.PENDING_INCORPORATION:
      nextAction = { type: 'confirm_incorporation', message: 'Let us know when you\'re incorporated' };
      break;
    case OnboardingStatus.LIGHT_ENGAGEMENT:
      if (!workflow.equityCommitmentSignedAt) {
        nextAction = { type: 'equity_commitment', message: 'Sign the pre-incorporation equity commitment' };
      } else {
        nextAction = { type: 'confirm_incorporation', message: 'When you incorporate, let us know and we\'ll get started on the equity paperwork' };
      }
      break;
    case OnboardingStatus.ENTITY_INFO_PENDING:
      nextAction = { type: 'entity_info', message: 'Submit your company details' };
      break;
    case OnboardingStatus.ADVISORY_AGREEMENT_SENT:
    case OnboardingStatus.ADMIN_SIGNED:
      nextAction = { type: 'sign_advisory', message: 'Sign the advisory agreement (check your email)' };
      break;
    case OnboardingStatus.FOUNDER_SIGNED:
    case OnboardingStatus.BOARD_APPROVAL_PENDING:
      nextAction = { type: 'board_approval', message: 'Board members must approve the equity issuance' };
      break;
    case OnboardingStatus.BOARD_APPROVED:
    case OnboardingStatus.EQUITY_AGREEMENT_PENDING:
      nextAction = { type: 'sign_equity', message: 'Sign the stock agreement (check your email from Dropbox Sign)' };
      break;
    case OnboardingStatus.EQUITY_FOUNDER_SIGNED:
      nextAction = { type: 'wait', message: 'Waiting for Mat to sign the stock agreement' };
      break;
    case OnboardingStatus.EQUITY_ADMIN_SIGNED:
      nextAction = { type: 'sign_equity', message: 'Sign the stock agreement (check your email from Dropbox Sign)' };
      break;
    case OnboardingStatus.WIRE_INFO_PENDING:
    case OnboardingStatus.EQUITY_AGREEMENT_SIGNED:
      nextAction = { type: 'upload_wire_info', message: 'Upload your wire/payment info so Mat can purchase shares' };
      break;
    case OnboardingStatus.CERTIFICATE_PENDING:
      nextAction = { type: 'upload_certificate', message: 'Upload stock certificate' };
      break;
    case OnboardingStatus.COMPLETED:
      nextAction = null;
      break;
    default:
      nextAction = { type: 'wait', message: 'Waiting for admin action' };
  }

  return c.json({
    hasOnboarding: true,
    workflow: {
      id: workflow.id,
      status: workflow.status,
      offerEquityPercent: workflow.offerEquityPercent,
      offerNotes: workflow.offerNotes,
      offerSentAt: workflow.offerSentAt,
      offerAcceptedAt: workflow.offerAcceptedAt,
      vestingMonths: workflow.vestingMonths,
      vestingCliffMonths: workflow.vestingCliffMonths,
      incorporated: workflow.incorporated,
      incorporationPartner: workflow.incorporationPartner,
      approvedForLawFirm: workflow.approvedForLawFirm,
      equityCommitmentSignedAt: workflow.equityCommitmentSignedAt,
      entityName: workflow.entityName,
      entityType: workflow.entityType,
      entityState: workflow.entityState,
      ein: workflow.ein,
      articlesOfIncorporationUrl: workflow.articlesOfIncorporationUrl,
      authorizedShares: workflow.authorizedShares,
      sharePrice: workflow.sharePrice,
      entityInfoReceivedAt: workflow.entityInfoReceivedAt,
      agreementSentAt: workflow.agreementSentAt,
      founderSignedAt: workflow.founderSignedAt,
      adminSignedAt: workflow.adminSignedAt,
      equityAgreementReceivedAt: workflow.equityAgreementReceivedAt,
      equityAgreementUrl: workflow.equityAgreementUrl,
      equityFounderSignedAt: workflow.equityFounderSignedAt,
      equityAdminSignedAt: workflow.equityAdminSignedAt,
      equityAgreementSignedAt: workflow.equityAgreementSignedAt,
      wireInfoUrl: workflow.wireInfoUrl,
      sharePurchaseDate: workflow.sharePurchaseDate,
      election83bFiledAt: workflow.election83bFiledAt,
      certificateReceivedAt: workflow.certificateReceivedAt,
      certificateUrl: workflow.certificateUrl,
      boardApprovalRequestedAt: workflow.boardApprovalRequestedAt,
      boardApprovedAt: workflow.boardApprovedAt,
      createdAt: workflow.createdAt,
      updatedAt: workflow.updatedAt,
    },
    shareDetails,
    nextAction,
    boardMembers: (workflow.boardMembers || []).map(m => ({
      id: m.id,
      name: m.name,
      email: m.email,
      title: m.title,
      approvedAt: m.approvedAt,
      // Founder can approve on behalf of any board member in their workflow
      canApprove: !m.approvedAt,
    })),
    events: workflow.events.slice(0, 10), // Last 10 events
  });
});

// Accept the offer
app.post('/onboarding/accept-offer', async (c) => {
  const founderId = c.get('founderId') as number;

  const founder = await db.query.founders.findFirst({
    where: eq(founders.id, founderId),
  });

  if (!founder) {
    return c.json({ error: 'Founder not found' }, 404);
  }

  const portfolioCompany = await db.query.portfolioCompanies.findFirst({
    where: eq(portfolioCompanies.founderId, founderId),
  });

  if (!portfolioCompany) {
    return c.json({ error: 'Not a portfolio company' }, 400);
  }

  const workflow = await db.query.onboardingWorkflows.findFirst({
    where: eq(onboardingWorkflows.portfolioCompanyId, portfolioCompany.id),
  });

  if (!workflow) {
    return c.json({ error: 'No onboarding workflow found' }, 404);
  }

  if (workflow.status !== OnboardingStatus.OFFER_PENDING) {
    return c.json({ error: `Cannot accept offer in status: ${workflow.status}` }, 400);
  }

  const now = new Date().toISOString();

  await db.update(onboardingWorkflows)
    .set({
      status: OnboardingStatus.OFFER_ACCEPTED,
      offerAcceptedAt: now,
      updatedAt: now,
    })
    .where(eq(onboardingWorkflows.id, workflow.id));

  await logOnboardingEvent(workflow.id, OnboardingEventType.OFFER_ACCEPTED, founder.email);

  return c.json({ success: true, message: 'Offer accepted! Next: tell us about your incorporation status.' });
});

// Answer incorporation question
app.post('/onboarding/incorporation-answer', async (c) => {
  const founderId = c.get('founderId') as number;
  const body = await c.req.json();

  const schema = z.object({
    incorporated: z.boolean(),
    path: z.enum(['partner', 'side_project']).optional(),
    incorporationPartner: z.string().optional(),
  });

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues }, 400);
  }

  const founder = await db.query.founders.findFirst({
    where: eq(founders.id, founderId),
  });
  if (!founder) return c.json({ error: 'Founder not found' }, 404);

  const portfolioCompany = await db.query.portfolioCompanies.findFirst({
    where: eq(portfolioCompanies.founderId, founderId),
  });
  if (!portfolioCompany) return c.json({ error: 'Not a portfolio company' }, 400);

  const workflow = await db.query.onboardingWorkflows.findFirst({
    where: eq(onboardingWorkflows.portfolioCompanyId, portfolioCompany.id),
  });
  if (!workflow) return c.json({ error: 'No onboarding workflow found' }, 404);

  if (workflow.status !== OnboardingStatus.OFFER_ACCEPTED) {
    return c.json({ error: `Cannot answer incorporation in status: ${workflow.status}` }, 400);
  }

  const now = new Date().toISOString();
  const { incorporated, path, incorporationPartner } = parsed.data;

  if (incorporated) {
    // Already incorporated → go straight to entity info
    await db.update(onboardingWorkflows)
      .set({
        status: OnboardingStatus.ENTITY_INFO_PENDING,
        incorporated: true,
        updatedAt: now,
      })
      .where(eq(onboardingWorkflows.id, workflow.id));

    await logOnboardingEvent(workflow.id, OnboardingEventType.INCORPORATION_ANSWERED, founder.email, { incorporated: true });

    await onboardingEmails.sendEntityInfoRequestEmail({
      name: founder.name,
      email: founder.email,
      companyName: founder.companyName,
    });

    return c.json({ success: true, message: 'Great! Please submit your company details.' });
  }

  if (path === 'side_project') {
    // Side project → still needs equity commitment before light engagement
    await db.update(onboardingWorkflows)
      .set({
        incorporated: false,
        updatedAt: now,
      })
      .where(eq(onboardingWorkflows.id, workflow.id));

    await logOnboardingEvent(workflow.id, OnboardingEventType.INCORPORATION_ANSWERED, founder.email, { incorporated: false, path: 'side_project' });

    return c.json({ success: true, message: 'Next: sign the pre-incorporation equity commitment.' });
  }

  if (path === 'partner') {
    // Validate partner selection
    if (!incorporationPartner) {
      return c.json({ error: 'Please select an incorporation partner' }, 400);
    }

    // Validate Goodwin is only available if approved
    if (incorporationPartner === 'goodwin' && !workflow.approvedForLawFirm) {
      return c.json({ error: 'Goodwin is not available for this workflow' }, 400);
    }

    // Partner path → stay in OFFER_ACCEPTED, need equity commitment next
    await db.update(onboardingWorkflows)
      .set({
        incorporated: false,
        incorporationPartner,
        updatedAt: now,
      })
      .where(eq(onboardingWorkflows.id, workflow.id));

    await logOnboardingEvent(workflow.id, OnboardingEventType.INCORPORATION_ANSWERED, founder.email, { incorporated: false, path: 'partner', partner: incorporationPartner });

    return c.json({ success: true, message: 'Next: sign the pre-incorporation equity commitment.' });
  }

  return c.json({ error: 'If not incorporated, please specify path (partner or side_project)' }, 400);
});

// Sign equity commitment (pre-incorporation)
app.post('/onboarding/equity-commitment', async (c) => {
  const founderId = c.get('founderId') as number;
  const body = await c.req.json();

  const schema = z.object({
    founderName: z.string().min(1),
    acknowledged: z.literal(true),
  });

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues }, 400);
  }

  const founder = await db.query.founders.findFirst({
    where: eq(founders.id, founderId),
  });
  if (!founder) return c.json({ error: 'Founder not found' }, 404);

  const portfolioCompany = await db.query.portfolioCompanies.findFirst({
    where: eq(portfolioCompanies.founderId, founderId),
  });
  if (!portfolioCompany) return c.json({ error: 'Not a portfolio company' }, 400);

  const workflow = await db.query.onboardingWorkflows.findFirst({
    where: eq(onboardingWorkflows.portfolioCompanyId, portfolioCompany.id),
  });
  if (!workflow) return c.json({ error: 'No onboarding workflow found' }, 404);

  if ((workflow.status !== OnboardingStatus.OFFER_ACCEPTED && workflow.status !== OnboardingStatus.LIGHT_ENGAGEMENT) || workflow.incorporated !== false) {
    return c.json({ error: 'Cannot sign equity commitment in current state' }, 400);
  }

  const now = new Date().toISOString();

  // Side projects go to light engagement, partner path goes to pending incorporation
  const nextStatus = workflow.incorporationPartner
    ? OnboardingStatus.PENDING_INCORPORATION
    : OnboardingStatus.LIGHT_ENGAGEMENT;

  await db.update(onboardingWorkflows)
    .set({
      status: nextStatus,
      equityCommitmentSignedAt: now,
      updatedAt: now,
    })
    .where(eq(onboardingWorkflows.id, workflow.id));

  await logOnboardingEvent(workflow.id, OnboardingEventType.EQUITY_COMMITMENT_SIGNED, founder.email, {
    founderName: parsed.data.founderName,
    partner: workflow.incorporationPartner || 'side_project',
  });

  await onboardingEmails.sendEquityCommitmentConfirmationEmail({
    name: founder.name,
    email: founder.email,
    companyName: founder.companyName,
  }, workflow.incorporationPartner || 'none');

  if (!workflow.incorporationPartner) {
    // Side project: also send light engagement email
    await onboardingEmails.sendLightEngagementConfirmationEmail({
      name: founder.name,
      email: founder.email,
      companyName: founder.companyName,
    });
  }

  return c.json({ success: true, message: 'Commitment signed! We\'ll follow up once you\'re incorporated.' });
});

// Confirm incorporation (from pending_incorporation or light_engagement)
app.post('/onboarding/confirm-incorporation', async (c) => {
  const founderId = c.get('founderId') as number;

  const founder = await db.query.founders.findFirst({
    where: eq(founders.id, founderId),
  });
  if (!founder) return c.json({ error: 'Founder not found' }, 404);

  const portfolioCompany = await db.query.portfolioCompanies.findFirst({
    where: eq(portfolioCompanies.founderId, founderId),
  });
  if (!portfolioCompany) return c.json({ error: 'Not a portfolio company' }, 400);

  const workflow = await db.query.onboardingWorkflows.findFirst({
    where: eq(onboardingWorkflows.portfolioCompanyId, portfolioCompany.id),
  });
  if (!workflow) return c.json({ error: 'No onboarding workflow found' }, 404);

  if (workflow.status !== OnboardingStatus.PENDING_INCORPORATION && workflow.status !== OnboardingStatus.LIGHT_ENGAGEMENT) {
    return c.json({ error: `Cannot confirm incorporation in status: ${workflow.status}` }, 400);
  }

  const now = new Date().toISOString();

  await db.update(onboardingWorkflows)
    .set({
      status: OnboardingStatus.ENTITY_INFO_PENDING,
      incorporated: true,
      updatedAt: now,
    })
    .where(eq(onboardingWorkflows.id, workflow.id));

  await logOnboardingEvent(workflow.id, OnboardingEventType.INCORPORATION_CONFIRMED, founder.email);

  await onboardingEmails.sendEntityInfoRequestEmail({
    name: founder.name,
    email: founder.email,
    companyName: founder.companyName,
  });

  return c.json({ success: true, message: 'Congratulations on incorporating! Please submit your company details.' });
});

// Submit entity info
app.post('/onboarding/entity-info', async (c) => {
  const founderId = c.get('founderId') as number;
  const body = await c.req.json();

  const schema = z.object({
    entityName: z.string().min(1),
    entityType: z.enum(['llc', 'c_corp', 's_corp', 'partnership', 'sole_prop', 'other']),
    entityState: z.string().min(2).max(2), // State code
    ein: z.string().min(1, 'EIN is required'),
    articlesOfIncorporationUrl: z.string().min(1, 'Articles of incorporation are required'),
    authorizedShares: z.number().positive(),
    sharePrice: z.string().optional(), // Defaults to 0.0001 if not provided
    founderTitle: z.string().optional(), // Defaults to 'Founder & CEO' if not provided
    boardMembers: z.array(z.object({
      name: z.string().min(1),
      email: z.string().email(),
      title: z.string().optional(),
    })).min(1, 'At least one board member is required'),
  });

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues }, 400);
  }

  const founder = await db.query.founders.findFirst({
    where: eq(founders.id, founderId),
  });

  if (!founder) {
    return c.json({ error: 'Founder not found' }, 404);
  }

  const portfolioCompany = await db.query.portfolioCompanies.findFirst({
    where: eq(portfolioCompanies.founderId, founderId),
  });

  if (!portfolioCompany) {
    return c.json({ error: 'Not a portfolio company' }, 400);
  }

  const workflow = await db.query.onboardingWorkflows.findFirst({
    where: eq(onboardingWorkflows.portfolioCompanyId, portfolioCompany.id),
  });

  if (!workflow) {
    return c.json({ error: 'No onboarding workflow found' }, 404);
  }

  if (workflow.status !== OnboardingStatus.OFFER_ACCEPTED &&
      workflow.status !== OnboardingStatus.ENTITY_INFO_PENDING) {
    return c.json({ error: `Cannot submit entity info in status: ${workflow.status}` }, 400);
  }

  const now = new Date().toISOString();

  const sharePrice = parsed.data.sharePrice || '0.0001';
  const founderTitle = parsed.data.founderTitle || 'Founder & CEO';

  await db.update(onboardingWorkflows)
    .set({
      status: OnboardingStatus.ENTITY_INFO_RECEIVED,
      entityName: parsed.data.entityName,
      entityType: parsed.data.entityType,
      entityState: parsed.data.entityState,
      ein: parsed.data.ein,
      articlesOfIncorporationUrl: parsed.data.articlesOfIncorporationUrl,
      authorizedShares: parsed.data.authorizedShares,
      sharePrice,
      founderTitle,
      entityInfoReceivedAt: now,
      updatedAt: now,
    })
    .where(eq(onboardingWorkflows.id, workflow.id));

  // Save board members
  for (const member of parsed.data.boardMembers) {
    await db.insert(boardMembers).values({
      workflowId: workflow.id,
      name: member.name,
      email: member.email,
      title: member.title || null,
      isFounder: member.email.toLowerCase() === founder.email.toLowerCase(),
      createdAt: now,
    });
  }

  await logOnboardingEvent(workflow.id, OnboardingEventType.ENTITY_INFO_SUBMITTED, founder.email, {
    entityName: parsed.data.entityName,
    entityType: parsed.data.entityType,
    authorizedShares: parsed.data.authorizedShares,
    boardMemberCount: parsed.data.boardMembers.length,
  });

  // Auto-send advisory agreement via Dropbox Sign template
  let agreementSent = false;
  if (esign.isConfigured()) {
    try {
      // Calculate share count
      const equityPercent = parseFloat(workflow.offerEquityPercent || '0');
      const shareCount = Math.round(parsed.data.authorizedShares * (equityPercent / 100));

      // Use the Dropbox Sign template with merge fields
      const result = await esign.createSignatureRequest(
        {
          company_name: parsed.data.entityName,
          effective_date: now.split('T')[0],
          share_count: shareCount.toLocaleString(),
          founder_name: founder.name,
          founder_title: founderTitle,
          founder_email: founder.email,
          equity_percent: workflow.offerEquityPercent || '',
        },
        [
          { name: founder.name, email: founder.email, role: 'Founder' },
          { name: 'Mat Sherman', email: 'mat@matsherman.com', role: 'Advisor' },
        ]
      );

      // Update workflow with signature request info
      await db.update(onboardingWorkflows)
        .set({
          status: OnboardingStatus.ADVISORY_AGREEMENT_SENT,
          esignDocumentId: result.documentId,
          esignSignatureRequestId: result.signatureRequestId,
          agreementSentAt: now,
          updatedAt: now,
        })
        .where(eq(onboardingWorkflows.id, workflow.id));

      await logOnboardingEvent(workflow.id, OnboardingEventType.ADVISORY_AGREEMENT_CREATED, 'system', {
        signatureRequestId: result.signatureRequestId,
      });

      agreementSent = true;
      console.log(`✅ Advisory agreement auto-sent for ${founder.companyName}`);
    } catch (err: any) {
      console.error('Failed to auto-send advisory agreement:', err);
      // Continue anyway - admin can manually send
    }
  }

  // Notify admin
  await onboardingEmails.notifyAdminEntityInfoReceived(
    'mat@matsherman.com',
    { name: founder.name, email: founder.email, companyName: founder.companyName },
    {
      entityName: parsed.data.entityName,
      entityType: parsed.data.entityType,
      authorizedShares: parsed.data.authorizedShares,
    }
  );

  return c.json({
    success: true,
    message: agreementSent
      ? 'Company details received! The advisory agreement has been sent to your email for signature.'
      : 'Company details received! We will prepare the advisory agreement.',
  });
});

// Board member approval
app.post('/onboarding/board-approve', async (c) => {
  const founderId = c.get('founderId') as number;
  const body = await c.req.json();

  const schema = z.object({
    boardMemberId: z.number(),
  });

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues }, 400);
  }

  const founder = await db.query.founders.findFirst({
    where: eq(founders.id, founderId),
  });

  if (!founder) {
    return c.json({ error: 'Founder not found' }, 404);
  }

  // Find the board member
  const member = await db.query.boardMembers.findFirst({
    where: eq(boardMembers.id, parsed.data.boardMemberId),
    with: { workflow: true },
  });

  if (!member) {
    return c.json({ error: 'Board member not found' }, 404);
  }

  if (member.approvedAt) {
    return c.json({ error: 'Already approved' }, 400);
  }

  const now = new Date().toISOString();

  // Record the approval
  await db.update(boardMembers)
    .set({ approvedAt: now })
    .where(eq(boardMembers.id, member.id));

  await logOnboardingEvent(member.workflowId, OnboardingEventType.BOARD_MEMBER_APPROVED, founder.email, {
    boardMemberName: member.name,
    boardMemberEmail: member.email,
  });

  // Check if all board members have approved
  const allMembers = await db.query.boardMembers.findMany({
    where: eq(boardMembers.workflowId, member.workflowId),
  });

  const allApproved = allMembers.every(m => m.id === member.id ? true : !!m.approvedAt);

  if (allApproved) {
    // All board members approved - advance workflow
    await db.update(onboardingWorkflows)
      .set({
        status: OnboardingStatus.BOARD_APPROVED,
        boardApprovedAt: now,
        updatedAt: now,
      })
      .where(eq(onboardingWorkflows.id, member.workflowId));

    await logOnboardingEvent(member.workflowId, OnboardingEventType.BOARD_APPROVAL_COMPLETE, 'system', {
      totalMembers: allMembers.length,
    });

    // Auto-send stock agreement via Dropbox Sign
    const workflow = await db.query.onboardingWorkflows.findFirst({
      where: eq(onboardingWorkflows.id, member.workflowId),
      with: { portfolioCompany: { with: { founder: true } } },
    });

    if (workflow && esign.isConfigured()) {
      const wFounder = workflow.portfolioCompany.founder;
      const shareCount = workflow.authorizedShares && workflow.offerEquityPercent
        ? Math.round(workflow.authorizedShares * (parseFloat(workflow.offerEquityPercent) / 100))
        : 0;
      const totalAmount = (shareCount * parseFloat(workflow.sharePrice || '0.0001')).toFixed(2);

      try {
        const stockResult = await esign.createStockAgreementRequest(
          {
            company_name: workflow.entityName || wFounder.companyName,
            entity_state: workflow.entityState || 'DE',
            effective_date: now.split('T')[0],
            share_count: shareCount.toLocaleString(),
            price_per_share: '$' + (workflow.sharePrice || '0.0001'),
            total_purchase_price: '$' + totalAmount,
            founder_name: wFounder.name,
            founder_title: workflow.founderTitle || 'Founder & CEO',
            founder_email: wFounder.email,
          },
          [
            { name: wFounder.name, email: wFounder.email, role: 'Founder' },
            { name: 'Mat Sherman', email: 'mat@matsherman.com', role: 'Advisor' },
          ]
        );

        await db.update(onboardingWorkflows)
          .set({
            status: OnboardingStatus.EQUITY_AGREEMENT_PENDING,
            equityAgreementUrl: stockResult.signatureRequestId,
            equityAgreementReceivedAt: now,
            updatedAt: now,
          })
          .where(eq(onboardingWorkflows.id, member.workflowId));

        await logOnboardingEvent(member.workflowId, OnboardingEventType.EQUITY_AGREEMENT_UPLOADED, 'system', {
          signatureRequestId: stockResult.signatureRequestId,
          shareCount,
          totalAmount,
        });

        console.log(`Stock agreement auto-sent for ${wFounder.companyName}`);
      } catch (err: any) {
        console.error('Failed to auto-send stock agreement:', err);
        // Fall back - send email asking founder
        await onboardingEmails.sendEquityAgreementRequestEmail(
          { name: wFounder.name, email: wFounder.email, companyName: wFounder.companyName },
          {
            equityPercent: workflow.offerEquityPercent || '',
            sharePrice: workflow.sharePrice || '0.0001',
            shareCount,
            totalAmount,
            grantDate: now.split('T')[0],
          }
        );
        await db.update(onboardingWorkflows)
          .set({ status: OnboardingStatus.EQUITY_AGREEMENT_PENDING, updatedAt: now })
          .where(eq(onboardingWorkflows.id, member.workflowId));
      }
    }

    console.log(`Board approval complete for workflow ${member.workflowId}`);
  }

  return c.json({
    success: true,
    allApproved,
    message: allApproved
      ? 'Board approval complete! Stock agreement has been sent for signature.'
      : 'Approval recorded. Waiting for remaining board members.',
  });
});

// Upload equity agreement
app.post('/onboarding/upload-equity-agreement', async (c) => {
  const founderId = c.get('founderId') as number;
  const body = await c.req.json();

  const schema = z.object({
    documentUrl: z.string().url(),
  });

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues }, 400);
  }

  const founder = await db.query.founders.findFirst({
    where: eq(founders.id, founderId),
  });

  if (!founder) {
    return c.json({ error: 'Founder not found' }, 404);
  }

  const portfolioCompany = await db.query.portfolioCompanies.findFirst({
    where: eq(portfolioCompanies.founderId, founderId),
  });

  if (!portfolioCompany) {
    return c.json({ error: 'Not a portfolio company' }, 400);
  }

  const workflow = await db.query.onboardingWorkflows.findFirst({
    where: eq(onboardingWorkflows.portfolioCompanyId, portfolioCompany.id),
  });

  if (!workflow) {
    return c.json({ error: 'No onboarding workflow found' }, 404);
  }

  // Can upload after board approval or advisory signed
  const allowedStatuses = [
    OnboardingStatus.FOUNDER_SIGNED,
    OnboardingStatus.BOARD_APPROVED,
    OnboardingStatus.EQUITY_AGREEMENT_PENDING,
  ];
  if (!allowedStatuses.includes(workflow.status as any)) {
    return c.json({ error: `Cannot upload equity agreement in status: ${workflow.status}` }, 400);
  }

  const now = new Date().toISOString();

  await db.update(onboardingWorkflows)
    .set({
      status: OnboardingStatus.EQUITY_AGREEMENT_PENDING,
      equityAgreementUrl: parsed.data.documentUrl,
      equityAgreementReceivedAt: now,
      updatedAt: now,
    })
    .where(eq(onboardingWorkflows.id, workflow.id));

  await logOnboardingEvent(workflow.id, OnboardingEventType.EQUITY_AGREEMENT_UPLOADED, founder.email, {
    documentUrl: parsed.data.documentUrl,
  });

  // Notify admin
  const adminEmail = process.env.ADMIN_EMAIL || 'mat@matsherman.com';
  await onboardingEmails.notifyAdminEquityAgreementUploaded(adminEmail, {
    name: founder.name,
    email: founder.email,
    companyName: founder.companyName,
  });

  return c.json({
    success: true,
    message: 'Equity agreement uploaded! We will review and sign it.'
  });
});

// Upload wire info
app.post('/onboarding/upload-wire-info', async (c) => {
  const founderId = c.get('founderId') as number;
  const body = await c.req.json();

  const schema = z.object({
    documentUrl: z.string().url(),
  });

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues }, 400);
  }

  const founder = await db.query.founders.findFirst({
    where: eq(founders.id, founderId),
  });

  if (!founder) {
    return c.json({ error: 'Founder not found' }, 404);
  }

  const portfolioCompany = await db.query.portfolioCompanies.findFirst({
    where: eq(portfolioCompanies.founderId, founderId),
  });

  if (!portfolioCompany) {
    return c.json({ error: 'Not a portfolio company' }, 400);
  }

  const workflow = await db.query.onboardingWorkflows.findFirst({
    where: eq(onboardingWorkflows.portfolioCompanyId, portfolioCompany.id),
  });

  if (!workflow) {
    return c.json({ error: 'No onboarding workflow found' }, 404);
  }

  if (workflow.status !== OnboardingStatus.WIRE_INFO_PENDING &&
      workflow.status !== OnboardingStatus.EQUITY_AGREEMENT_SIGNED) {
    return c.json({ error: `Cannot submit wire info in status: ${workflow.status}` }, 400);
  }

  const now = new Date().toISOString();

  await db.update(onboardingWorkflows)
    .set({
      wireInfoUrl: parsed.data.documentUrl,
      updatedAt: now,
    })
    .where(eq(onboardingWorkflows.id, workflow.id));

  await logOnboardingEvent(workflow.id, OnboardingEventType.WIRE_INFO_SUBMITTED, founder.email, {
    documentUrl: parsed.data.documentUrl,
  });

  // Notify admin
  const adminEmail = process.env.ADMIN_EMAIL || 'mat@matsherman.com';
  await onboardingEmails.notifyAdminWireInfoReceived(adminEmail, {
    name: founder.name,
    email: founder.email,
    companyName: founder.companyName,
  });

  return c.json({
    success: true,
    message: 'Wire info uploaded! Mat will purchase the shares shortly.',
  });
});

// Upload certificate
app.post('/onboarding/upload-certificate', async (c) => {
  const founderId = c.get('founderId') as number;
  const body = await c.req.json();

  const schema = z.object({
    documentUrl: z.string().url(),
    certificateNumber: z.string().optional(),
  });

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues }, 400);
  }

  const founder = await db.query.founders.findFirst({
    where: eq(founders.id, founderId),
  });

  if (!founder) {
    return c.json({ error: 'Founder not found' }, 404);
  }

  const portfolioCompany = await db.query.portfolioCompanies.findFirst({
    where: eq(portfolioCompanies.founderId, founderId),
  });

  if (!portfolioCompany) {
    return c.json({ error: 'Not a portfolio company' }, 400);
  }

  const workflow = await db.query.onboardingWorkflows.findFirst({
    where: eq(onboardingWorkflows.portfolioCompanyId, portfolioCompany.id),
  });

  if (!workflow) {
    return c.json({ error: 'No onboarding workflow found' }, 404);
  }

  if (workflow.status !== OnboardingStatus.CERTIFICATE_PENDING) {
    return c.json({ error: `Cannot upload certificate in status: ${workflow.status}` }, 400);
  }

  const now = new Date().toISOString();

  await db.update(onboardingWorkflows)
    .set({
      certificateUrl: parsed.data.documentUrl,
      certificateNumber: parsed.data.certificateNumber,
      certificateReceivedAt: now,
      updatedAt: now,
    })
    .where(eq(onboardingWorkflows.id, workflow.id));

  await logOnboardingEvent(workflow.id, OnboardingEventType.CERTIFICATE_UPLOADED, founder.email, {
    documentUrl: parsed.data.documentUrl,
    certificateNumber: parsed.data.certificateNumber,
  });

  // Notify admin
  const adminEmail = process.env.ADMIN_EMAIL || 'mat@matsherman.com';
  await onboardingEmails.notifyAdminCertificateUploaded(adminEmail, {
    name: founder.name,
    email: founder.email,
    companyName: founder.companyName,
  });

  return c.json({
    success: true,
    message: 'Certificate uploaded! We will verify and complete the onboarding.'
  });
});

export default app;
