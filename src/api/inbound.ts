import { Hono } from 'hono';
import { eq, desc } from 'drizzle-orm';
import { db, inboundIntroLogs, founders, investors, nodes, introRequests, founderNodeRelationships, nodeInvestorConnections } from '../db/index.js';
import { z } from 'zod';

const app = new Hono();

/**
 * Calculate Levenshtein distance between two strings
 */
function levenshtein(a: string, b: string): number {
  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

/**
 * Fuzzy match a name against a list of candidates
 */
function fuzzyMatchName(
  query: string,
  candidates: Array<{ id: number; name: string }>
): { id: number; name: string } | null {
  const queryLower = query.toLowerCase().trim();
  const queryParts = queryLower.split(/\s+/).filter((p) => p.length > 1);

  if (queryParts.length === 0) return null;

  let bestMatch: (typeof candidates)[0] | null = null;
  let bestScore = 0;

  for (const candidate of candidates) {
    const candLower = candidate.name.toLowerCase();
    const candParts = candLower.split(/\s+/);
    let score = 0;

    const matchingParts = queryParts.filter((part) => candLower.includes(part));
    score = matchingParts.length;

    for (const part of queryParts) {
      if (candParts.some((cp) => cp === part || levenshtein(cp, part) <= 1)) {
        score += 2;
      }
    }

    if (score > bestScore && matchingParts.length >= queryParts.length) {
      bestScore = score;
      bestMatch = candidate;
    }
  }

  return bestMatch;
}

/**
 * Parse names from a subject line like "Intro: Sarah <> John Smith"
 */
function parseNamesFromSubject(subject: string): string[] {
  const names: string[] = [];

  // Pattern: "Intro: Name1 <> Name2"
  const separatorMatch = subject.match(
    /intro[:\s-]+(.+?)\s*(?:<>|<->|↔|→|->|to)\s*(.+)/i
  );
  if (separatorMatch) {
    names.push(separatorMatch[1].trim());
    names.push(separatorMatch[2].trim());
    return names;
  }

  // Pattern: "Intro to Name"
  const introToMatch = subject.match(/intro\s+to\s+(.+)/i);
  if (introToMatch) {
    names.push(introToMatch[1].trim().replace(/[?!.,;:]+$/, ''));
    return names;
  }

  // Pattern: "Meet Name"
  const meetMatch = subject.match(/meet(?:ing)?\s+(?:with\s+)?(.+)/i);
  if (meetMatch) {
    names.push(meetMatch[1].trim().replace(/[?!.,;:]+$/, ''));
  }

  return names;
}

/**
 * Postmark inbound email webhook payload
 */
interface PostmarkInboundPayload {
  From: string;
  FromName: string;
  FromFull: { Email: string; Name: string };
  To: string;
  ToFull: Array<{ Email: string; Name: string }>;
  Cc: string;
  CcFull: Array<{ Email: string; Name: string }>;
  Subject: string;
  TextBody: string;
  HtmlBody: string;
  OriginalRecipient: string;
  Date: string; // Original email date from headers
}

// ============================================
// WEBHOOK ENDPOINT (Public with token auth)
// ============================================

/**
 * Handle inbound intro email from Postmark (BCC logging)
 * POST /api/inbound/intro-email
 */
app.post('/intro-email', async (c) => {
  try {
    // Verify token
    const token = c.req.query('token');
    const expectedToken = process.env.POSTMARK_INBOUND_TOKEN;

    if (!expectedToken) {
      console.error('[INBOUND] POSTMARK_INBOUND_TOKEN not configured');
      return c.json({ error: 'Server misconfigured' }, 500);
    }

    if (token !== expectedToken) {
      console.error('[INBOUND] Invalid token provided');
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const payload = await c.req.json() as PostmarkInboundPayload;

    console.log('[INBOUND] Received intro email', {
      from: payload.From,
      to: payload.To,
      cc: payload.Cc,
      subject: payload.Subject,
    });

    // Collect all email addresses
    const fromEmail = payload.FromFull?.Email || payload.From;
    const toEmails = payload.ToFull?.map((t) => t.Email).filter(Boolean) || [];
    const ccEmails = payload.CcFull?.map((c) => c.Email).filter(Boolean) || [];
    // Recipient emails only (NOT the sender - sender is likely the node/connector)
    const recipientEmails = [...toEmails, ...ccEmails].map((e) => e.toLowerCase());

    // Get body preview (first 500 chars of text body)
    const bodyPreview = payload.TextBody ? payload.TextBody.substring(0, 500) : null;

    // === Try to detect node (the sender/connector) ===
    let detectedNodeId: number | null = null;
    const senderEmail = fromEmail.toLowerCase();

    // Check if sender is a node
    const senderNode = await db.query.nodes.findFirst({
      where: eq(nodes.email, senderEmail),
    });
    if (senderNode) {
      detectedNodeId = senderNode.id;
      console.log('[INBOUND] Matched node (sender) by email:', senderEmail, '->', senderNode.name);
    }

    // === Try to detect founder ===
    // IMPORTANT: Founder should be in To/CC, NOT the sender (sender is the node)
    let detectedFounderId: number | null = null;

    // Check recipient emails against founders (NOT sender email)
    for (const email of recipientEmails) {
      const founder = await db.query.founders.findFirst({
        where: eq(founders.email, email),
      });
      if (founder) {
        detectedFounderId = founder.id;
        console.log('[INBOUND] Matched founder by recipient email:', email);
        break;
      }
    }

    // Try to match founder by names in subject
    if (!detectedFounderId) {
      const namesInSubject = parseNamesFromSubject(payload.Subject || '');
      if (namesInSubject.length > 0) {
        const allFounders = await db.select({ id: founders.id, name: founders.name }).from(founders);
        for (const name of namesInSubject) {
          const match = fuzzyMatchName(name, allFounders);
          if (match) {
            detectedFounderId = match.id;
            console.log('[INBOUND] Matched founder by subject name:', name, '->', match.name);
            break;
          }
        }
      }
    }

    // Try to match founder by scanning email body for known founder names
    if (!detectedFounderId && payload.TextBody) {
      const allFounders = await db.select({ id: founders.id, name: founders.name }).from(founders);
      const bodyLower = payload.TextBody.toLowerCase();

      // Sort by name length descending to match longer names first
      const sortedFounders = [...allFounders].sort((a, b) => b.name.length - a.name.length);

      for (const founder of sortedFounders) {
        const nameLower = founder.name.toLowerCase();
        // Check if the full name appears in the body
        if (bodyLower.includes(nameLower)) {
          detectedFounderId = founder.id;
          console.log('[INBOUND] Matched founder by body scan:', founder.name);
          break;
        }
        // Also check for "FirstName LastName" pattern
        const nameParts = nameLower.split(/\s+/);
        if (nameParts.length >= 2 && nameParts[0].length >= 3) {
          const firstName = nameParts[0];
          const lastName = nameParts[nameParts.length - 1];
          if (bodyLower.includes(firstName) && bodyLower.includes(lastName)) {
            detectedFounderId = founder.id;
            console.log('[INBOUND] Matched founder by body scan (partial):', founder.name);
            break;
          }
        }
      }
    }

    // === Try to detect investor ===
    let detectedInvestorId: number | null = null;

    // Try to match investor by names in subject
    const namesInSubject = parseNamesFromSubject(payload.Subject || '');
    if (namesInSubject.length > 0) {
      const allInvestors = await db.select({ id: investors.id, name: investors.name }).from(investors);
      for (const name of namesInSubject) {
        const match = fuzzyMatchName(name, allInvestors);
        if (match && match.id !== detectedFounderId) {
          detectedInvestorId = match.id;
          console.log('[INBOUND] Matched investor by subject name:', name, '->', match.name);
          break;
        }
      }
    }

    // Try to match investor by recipient names
    if (!detectedInvestorId) {
      const recipientNames = [
        ...(payload.ToFull?.map((t) => t.Name).filter(Boolean) || []),
        ...(payload.CcFull?.map((c) => c.Name).filter(Boolean) || []),
      ];

      if (recipientNames.length > 0) {
        const allInvestors = await db.select({ id: investors.id, name: investors.name }).from(investors);
        for (const name of recipientNames) {
          const match = fuzzyMatchName(name, allInvestors);
          if (match) {
            detectedInvestorId = match.id;
            console.log('[INBOUND] Matched investor by recipient name:', name, '->', match.name);
            break;
          }
        }
      }
    }

    // Try to match investor by scanning email body for known investor names
    if (!detectedInvestorId && payload.TextBody) {
      const allInvestors = await db.select({ id: investors.id, name: investors.name }).from(investors);
      const bodyLower = payload.TextBody.toLowerCase();

      // Sort by name length descending to match longer names first (e.g., "John Smith" before "John")
      const sortedInvestors = [...allInvestors].sort((a, b) => b.name.length - a.name.length);

      for (const investor of sortedInvestors) {
        const nameLower = investor.name.toLowerCase();
        // Check if the full name appears in the body
        if (bodyLower.includes(nameLower)) {
          detectedInvestorId = investor.id;
          console.log('[INBOUND] Matched investor by body scan:', investor.name);
          break;
        }
        // Also check for "FirstName LastName" pattern with first name at least 3 chars
        const nameParts = nameLower.split(/\s+/);
        if (nameParts.length >= 2 && nameParts[0].length >= 3) {
          // Check if both first and last name appear near each other
          const firstName = nameParts[0];
          const lastName = nameParts[nameParts.length - 1];
          if (bodyLower.includes(firstName) && bodyLower.includes(lastName)) {
            detectedInvestorId = investor.id;
            console.log('[INBOUND] Matched investor by body scan (partial):', investor.name);
            break;
          }
        }
      }
    }

    // === Store the inbound log ===
    const now = new Date().toISOString();

    const result = await db.insert(inboundIntroLogs).values({
      fromEmail: fromEmail,
      toEmails: JSON.stringify(toEmails),
      ccEmails: ccEmails.length > 0 ? JSON.stringify(ccEmails) : null,
      subject: payload.Subject || null,
      bodyPreview: bodyPreview,
      detectedFounderId: detectedFounderId,
      detectedInvestorId: detectedInvestorId,
      status: 'pending',
      createdAt: now,
      processedAt: null,
      emailDate: payload.Date || now,
    }).returning();

    const logId = result[0].id;

    console.log('[INBOUND] Created inbound intro log:', logId, {
      detectedNodeId,
      detectedFounderId,
      detectedInvestorId,
    });

    return c.json({
      success: true,
      logId,
      detectedFounderId,
      detectedInvestorId,
    });
  } catch (err) {
    console.error('[INBOUND] Error processing webhook:', err);
    // Return 200 to prevent Postmark retries, but log the error
    return c.json({ success: false, error: 'Internal error' }, 200);
  }
});

// ============================================
// ADMIN ENDPOINTS (Protected by middleware in index.ts)
// ============================================

/**
 * List pending inbound intro logs
 * GET /api/inbound/pending
 */
app.get('/pending', async (c) => {
  const logs = await db.query.inboundIntroLogs.findMany({
    where: eq(inboundIntroLogs.status, 'pending'),
    with: {
      founder: true,
      investor: true,
    },
    orderBy: desc(inboundIntroLogs.createdAt),
  });

  return c.json(logs.map((log) => ({
    ...log,
    toEmails: JSON.parse(log.toEmails || '[]'),
    ccEmails: log.ccEmails ? JSON.parse(log.ccEmails) : [],
  })));
});

/**
 * Get all inbound intro logs (with optional status filter)
 * GET /api/inbound/logs
 */
app.get('/logs', async (c) => {
  const status = c.req.query('status');

  let logs;
  if (status) {
    logs = await db.query.inboundIntroLogs.findMany({
      where: eq(inboundIntroLogs.status, status),
      with: {
        founder: true,
        investor: true,
      },
      orderBy: desc(inboundIntroLogs.createdAt),
    });
  } else {
    logs = await db.query.inboundIntroLogs.findMany({
      with: {
        founder: true,
        investor: true,
      },
      orderBy: desc(inboundIntroLogs.createdAt),
    });
  }

  return c.json(logs.map((log) => ({
    ...log,
    toEmails: JSON.parse(log.toEmails || '[]'),
    ccEmails: log.ccEmails ? JSON.parse(log.ccEmails) : [],
  })));
});

const confirmSchema = z.object({
  founderId: z.number().optional(),
  investorId: z.number().optional(),
  nodeId: z.number().optional(),
  notes: z.string().optional(),
});

/**
 * Confirm an inbound intro log - creates intro request as "introduced"
 * POST /api/inbound/:id/confirm
 */
app.post('/:id/confirm', async (c) => {
  const logId = parseInt(c.req.param('id'));
  const body = await c.req.json();
  const parsed = confirmSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: parsed.error.issues }, 400);
  }

  // Get the log
  const log = await db.query.inboundIntroLogs.findFirst({
    where: eq(inboundIntroLogs.id, logId),
  });

  if (!log) {
    return c.json({ error: 'Inbound intro log not found' }, 404);
  }

  if (log.status !== 'pending') {
    return c.json({ error: 'Log has already been processed' }, 400);
  }

  // Determine final founder/investor IDs
  const finalFounderId = parsed.data.founderId || log.detectedFounderId;
  const finalInvestorId = parsed.data.investorId || log.detectedInvestorId;
  const nodeId = parsed.data.nodeId;

  if (!finalFounderId) {
    return c.json({ error: 'Founder ID is required - could not be auto-detected' }, 400);
  }

  if (!finalInvestorId) {
    return c.json({ error: 'Investor ID is required - could not be auto-detected' }, 400);
  }

  // Find a node ID if not provided (try to find any existing relationship)
  let finalNodeId = nodeId;
  if (!finalNodeId) {
    // Try to find an existing founder-node-investor path
    const founderNodes = await db.query.founderNodeRelationships.findMany({
      where: eq(founderNodeRelationships.founderId, finalFounderId),
    });

    for (const fn of founderNodes) {
      const nodeInvestor = await db.query.nodeInvestorConnections.findFirst({
        where: eq(nodeInvestorConnections.nodeId, fn.nodeId),
      });
      if (nodeInvestor && nodeInvestor.investorId === finalInvestorId) {
        finalNodeId = fn.nodeId;
        break;
      }
    }
  }

  if (!finalNodeId) {
    return c.json({ error: 'Node ID is required - no existing relationship found between founder and investor' }, 400);
  }

  const now = new Date().toISOString();
  let introRequestId: number;

  // Check for existing intro request
  const existingRequest = await db.query.introRequests.findFirst({
    where: eq(introRequests.founderId, finalFounderId),
  });

  const existingForPair = existingRequest &&
    existingRequest.investorId === finalInvestorId;

  if (existingForPair) {
    // Already exists - just use the existing request
    introRequestId = existingRequest.id;
    // Optionally update notes if provided
    if (parsed.data.notes) {
      await db.update(introRequests)
        .set({
          notes: parsed.data.notes,
          updatedAt: now,
        })
        .where(eq(introRequests.id, introRequestId));
    }
  } else {
    // Create new intro request as 'intro_request_sent'
    // Use the original email date for dateRequested, not the confirmation date
    const emailDate = log.emailDate || log.createdAt;
    const dateRequested = emailDate.split('T')[0];

    const result = await db.insert(introRequests).values({
      founderId: finalFounderId,
      nodeId: finalNodeId,
      investorId: finalInvestorId,
      status: 'intro_request_sent',
      dateRequested,
      notes: parsed.data.notes || null,
      createdAt: now,
      updatedAt: now,
    }).returning();

    introRequestId = result[0].id;
  }

  // Mark the log as confirmed
  await db.update(inboundIntroLogs)
    .set({
      status: 'confirmed',
      detectedFounderId: finalFounderId,
      detectedInvestorId: finalInvestorId,
      processedAt: now,
    })
    .where(eq(inboundIntroLogs.id, logId));

  console.log('[INBOUND] Confirmed intro log:', logId, '-> intro request:', introRequestId);

  return c.json({
    success: true,
    logId,
    introRequestId,
    founderId: finalFounderId,
    investorId: finalInvestorId,
    nodeId: finalNodeId,
    wasExisting: existingForPair,
  });
});

