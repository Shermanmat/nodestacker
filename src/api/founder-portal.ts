import { Hono } from 'hono';
import { eq, and, inArray, notInArray, desc, sql, isNull } from 'drizzle-orm';
import { db, founders, nodes, investors, founderNodeRelationships, nodeInvestorConnections, introRequests, followupLogs, investorResearch, portfolioCompanies, onboardingWorkflows, onboardingEvents, boardMembers, commsChangeRequests, mcpTokens, founderInvestorRecords, OnboardingStatus, OnboardingEventType, OnboardingActor } from '../db/index.js';
import { getSessionFounderId } from './auth.js';
import { sendEmail } from '../services/email.js';
import crypto from 'crypto';
import { z } from 'zod';
import * as onboardingEmails from '../services/onboarding-emails.js';
import * as esign from '../services/esign.js';
import { checkFirmBlocked } from '../services/matching.js';
import { getTreadmillReading } from '../services/treadmill.js';
import * as drive from '../services/google-drive.js';
import { extractFormationDocuments } from '../services/document-extraction.js';

type Variables = {
  founderId: number;
};

const app = new Hono<{ Variables: Variables }>();

// Auth middleware
app.use('*', async (c, next) => {
  const sessionId = c.req.header('X-Session-Id');
  const founderId = await getSessionFounderId(sessionId);

  if (!founderId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  c.set('founderId', founderId);
  await next();
});

// ── Investor comms: the production blurb + deck, with founder change-requests ──
// Founders view the LIVE assets and file change requests; nothing goes live until
// the admin approves. Deck uploads are staged as proposed_<token>.pdf.
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || process.env.POSTMARK_FROM_EMAIL || 'mat@matsherman.com';
const APP_BASE_URL = process.env.BASE_URL || 'https://matcap.vc';
function decksDirPath() {
  // mirrors src/api/founders.ts deck storage
  return (process.env.DATA_DIR || (process.env.NODE_ENV === 'production' ? '/app/data' : '.')) + '/decks';
}

app.get('/comms', async (c) => {
  const founderId = c.get('founderId') as number;
  const founder = await db.query.founders.findFirst({ where: eq(founders.id, founderId) });
  if (!founder) return c.json({ error: 'Founder not found' }, 404);
  const pending = await db.query.commsChangeRequests.findMany({
    where: and(eq(commsChangeRequests.founderId, founderId), eq(commsChangeRequests.status, 'pending')),
    orderBy: [desc(commsChangeRequests.createdAt)],
  });
  return c.json({
    blurb: founder.blurb || '',
    deckFile: founder.deckFile || null,
    deckUrl: founder.deckUrl || null,
    deckServePath: founder.deckFile ? `/decks/${founder.deckFile}` : null,
    pending: pending.map((r) => ({ id: r.id, kind: r.kind, note: r.note, createdAt: r.createdAt })),
  });
});

// ── First-run setup checklist ──────────────────────────────────────────────
// Computed (not stored) from the founder's actual data, so it can never drift
// out of sync. Drives the "get set up" card on the portal's overview tab; the
// card hides itself once every item is done.
app.get('/checklist', async (c) => {
  const founderId = c.get('founderId') as number;
  const founder = await db.query.founders.findFirst({ where: eq(founders.id, founderId) });
  if (!founder) return c.json({ error: 'Founder not found' }, 404);

  const [mcpTok, firstInvestor] = await Promise.all([
    // An active (non-revoked) MCP token means they've connected an AI client.
    db.query.mcpTokens.findFirst({
      where: and(eq(mcpTokens.founderId, founderId), isNull(mcpTokens.revokedAt)),
    }),
    // At least one non-archived investor in their private CRM.
    db.query.founderInvestorRecords.findFirst({
      where: and(eq(founderInvestorRecords.founderId, founderId), isNull(founderInvestorRecords.archivedAt)),
    }),
  ]);

  const items = [
    { key: 'blurb', label: 'Write your investor blurb', hint: 'The one-paragraph intro we send on your behalf.', tab: 'comms', cta: 'Add blurb', done: !!founder.blurb?.trim() },
    { key: 'deck', label: 'Upload your pitch deck', hint: 'Attached to your intros so investors can dig in.', tab: 'comms', cta: 'Upload deck', done: !!(founder.deckFile || founder.deckUrl) },
    { key: 'connect', label: 'Connect your AI assistant', hint: 'Log calls and manage your pipeline from your AI client.', tab: 'connect', cta: 'Connect', done: !!mcpTok },
    { key: 'investors', label: 'Add your first investors', hint: 'Track everyone you’re talking to in one place.', tab: 'pipeline', cta: 'Add investors', done: !!firstInvestor },
  ];
  const completed = items.filter((i) => i.done).length;
  return c.json({ items, completed, total: items.length, complete: completed === items.length });
});

// ── Treadmill: the founder's weekly intro-request allowance + how to grow it ──
// v1: the belt speeds up when they complete a gym session. Read-only.
app.get('/treadmill', async (c) => {
  const founderId = c.get('founderId') as number;
  return c.json(await getTreadmillReading(founderId));
});

app.post('/comms/blurb-request', async (c) => {
  const founderId = c.get('founderId') as number;
  const body = await c.req.json().catch(() => ({} as any));
  const note = typeof body.note === 'string' ? body.note.trim() : '';
  if (note.length < 3) return c.json({ error: 'Add a note describing the change' }, 400);
  const founder = await db.query.founders.findFirst({ where: eq(founders.id, founderId) });
  const approveToken = crypto.randomBytes(24).toString('hex');
  const [row] = await db.insert(commsChangeRequests).values({
    founderId, kind: 'blurb', note, approveToken, status: 'pending', createdAt: new Date().toISOString(),
  }).returning();
  const approveLink = `${APP_BASE_URL}/comms/approve/${approveToken}`;
  sendEmail({
    to: ADMIN_EMAIL,
    subject: `Blurb change request — ${founder?.name || 'founder #' + founderId}`,
    html: `<p><b>${founder?.name || 'Founder #' + founderId}</b> (${founder?.companyName || ''}) requested a blurb change:</p><blockquote>${note.replace(/</g, '&lt;')}</blockquote><p>After you update the blurb, <a href="${approveLink}">mark this handled</a> (clears their "pending" badge).</p>`,
    text: `${founder?.name || 'Founder #' + founderId} (${founder?.companyName || ''}) requested a blurb change:\n\n${note}\n\nAfter you update the blurb, mark it handled: ${approveLink}`,
  }).catch((e) => console.error('[comms] blurb-request email failed:', e));
  return c.json({ success: true, id: row.id });
});

app.post('/comms/deck-request', async (c) => {
  const founderId = c.get('founderId') as number;
  const founder = await db.query.founders.findFirst({ where: eq(founders.id, founderId) });
  if (!founder) return c.json({ error: 'Founder not found' }, 404);

  const body = await c.req.parseBody();
  const file = body.file as unknown as File | undefined;
  const note = typeof body.note === 'string' ? body.note : '';
  if (!file || typeof (file as any).arrayBuffer !== 'function') return c.json({ error: 'No file uploaded' }, 400);
  if (file.size > 30 * 1024 * 1024) return c.json({ error: 'File too large (max 30 MB)' }, 413);
  const mime = (file as any).type || '';
  if (!mime.includes('pdf') && !file.name.toLowerCase().endsWith('.pdf')) return c.json({ error: 'Only PDF files are supported' }, 400);

  const fs = await import('fs/promises');
  const path = await import('path');
  const crypto = await import('crypto');
  const decksDir = decksDirPath();
  await fs.mkdir(decksDir, { recursive: true });
  const filename = `proposed_${crypto.randomBytes(16).toString('hex')}.pdf`;
  await fs.writeFile(path.join(decksDir, filename), Buffer.from(await file.arrayBuffer()));

  const approveToken = crypto.randomBytes(24).toString('hex');
  const [row] = await db.insert(commsChangeRequests).values({
    founderId, kind: 'deck', note: note || null, proposedDeckFile: filename, approveToken, status: 'pending', createdAt: new Date().toISOString(),
  }).returning();
  const approveLink = `${APP_BASE_URL}/comms/approve/${approveToken}`;
  sendEmail({
    to: ADMIN_EMAIL,
    subject: `Deck change request — ${founder.name}`,
    html: `<p><b>${founder.name}</b> (${founder.companyName}) proposed a new deck.${note ? ' Note: ' + note.replace(/</g, '&lt;') : ''}</p><p><a href="${APP_BASE_URL}/decks/${filename}">View proposed deck (PDF)</a></p><p><a href="${approveLink}">✓ Approve &amp; make it live</a> — this replaces their current deck.</p>`,
    text: `${founder.name} (${founder.companyName}) proposed a new deck.${note ? ' Note: ' + note : ''}\nView proposed deck: ${APP_BASE_URL}/decks/${filename}\nApprove & make it live: ${approveLink}`,
  }).catch((e) => console.error('[comms] deck-request email failed:', e));
  return c.json({ success: true, id: row.id });
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
  const { notes, ...outcome } = parsed.data;

  // Build the update explicitly. The founder's free-text note goes to
  // `founderOwnedNotes` (their column), NOT the admin `notes` column — writing
  // there would silently overwrite whatever the admin has written on this intro.
  const updates: Record<string, unknown> = { ...outcome, updatedAt: now };
  if (notes !== undefined) updates.founderOwnedNotes = notes;

  const result = await db.update(introRequests)
    .set(updates)
    .where(eq(introRequests.id, introId))
    .returning();

  // When a founder reports a meeting actually happened, record a founder-completed
  // meeting_update followup log. This is what the treadmill counts toward the
  // "every 3 meetings → +1 bonus request" carrot — otherwise that loop is unearnable
  // (nothing else creates a completedBy:'founder' log from the portal). Guarded on a
  // real status transition so resubmitting the same outcome doesn't double-count.
  const reportsMeeting =
    outcome.status === 'first_meeting_complete' ||
    outcome.status === 'second_meeting_complete';
  if (reportsMeeting && outcome.status !== intro.status) {
    await db.insert(followupLogs).values({
      introRequestId: introId,
      followupType: 'meeting_update',
      completedBy: 'founder',
      completedAt: now,
      notes: notes ?? null,
    });
    await db.update(introRequests)
      .set({ lastFollowupDate: now.split('T')[0] })
      .where(eq(introRequests.id, introId));
  }

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

    // Determine if the founder has actually logged an update on this intro.
    // Use followup logs (a real founder action) rather than updatedAt, which is
    // bumped by any write — including an admin marking the intro 'introduced'.
    // Keying off updatedAt would wrongly treat that as "founder followed up" and
    // suppress the task for 14 days, so a just-introduced intro never surfaces.
    const lastFollowup = (intro.followupLogs || [])
      .map((l) => l.completedAt)
      .sort()
      .pop();

    // 3. If founder logged an update within the last 14 days, suppress
    if (lastFollowup && lastFollowup > fourteenDaysAgo) {
      continue;
    }

    // 4. If founder last logged 14+ days ago, show check-in
    if (lastFollowup) {
      tasks.push({
        type: 'check_in',
        priority: 'medium',
        intro,
        message: `Check in: Any update on ${intro.investor.name} @ ${intro.investor.firm}?`,
      });
      continue;
    }

    // 5. Founder hasn't logged anything yet - show task based on status.
    // Newly introduced intros surface immediately so the founder can confirm the
    // intro went out and log their meeting date, rather than searching it out.
    let message = '';
    switch (intro.status) {
      case 'introduced':
        message = `New intro to ${intro.investor.name} @ ${intro.investor.firm} - check your email and log the meeting`;
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
        nextAction = { type: 'accept_offer', message: 'Review and indicate your intent to join' };
      }
      break;
    case OnboardingStatus.OFFER_ACCEPTED:
      if (workflow.incorporated === null || workflow.incorporated === undefined) {
        nextAction = { type: 'incorporation_question', message: 'Is your company incorporated?' };
      } else if (workflow.incorporated === false && !workflow.equityCommitmentSignedAt) {
        nextAction = { type: 'equity_commitment', message: 'Sign the pre-incorporation equity commitment' };
      } else {
        nextAction = { type: 'upload_formation_docs', message: 'Upload your formation documents' };
      }
      break;
    case OnboardingStatus.DOCS_PENDING:
      nextAction = { type: 'upload_formation_docs', message: 'Upload your formation documents' };
      break;
    case OnboardingStatus.DOCS_EXTRACTED:
      // Once the 3 formation docs are in, the founder's next step is to book their
      // onboarding call with Mat — entity confirmation + the advisory agreement are
      // handled on/after that call. After they self-attest booking, show a friendly
      // "you're booked" state instead of nagging.
      if (workflow.onboardingCallBookedAt) {
        nextAction = { type: 'call_booked', message: "You're booked — Mat will finish your onboarding on the call." };
      } else {
        nextAction = { type: 'book_call', message: 'Finish onboarding — book your call with Mat', url: 'https://cal.com/matsherman/onboarding' };
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
      bylawsUrl: workflow.bylawsUrl,
      boardConsentUrl: workflow.boardConsentUrl,
      authorizedShares: workflow.authorizedShares,
      issuedShares: workflow.issuedShares,
      sharePrice: workflow.sharePrice,
      founderTitle: workflow.founderTitle,
      incorporationDate: workflow.incorporationDate,
      extractedAt: workflow.extractedAt,
      onboardingCallBookedAt: workflow.onboardingCallBookedAt,
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

// Founder self-attests that they booked their onboarding call with Mat (the step
// shown once the 3 formation docs are uploaded). Stamps a timestamp so the prompt
// stops nagging and admin can see who's booked. Idempotent; does not change status
// (Mat drives the rest of the flow from the call).
app.post('/onboarding/mark-call-booked', async (c) => {
  const founderId = c.get('founderId') as number;

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

  // Only meaningful at the post-docs step; no-op stamp is harmless otherwise.
  const now = new Date().toISOString();
  if (!workflow.onboardingCallBookedAt) {
    await db.update(onboardingWorkflows)
      .set({ onboardingCallBookedAt: now, updatedAt: now })
      .where(eq(onboardingWorkflows.id, workflow.id));
  }

  return c.json({ success: true, message: "Thanks — you're booked. Mat will finish your onboarding on the call." });
});

// Answer incorporation question
app.post('/onboarding/incorporation-answer', async (c) => {
  const founderId = c.get('founderId') as number;
  const body = await c.req.json();

  const schema = z.object({
    incorporated: z.boolean(),
    path: z.enum(['partner', 'side_project', 'docs_first']).optional(),
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
    // Docs-first track: founder has prior formation docs and will upload them
    // (AOC + bylaws + initial board consent) for us to extract variables from.
    if (path === 'docs_first') {
      await db.update(onboardingWorkflows)
        .set({
          status: OnboardingStatus.DOCS_PENDING,
          incorporated: true,
          intakeType: 'docs_first',
          updatedAt: now,
        })
        .where(eq(onboardingWorkflows.id, workflow.id));

      await logOnboardingEvent(workflow.id, OnboardingEventType.INCORPORATION_ANSWERED, founder.email, { incorporated: true, intakeType: 'docs_first' });

      return c.json({ success: true, docsFirst: true, message: 'Great! Upload your formation documents (Articles of Incorporation, bylaws, and initial board consent) and we\'ll fill in your company details automatically.' });
    }

    // Already incorporated → upload formation documents; we auto-fill the
    // company details from them.
    await db.update(onboardingWorkflows)
      .set({
        status: OnboardingStatus.DOCS_PENDING,
        incorporated: true,
        updatedAt: now,
      })
      .where(eq(onboardingWorkflows.id, workflow.id));

    await logOnboardingEvent(workflow.id, OnboardingEventType.INCORPORATION_ANSWERED, founder.email, { incorporated: true });

    // No email here — the founder is in the portal right now. A drop-off
    // reminder is sent by the docs-reminder sweep only if they haven't uploaded
    // within 10 minutes.

    return c.json({ success: true, message: 'Great! Upload your Articles of Incorporation, bylaws, and initial board consent — we\'ll fill in your company details automatically.' });
  }

  // Not incorporated — tell them to incorporate first and come back
  await db.update(onboardingWorkflows)
    .set({
      incorporated: false,
      updatedAt: now,
    })
    .where(eq(onboardingWorkflows.id, workflow.id));

  await logOnboardingEvent(workflow.id, OnboardingEventType.INCORPORATION_ANSWERED, founder.email, { incorporated: false });

  return c.json({
    success: true,
    notIncorporated: true,
    message: 'You\'ll need to incorporate before we can proceed. We recommend Stripe Atlas or Clerky to get started. Let us know once you\'re incorporated!',
  });
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
      status: OnboardingStatus.DOCS_PENDING,
      incorporated: true,
      updatedAt: now,
    })
    .where(eq(onboardingWorkflows.id, workflow.id));

  await logOnboardingEvent(workflow.id, OnboardingEventType.INCORPORATION_CONFIRMED, founder.email);

  // No email here — drop-off reminder is handled by the docs-reminder sweep.

  return c.json({ success: true, message: 'Congratulations on incorporating! Upload your Articles of Incorporation, bylaws, and initial board consent and we\'ll fill in your company details automatically.' });
});

// Upload the three formation documents (Articles of Incorporation, bylaws,
// initial board consent) and auto-extract the company details from them. All
// three are required. On success we store the PDFs to Drive, save the extracted
// fields + pre-fill board members, and move to DOCS_EXTRACTED for the founder to
// review and confirm.
const MISSING_DOCS_MSG =
  'We need all three formation documents — your Articles of Incorporation, bylaws, and initial board consent — to move forward. If you incorporated through Stripe Atlas or Clerky, all three are in your account.';

app.post('/onboarding/upload-formation-docs', async (c) => {
  const founderId = c.get('founderId') as number;
  const founder = await db.query.founders.findFirst({ where: eq(founders.id, founderId) });
  if (!founder) return c.json({ error: 'Founder not found' }, 404);
  const portfolioCompany = await db.query.portfolioCompanies.findFirst({
    where: eq(portfolioCompanies.founderId, founderId),
  });
  if (!portfolioCompany) return c.json({ error: 'Not a portfolio company' }, 400);
  const workflow = await db.query.onboardingWorkflows.findFirst({
    where: eq(onboardingWorkflows.portfolioCompanyId, portfolioCompany.id),
  });
  if (!workflow) return c.json({ error: 'No onboarding workflow found' }, 404);
  if (workflow.status !== OnboardingStatus.DOCS_PENDING &&
      workflow.status !== OnboardingStatus.DOCS_EXTRACTED &&
      workflow.status !== OnboardingStatus.ENTITY_INFO_PENDING) {
    return c.json({ error: `Cannot upload formation documents in status: ${workflow.status}` }, 400);
  }

  // Parse the multipart upload; all three files are required.
  const form = await c.req.parseBody();
  const asBuffer = async (v: unknown): Promise<Buffer | null> => {
    if (v && typeof (v as any).arrayBuffer === 'function') {
      return Buffer.from(await (v as any).arrayBuffer());
    }
    return null;
  };
  const [aoc, bylaws, boardConsent] = await Promise.all([
    asBuffer(form['aoc']), asBuffer(form['bylaws']), asBuffer(form['boardConsent']),
  ]);
  if (!aoc || !bylaws || !boardConsent) {
    return c.json({ error: MISSING_DOCS_MSG, missingDocs: true }, 400);
  }

  // Extract the company details from the three PDFs via Claude.
  let extracted;
  try {
    extracted = await extractFormationDocuments({ aoc, bylaws, boardConsent });
  } catch (err: any) {
    console.error('[onboarding] formation-doc extraction failed:', err?.message || err);
    return c.json({ error: 'We couldn\'t read those documents. Make sure each is a clear PDF and try again.' }, 502);
  }

  // Store the PDFs to the company's Drive folder (best-effort; extraction is the
  // thing that must succeed).
  const now = new Date().toISOString();
  let aocUrl: string | null = null, bylawsUrl: string | null = null, consentUrl: string | null = null;
  if (drive.isConfigured()) {
    try {
      let folderId = workflow.driveFolderId;
      if (!folderId) {
        const folder = await drive.createCompanyFolder(founder.companyName || `company-${founder.id}`);
        folderId = folder.id;
        await db.update(onboardingWorkflows).set({ driveFolderId: folder.id, driveFolderUrl: folder.webViewLink }).where(eq(onboardingWorkflows.id, workflow.id));
      }
      const safe = (founder.companyName || 'company').replace(/[^a-z0-9]+/gi, '-');
      const [f1, f2, f3] = await Promise.all([
        drive.uploadDocument(folderId, `${safe}-articles-of-incorporation.pdf`, aoc, 'application/pdf'),
        drive.uploadDocument(folderId, `${safe}-bylaws.pdf`, bylaws, 'application/pdf'),
        drive.uploadDocument(folderId, `${safe}-board-consent.pdf`, boardConsent, 'application/pdf'),
      ]);
      aocUrl = f1.webViewLink; bylawsUrl = f2.webViewLink; consentUrl = f3.webViewLink;
    } catch (err: any) {
      console.error('[onboarding] Drive upload of formation docs failed:', err?.message || err);
    }
  }

  // Save extracted fields + doc links on the workflow.
  await db.update(onboardingWorkflows).set({
    status: OnboardingStatus.DOCS_EXTRACTED,
    articlesOfIncorporationUrl: aocUrl ?? workflow.articlesOfIncorporationUrl,
    bylawsUrl: bylawsUrl ?? workflow.bylawsUrl,
    boardConsentUrl: consentUrl ?? workflow.boardConsentUrl,
    entityName: extracted.entityName ?? workflow.entityName,
    entityType: extracted.entityType ?? workflow.entityType,
    entityState: extracted.entityState ?? workflow.entityState,
    authorizedShares: extracted.authorizedShares ?? workflow.authorizedShares,
    issuedShares: extracted.issuedShares ?? workflow.issuedShares,
    sharePrice: extracted.parValue ?? workflow.sharePrice,
    incorporationDate: extracted.incorporationDate ?? workflow.incorporationDate,
    extractionRaw: JSON.stringify(extracted),
    extractedAt: now,
    intakeType: 'docs_first',
    updatedAt: now,
  }).where(eq(onboardingWorkflows.id, workflow.id));

  // Pre-fill board members from the extraction (founder edits/confirms next).
  await db.delete(boardMembers).where(eq(boardMembers.workflowId, workflow.id));
  for (const m of (extracted.boardMembers || [])) {
    if (!m.name) continue;
    await db.insert(boardMembers).values({
      workflowId: workflow.id,
      name: m.name,
      email: m.email || '',
      title: m.title || null,
      isFounder: (m.email || '').toLowerCase() === founder.email.toLowerCase(),
      createdAt: now,
    });
  }

  await logOnboardingEvent(workflow.id, OnboardingEventType.FORMATION_DOCS_EXTRACTED, founder.email, {
    entityName: extracted.entityName,
    authorizedShares: extracted.authorizedShares,
    boardMemberCount: (extracted.boardMembers || []).length,
    warnings: extracted.warnings || [],
  });

  // Route the extraction QA flags to the admin (not the founder) for review.
  try {
    const bm = (extracted.boardMembers || [])
      .map((m) => `  - ${m.name}${m.email ? ` <${m.email}>` : ''}${m.title ? ` (${m.title})` : ''}`)
      .join('\n') || '  (none found)';
    const warns = (extracted.warnings || []).map((w) => `  • ${w}`).join('\n') || '  (none)';
    const summary =
      `${founder.name} (${founder.companyName}) uploaded their formation documents. Extracted:\n\n` +
      `Entity: ${extracted.entityName || '—'}\n` +
      `Type / State: ${extracted.entityType || '—'} / ${extracted.entityState || '—'}\n` +
      `Authorized shares: ${extracted.authorizedShares ?? '—'}  ·  Par: ${extracted.parValue || '—'}\n` +
      `Incorporated: ${extracted.incorporationDate || '—'}\n\n` +
      `Board members:\n${bm}\n\n` +
      `Extraction flags to review:\n${warns}\n\n` +
      `The founder is reviewing and confirming these now.`;
    await sendEmail({
      to: ADMIN_EMAIL,
      subject: `📄 Formation docs extracted — ${founder.companyName}`,
      text: summary,
      html: `<pre style="font-family:ui-monospace,monospace;white-space:pre-wrap;font-size:13px">${summary.replace(/[<>&]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[ch] as string))}</pre>`,
    });
  } catch (e) {
    console.error('[onboarding] admin docs-extracted notify failed:', e);
  }

  return c.json({ success: true });
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
    // Optional here: in the docs-first flow the AoC link is already stored from
    // the formation-document upload; the confirm step doesn't re-ask for it.
    articlesOfIncorporationUrl: z.string().optional(),
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
      workflow.status !== OnboardingStatus.ENTITY_INFO_PENDING &&
      workflow.status !== OnboardingStatus.DOCS_EXTRACTED) {
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
      articlesOfIncorporationUrl: parsed.data.articlesOfIncorporationUrl || workflow.articlesOfIncorporationUrl,
      authorizedShares: parsed.data.authorizedShares,
      sharePrice,
      founderTitle,
      entityInfoReceivedAt: now,
      updatedAt: now,
    })
    .where(eq(onboardingWorkflows.id, workflow.id));

  // Save board members. Replace any rows pre-filled from the formation-doc
  // extraction so the founder's confirmed list is authoritative (no duplicates).
  await db.delete(boardMembers).where(eq(boardMembers.workflowId, workflow.id));
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
          vesting_months: String(workflow.vestingMonths ?? 48),
          cliff_months: String(workflow.vestingCliffMonths ?? 0),
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