/**
 * Dismiss an inbound intro log
 * POST /api/inbound/:id/dismiss
 */
app.post('/:id/dismiss', async (c) => {
  const logId = parseInt(c.req.param('id'));

  const log = await db.query.inboundIntroLogs.findFirst({
    where: eq(inboundIntroLogs.id, logId),
  });

  if (!log) {
    return c.json({ error: 'Inbound intro log not found' }, 404);
  }

  if (log.status !== 'pending') {
    return c.json({ error: 'Log has already been processed' }, 400);
  }

  const now = new Date().toISOString();

  await db.update(inboundIntroLogs)
    .set({
      status: 'dismissed',
      processedAt: now,
    })
    .where(eq(inboundIntroLogs.id, logId));

  console.log('[INBOUND] Dismissed intro log:', logId);

  return c.json({ success: true, logId });
});

/**
 * Update detected founder/investor on a pending log
 * PATCH /api/inbound/:id
 */
app.patch('/:id', async (c) => {
  const logId = parseInt(c.req.param('id'));
  const body = await c.req.json();

  const log = await db.query.inboundIntroLogs.findFirst({
    where: eq(inboundIntroLogs.id, logId),
  });

  if (!log) {
    return c.json({ error: 'Inbound intro log not found' }, 404);
  }

  if (log.status !== 'pending') {
    return c.json({ error: 'Cannot update a processed log' }, 400);
  }

  const updates: Record<string, number | null> = {};
  if (body.founderId !== undefined) {
    updates.detectedFounderId = body.founderId;
  }
  if (body.investorId !== undefined) {
    updates.detectedInvestorId = body.investorId;
  }

  if (Object.keys(updates).length > 0) {
    await db.update(inboundIntroLogs)
      .set(updates)
      .where(eq(inboundIntroLogs.id, logId));
  }

  return c.json({ success: true, logId });
});

export default app;
