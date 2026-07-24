/**
 * Onboarding Admin API Routes
 * Handles the full founder onboarding workflow from offer to completion
 */

import { Hono } from 'hono';
import { eq, desc } from 'drizzle-orm';
import { z } from 'zod';
import {
  db,
  onboardingWorkflows,
  onboardingEvents,
  portfolioCompanies,
  founders,
  boardMembers,
  onboardingDocuments,
  OnboardingStatus,
  OnboardingEventType,
  OnboardingActor,
} from '../db/index.js';
import * as esign from '../services/esign.js';
import * as googleDrive from '../services/google-drive.js';
import * as onboardingEmails from '../services/onboarding-emails.js';
import * as lob from '../services/lob.js';
import * as election83b from '../services/election-83b.js';
import type { Filer } from '../services/election-83b.js';

const app = new Hono();

// ============== HELPER FUNCTIONS ==============

async function logEvent(
  workflowId: number,
  eventType: string,
  actor: string,
  actorEmail?: string,
  details?: Record<string, any>
) {
  await db.insert(onboardingEvents).values({
    workflowId,
    eventType,
    actor,
    actorEmail,
    details: details ? JSON.stringify(details) : undefined,
    createdAt: new Date().toISOString(),
  });
}

async function updateWorkflowStatus(
  workflowId: number,
  status: string,
  additionalFields?: Record<string, any>
) {
  await db.update(onboardingWorkflows)
    .set({
      status,
      ...additionalFields,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(onboardingWorkflows.id, workflowId));
}

async function getWorkflowWithDetails(workflowId: number) {
  const workflow = await db.query.onboardingWorkflows.findFirst({
    where: eq(onboardingWorkflows.id, workflowId),
    with: {
      portfolioCompany: {
        with: {
          founder: true,
        },
      },
      events: true,
      boardMembers: true,
    },
  });
  return workflow;
}

function calculateShareCount(equityPercent: string, authorizedShares: number): number {
  const percent = parseFloat(equityPercent) / 100;
  return Math.round(authorizedShares * percent);
}

function calculateTotalAmount(shareCount: number, sharePrice: string): string {
  const price = parseFloat(sharePrice);
  return (shareCount * price).toFixed(2);
}

async function sendStockAgreement(
  workflowId: number,
  workflow: any,
  updates: Record<string, any>,
  now: string
) {
  const founder = workflow.portfolioCompany.founder;
  const shareCount = workflow.authorizedShares && workflow.offerEquityPercent
    ? calculateShareCount(workflow.offerEquityPercent, workflow.authorizedShares)
    : 0;
  const totalAmount = calculateTotalAmount(shareCount, workflow.sharePrice || '0.0001');

  try {
    const stockResult = await esign.createStockAgreementRequest(
      {
        company_name: workflow.entityName || founder.companyName,
        entity_state: workflow.entityState || 'DE',
        effective_date: now.split('T')[0],
        share_count: shareCount.toLocaleString(),
        price_per_share: '$' + (workflow.sharePrice || '0.0001'),
        total_purchase_price: '$' + totalAmount,
        founder_name: founder.name,
        founder_title: workflow.founderTitle || 'Founder & CEO',
        founder_email: founder.email,
      },
      [
        { name: founder.name, email: founder.email, role: 'Founder' },
        { name: 'Mat Sherman', email: 'mat@matsherman.com', role: 'Advisor' },
      ]
    );

    updates.equityAgreementUrl = stockResult.signatureRequestId;
    updates.equityAgreementReceivedAt = now;

    await logEvent(workflowId, OnboardingEventType.EQUITY_AGREEMENT_UPLOADED, OnboardingActor.SYSTEM, undefined, {
      signatureRequestId: stockResult.signatureRequestId,
      shareCount,
      totalAmount,
    });

    updates.status = OnboardingStatus.EQUITY_AGREEMENT_PENDING;
    console.log(`Stock agreement sent for ${founder.companyName}`);
  } catch (stockErr: any) {
    console.error('Failed to create stock agreement:', stockErr);
    await onboardingEmails.sendEquityAgreementRequestEmail(
      { name: founder.name, email: founder.email, companyName: founder.companyName },
      {
        equityPercent: workflow.offerEquityPercent || '',
        sharePrice: workflow.sharePrice || '0.0001',
        shareCount,
        totalAmount,
        grantDate: now.split('T')[0],
      }
    );
    updates.status = OnboardingStatus.EQUITY_AGREEMENT_PENDING;
  }
}

// ============== LIST WORKFLOWS ==============

app.get('/workflows', async (c) => {
  const status = c.req.query('status');

  let workflows;
  if (status) {
    workflows = await db.query.onboardingWorkflows.findMany({
      where: eq(onboardingWorkflows.status, status),
      with: {
        portfolioCompany: {
          with: {
            founder: true,
          },
        },
      },
      orderBy: desc(onboardingWorkflows.updatedAt),
    });
  } else {
    workflows = await db.query.onboardingWorkflows.findMany({
      with: {
        portfolioCompany: {
          with: {
            founder: true,
          },
        },
      },
      orderBy: desc(onboardingWorkflows.updatedAt),
    });
  }

  // Group by status for summary
  const summary: Record<string, number> = {};
  for (const w of workflows) {
    summary[w.status] = (summary[w.status] || 0) + 1;
  }

  return c.json({ workflows, summary });
});

// ============== GET SINGLE WORKFLOW ==============

app.get('/workflows/:id', async (c) => {
  const id = parseInt(c.req.param('id'));

  const workflow = await getWorkflowWithDetails(id);
  if (!workflow) {
    return c.json({ error: 'Workflow not found' }, 404);
  }

  // Share details + "is there room to issue MatCap?" check.
  // available = authorized − issued (the unissued pool). We have room only if
  // that pool is at least as big as the stake we need to be issued. issued is
  // often unknown (not in the uploaded docs), in which case hasRoom is null.
  let shareDetails = null;
  if (workflow.authorizedShares) {
    const authorizedShares = workflow.authorizedShares;
    const issuedShares = workflow.issuedShares ?? null;
    const availableShares = issuedShares != null ? authorizedShares - issuedShares : null;
    const sharePrice = workflow.sharePrice || '0.0001';
    const shareCount = workflow.offerEquityPercent
      ? calculateShareCount(workflow.offerEquityPercent, authorizedShares)
      : null;
    const hasRoom =
      availableShares != null && shareCount != null ? availableShares >= shareCount : null;
    shareDetails = {
      authorizedShares,
      issuedShares,
      availableShares,
      shareCount,
      sharePrice,
      totalAmount: shareCount != null ? calculateTotalAmount(shareCount, sharePrice) : null,
      hasRoom, // true = room, false = not enough unissued shares, null = issued count unknown
    };
  }

  // Backup copies of the formation docs kept in the DB (metadata only, no bytes).
  const backupDocs = await db
    .select({
      id: onboardingDocuments.id,
      kind: onboardingDocuments.kind,
      filename: onboardingDocuments.filename,
      sizeBytes: onboardingDocuments.sizeBytes,
      createdAt: onboardingDocuments.createdAt,
    })
    .from(onboardingDocuments)
    .where(eq(onboardingDocuments.workflowId, id));

  return c.json({ workflow, shareDetails, boardMembers: workflow.boardMembers || [], backupDocs });
});

// Download a DB-backed formation doc (admin only; guard also accepts ?session=).
app.get('/:id/documents/:docId/download', async (c) => {
  const id = parseInt(c.req.param('id'));
  const docId = parseInt(c.req.param('docId'));
  const doc = await db.query.onboardingDocuments.findFirst({
    where: eq(onboardingDocuments.id, docId),
  });
  if (!doc || doc.workflowId !== id) return c.json({ error: 'Not found' }, 404);

  c.header('Content-Type', doc.mimeType || 'application/pdf');
  c.header('Content-Disposition', `inline; filename="${doc.filename || 'document.pdf'}"`);
  return c.body(doc.content as unknown as ArrayBuffer);
});

// ============== START WORKFLOW ==============

app.post('/:portfolioId/start', async (c) => {
  const portfolioId = parseInt(c.req.param('portfolioId'));
  const body = await c.req.json();

  const schema = z.object({
    equityPercent: z.string(),
    vestingMonths: z.number().optional().default(48),
    vestingCliffMonths: z.number().optional().default(0),
    notes: z.string().optional(),
  });

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues }, 400);
  }

  // Check portfolio company exists
  const portfolioCompany = await db.query.portfolioCompanies.findFirst({
    where: eq(portfolioCompanies.id, portfolioId),
    with: {
      founder: true,
    },
  });

  if (!portfolioCompany) {
    return c.json({ error: 'Portfolio company not found' }, 404);
  }

  // Check if workflow already exists
  const existing = await db.query.onboardingWorkflows.findFirst({
    where: eq(onboardingWorkflows.portfolioCompanyId, portfolioId),
  });

  if (existing) {
    return c.json({ error: 'Onboarding workflow already exists for this company' }, 400);
  }

  const now = new Date().toISOString();

  // Create Google Drive folder if configured
  let driveFolderId: string | undefined;
  let driveFolderUrl: string | undefined;
  if (googleDrive.isConfigured()) {
    try {
      const folder = await googleDrive.createCompanyFolder(portfolioCompany.founder.companyName);
      driveFolderId = folder.id;
      driveFolderUrl = folder.webViewLink;
    } catch (err) {
      console.error('Failed to create Drive folder:', err);
    }
  }

  // Create workflow
  const [workflow] = await db.insert(onboardingWorkflows).values({
    portfolioCompanyId: portfolioId,
    status: OnboardingStatus.OFFER_PENDING,
    offerEquityPercent: parsed.data.equityPercent,
    vestingMonths: parsed.data.vestingMonths,
    vestingCliffMonths: parsed.data.vestingCliffMonths,
    offerNotes: parsed.data.notes,
    driveFolderId,
    driveFolderUrl,
    createdAt: now,
    updatedAt: now,
  }).returning();

  // Log event
  await logEvent(workflow.id, OnboardingEventType.WORKFLOW_STARTED, OnboardingActor.ADMIN, undefined, {
    equityPercent: parsed.data.equityPercent,
    vestingMonths: parsed.data.vestingMonths,
    vestingCliffMonths: parsed.data.vestingCliffMonths,
    notes: parsed.data.notes,
  });

  return c.json(workflow, 201);
});

// ============== UPDATE OFFER TERMS ==============

app.put('/:id/offer-terms', async (c) => {
  const workflowId = parseInt(c.req.param('id'));
  const workflow = await getWorkflowWithDetails(workflowId);
  if (!workflow) return c.json({ error: 'Workflow not found' }, 404);
  if (workflow.offerSentAt) return c.json({ error: 'Cannot edit terms after offer has been sent' }, 400);

  const body = await c.req.json();
  const updates: Record<string, any> = {};
  if (body.equityPercent !== undefined) updates.offerEquityPercent = body.equityPercent;
  if (body.vestingMonths !== undefined) updates.vestingMonths = parseInt(body.vestingMonths);
  if (body.vestingCliffMonths !== undefined) updates.vestingCliffMonths = parseInt(body.vestingCliffMonths);
  if (body.introRequestsPerWeek !== undefined) updates.introRequestsPerWeek = parseInt(body.introRequestsPerWeek);
  if (body.introRequestsRevisitDate !== undefined) updates.introRequestsRevisitDate = body.introRequestsRevisitDate || null;

  if (Object.keys(updates).length === 0) return c.json({ error: 'No fields to update' }, 400);

  updates.updatedAt = new Date().toISOString();
  await db.update(onboardingWorkflows).set(updates).where(eq(onboardingWorkflows.id, workflowId));

  await logEvent(workflowId, OnboardingEventType.WORKFLOW_STARTED, OnboardingActor.ADMIN, 'Offer terms updated', updates);

  return c.json({ success: true });
});

// ============== UPDATE FOUNDER-ISSUED SHARES ==============
// Manual fallback for when the formation docs didn't state issued shares.
// Editable anytime (unlike offer terms), since it feeds the "room to issue
// MatCap" check that matters right through the equity step.

app.put('/:id/issued-shares', async (c) => {
  const workflowId = parseInt(c.req.param('id'));
  const workflow = await getWorkflowWithDetails(workflowId);
  if (!workflow) return c.json({ error: 'Workflow not found' }, 404);

  const body = await c.req.json().catch(() => ({}));
  const n = parseInt(body.issuedShares);
  const issuedShares =
    body.issuedShares === '' || body.issuedShares === null || Number.isNaN(n) ? null : n;

  await db.update(onboardingWorkflows)
    .set({ issuedShares, updatedAt: new Date().toISOString() })
    .where(eq(onboardingWorkflows.id, workflowId));

  await logEvent(workflowId, OnboardingEventType.WORKFLOW_STARTED, OnboardingActor.ADMIN, 'Issued shares updated', { issuedShares });

  return c.json({ success: true });
});

// ============== MANUAL STATUS OVERRIDE (admin) ==============
// Escape hatch to set a workflow's onboarding status by hand — for driving an
// onboarding live on a call, or unsticking a workflow that has no wired next
// action (e.g. docs_extracted). Validated against the known status set; logged.
app.put('/:id/status', async (c) => {
  const workflowId = parseInt(c.req.param('id'));
  const workflow = await getWorkflowWithDetails(workflowId);
  if (!workflow) return c.json({ error: 'Workflow not found' }, 404);

  const body = await c.req.json().catch(() => ({}));
  const status = String(body.status || '').trim();
  const validStatuses = Object.values(OnboardingStatus) as string[];
  if (!validStatuses.includes(status)) {
    return c.json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` }, 400);
  }

  const from = workflow.status;
  await updateWorkflowStatus(workflowId, status);
  await logEvent(workflowId, OnboardingEventType.WORKFLOW_STARTED, OnboardingActor.ADMIN, `Status manually set: ${from} → ${status}`, { from, to: status });

  return c.json({ success: true, from, to: status });
});

// ============== UPDATE INTRO REQUEST TERMS ==============

app.put('/:id/intro-request-terms', async (c) => {
  const workflowId = parseInt(c.req.param('id'));
  const workflow = await getWorkflowWithDetails(workflowId);
  if (!workflow) return c.json({ error: 'Workflow not found' }, 404);

  const body = await c.req.json();
  const updates: Record<string, any> = {};
  if (body.introRequestsPerWeek !== undefined) updates.introRequestsPerWeek = parseInt(body.introRequestsPerWeek);
  if (body.introRequestsRevisitDate !== undefined) updates.introRequestsRevisitDate = body.introRequestsRevisitDate || null;

  if (Object.keys(updates).length === 0) return c.json({ error: 'No fields to update' }, 400);

  updates.updatedAt = new Date().toISOString();
  await db.update(onboardingWorkflows).set(updates).where(eq(onboardingWorkflows.id, workflowId));

  await logEvent(workflowId, OnboardingEventType.WORKFLOW_STARTED, OnboardingActor.ADMIN, 'Intro request terms updated', updates);

  return c.json({ success: true });
});

// ============== SEND OFFER ==============

app.post('/:id/send-offer', async (c) => {
  const workflowId = parseInt(c.req.param('id'));

  const workflow = await getWorkflowWithDetails(workflowId);
  if (!workflow) {
    return c.json({ error: 'Workflow not found' }, 404);
  }

  if (workflow.status !== OnboardingStatus.OFFER_PENDING) {
    return c.json({ error: `Cannot send offer in status: ${workflow.status}` }, 400);
  }

  const founder = workflow.portfolioCompany.founder;
  const now = new Date().toISOString();

  // Send email
  await onboardingEmails.sendOfferEmail(
    { name: founder.name, email: founder.email, companyName: founder.companyName },
    workflow.offerEquityPercent || '',
    {
      vestingMonths: workflow.vestingMonths ?? 48,
      vestingCliffMonths: workflow.vestingCliffMonths ?? 0,
      introRequestsPerWeek: workflow.introRequestsPerWeek ?? 3,
      introRequestsRevisitDate: workflow.introRequestsRevisitDate || undefined,
      notes: workflow.offerNotes || undefined,
    }
  );

  // Update workflow
  await updateWorkflowStatus(workflowId, OnboardingStatus.OFFER_PENDING, {
    offerSentAt: now,
  });

  await logEvent(workflowId, OnboardingEventType.OFFER_SENT, OnboardingActor.ADMIN, undefined, {
    founderEmail: founder.email,
  });

  return c.json({ success: true, message: 'Offer sent to founder' });
});

// ============== RESEND OFFER ==============

app.post('/:id/resend-offer', async (c) => {
  const workflowId = parseInt(c.req.param('id'));

  const workflow = await getWorkflowWithDetails(workflowId);
  if (!workflow) {
    return c.json({ error: 'Workflow not found' }, 404);
  }

  if (!workflow.offerSentAt) {
    return c.json({ error: 'Offer has not been sent yet' }, 400);
  }

  const founder = workflow.portfolioCompany.founder;
  const now = new Date().toISOString();

  // Resend email with current terms
  await onboardingEmails.sendOfferEmail(
    { name: founder.name, email: founder.email, companyName: founder.companyName },
    workflow.offerEquityPercent || '',
    {
      vestingMonths: workflow.vestingMonths ?? 48,
      vestingCliffMonths: workflow.vestingCliffMonths ?? 0,
      introRequestsPerWeek: workflow.introRequestsPerWeek ?? 3,
      introRequestsRevisitDate: workflow.introRequestsRevisitDate || undefined,
      notes: workflow.offerNotes || undefined,
    }
  );

  // Update sent timestamp
  await db.update(onboardingWorkflows).set({ offerSentAt: now, updatedAt: now }).where(eq(onboardingWorkflows.id, workflowId));

  await logEvent(workflowId, OnboardingEventType.OFFER_SENT, OnboardingActor.ADMIN, 'Offer resent with updated terms', {
    founderEmail: founder.email,
    equityPercent: workflow.offerEquityPercent,
    vestingMonths: workflow.vestingMonths,
    vestingCliffMonths: workflow.vestingCliffMonths,
  });

  return c.json({ success: true, message: 'Offer resent to founder' });
});

// ============== GENERATE ADVISORY AGREEMENT ==============

app.post('/:id/generate-advisory-agreement', async (c) => {
  const workflowId = parseInt(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));
  const adminEmail = body.adminEmail;

  if (!esign.isConfigured()) {
    return c.json({ error: 'E-signature service not configured' }, 500);
  }

  const workflow = await getWorkflowWithDetails(workflowId);
  if (!workflow) {
    return c.json({ error: 'Workflow not found' }, 404);
  }

  if (workflow.status !== OnboardingStatus.ENTITY_INFO_RECEIVED) {
    return c.json({ error: `Cannot generate agreement in status: ${workflow.status}` }, 400);
  }

  const founder = workflow.portfolioCompany.founder;
  const now = new Date().toISOString();

  try {
    // Calculate share count
    const shareCount = workflow.authorizedShares && workflow.offerEquityPercent
      ? calculateShareCount(workflow.offerEquityPercent, workflow.authorizedShares)
      : 0;

    // Create signature request using Dropbox Sign template with merge fields
    const result = await esign.createSignatureRequest(
      {
        company_name: workflow.entityName || founder.companyName,
        effective_date: now.split('T')[0],
        share_count: shareCount.toLocaleString(),
        founder_name: founder.name,
        founder_title: workflow.founderTitle || 'Founder & CEO',
        founder_email: founder.email,
        equity_percent: workflow.offerEquityPercent || '',
        vesting_months: String(workflow.vestingMonths ?? 48),
        cliff_months: String(workflow.vestingCliffMonths ?? 0),
      },
      [
        { name: founder.name, email: founder.email, role: 'Founder' },
        { name: 'Mat Sherman', email: adminEmail || 'mat@matsherman.com', role: 'Advisor' },
      ]
    );

    // Update workflow
    await updateWorkflowStatus(workflowId, OnboardingStatus.ADVISORY_AGREEMENT_SENT, {
      esignDocumentId: result.documentId,
      esignSignatureRequestId: result.signatureRequestId,
      agreementSentAt: now,
    });

    await logEvent(workflowId, OnboardingEventType.ADVISORY_AGREEMENT_CREATED, OnboardingActor.ADMIN, adminEmail, {
      signatureRequestId: result.signatureRequestId,
    });

    return c.json({
      success: true,
      signatureRequestId: result.signatureRequestId,
      message: 'Advisory agreement created and sent for signatures',
    });
  } catch (err: any) {
    console.error('Failed to create signature request:', err);
    return c.json({ error: 'Failed to create signature request: ' + err.message }, 500);
  }
});

// ============== CHECK SIGNATURE STATUS (Poll Dropbox Sign) ==============

app.post('/:id/check-signature-status', async (c) => {
  const workflowId = parseInt(c.req.param('id'));

  const workflow = await getWorkflowWithDetails(workflowId);
  if (!workflow) {
    return c.json({ error: 'Workflow not found' }, 404);
  }

  // Determine which signature request to check based on status
  let signatureRequestId: string | null = null;
  let checkingAgreement = 'advisory';

  if (workflow.status === OnboardingStatus.EQUITY_AGREEMENT_PENDING && workflow.equityAgreementUrl) {
    // Check stock agreement (stored in equityAgreementUrl)
    signatureRequestId = workflow.equityAgreementUrl;
    checkingAgreement = 'stock';
  } else if (workflow.esignSignatureRequestId) {
    // Check advisory agreement
    signatureRequestId = workflow.esignSignatureRequestId;
    checkingAgreement = 'advisory';
  }

  if (!signatureRequestId) {
    return c.json({ error: 'No signature request found for this workflow' }, 400);
  }

  try {
    const status = await esign.getSignatureStatus(signatureRequestId);
    const now = new Date().toISOString();

    // Find who has signed
    const founderSigner = status.signers.find(s => s.email === workflow.portfolioCompany.founder.email);
    const adminSigner = status.signers.find(s => s.email === 'mat@matsherman.com');

    const updates: Record<string, any> = {};
    let newStatus = workflow.status;

    // Update founder signed timestamp
    if (founderSigner?.status === 'signed' && !workflow.founderSignedAt) {
      updates.founderSignedAt = founderSigner.signedAt || now;
      await logEvent(workflowId, OnboardingEventType.FOUNDER_SIGNED_ADVISORY, OnboardingActor.WEBHOOK, founderSigner.email);
    }

    // Update admin signed timestamp
    if (adminSigner?.status === 'signed' && !workflow.adminSignedAt) {
      updates.adminSignedAt = adminSigner.signedAt || now;
      await logEvent(workflowId, OnboardingEventType.ADMIN_SIGNED_ADVISORY, OnboardingActor.WEBHOOK, adminSigner.email);
    }

    // If both signed advisory, move to board approval
    if (status.isComplete && workflow.status !== OnboardingStatus.FOUNDER_SIGNED &&
        workflow.status !== OnboardingStatus.BOARD_APPROVAL_PENDING &&
        workflow.status !== OnboardingStatus.BOARD_APPROVED &&
        workflow.status !== OnboardingStatus.EQUITY_AGREEMENT_PENDING) {
      newStatus = OnboardingStatus.FOUNDER_SIGNED;

      // Check if board members exist - if so, move to board approval
      const members = await db.query.boardMembers.findMany({
        where: eq(boardMembers.workflowId, workflowId),
      });

      if (members.length > 0) {
        newStatus = OnboardingStatus.BOARD_APPROVAL_PENDING;
        updates.boardApprovalRequestedAt = now;

        await logEvent(workflowId, OnboardingEventType.BOARD_APPROVAL_REQUESTED, OnboardingActor.SYSTEM, undefined, {
          boardMemberCount: members.length,
        });

        // Check if sole founder already matches — auto-approve solo founders
        if (members.length === 1 && members[0].email.toLowerCase() === workflow.portfolioCompany.founder.email.toLowerCase()) {
          console.log(`Solo founder board - will need in-app approval for ${workflow.portfolioCompany.founder.companyName}`);
        }
      } else {
        // No board members recorded - go directly to equity agreement (legacy flows)
        newStatus = OnboardingStatus.BOARD_APPROVED;
        updates.boardApprovedAt = now;
        await sendStockAgreement(workflowId, workflow, updates, now);
      }
    }

    // Track individual stock agreement signatures
    if (checkingAgreement === 'stock') {
      const eqFounderSigner = status.signers.find(s => s.email === workflow.portfolioCompany.founder.email);
      const eqAdminSigner = status.signers.find(s => s.email === 'mat@matsherman.com');

      if (eqFounderSigner?.status === 'signed' && !workflow.equityFounderSignedAt) {
        updates.equityFounderSignedAt = eqFounderSigner.signedAt || now;
        await logEvent(workflowId, OnboardingEventType.EQUITY_FOUNDER_SIGNED, OnboardingActor.WEBHOOK, eqFounderSigner.email);
      }

      if (eqAdminSigner?.status === 'signed' && !workflow.equityAdminSignedAt) {
        updates.equityAdminSignedAt = eqAdminSigner.signedAt || now;
        await logEvent(workflowId, OnboardingEventType.EQUITY_ADMIN_SIGNED, OnboardingActor.WEBHOOK, eqAdminSigner.email);
      }

      // If both signed, move to wire info pending
      if (status.isComplete && workflow.status === OnboardingStatus.EQUITY_AGREEMENT_PENDING) {
        newStatus = OnboardingStatus.WIRE_INFO_PENDING;
        updates.equityAgreementSignedAt = now;

        await logEvent(workflowId, OnboardingEventType.EQUITY_AGREEMENT_SIGNED, OnboardingActor.SYSTEM, undefined, {
          signatureRequestId,
        });

        // Email founder requesting wire info
        const founder = workflow.portfolioCompany.founder;
        const shareCount = workflow.authorizedShares && workflow.offerEquityPercent
          ? calculateShareCount(workflow.offerEquityPercent, workflow.authorizedShares)
          : 0;
        const totalAmount = calculateTotalAmount(shareCount, workflow.sharePrice || '0.0001');

        await onboardingEmails.sendWireInfoRequestEmail(
          { name: founder.name, email: founder.email, companyName: founder.companyName },
          { shareCount, totalAmount, sharePrice: workflow.sharePrice || '0.0001' }
        );

        console.log(`Stock agreement fully signed for ${founder.companyName}, wire info requested`);
      }
    }

    if (Object.keys(updates).length > 0 || newStatus !== workflow.status) {
      await updateWorkflowStatus(workflowId, newStatus, updates);
    }

    return c.json({
      success: true,
      status: status.status,
      isComplete: status.isComplete,
      signers: status.signers,
      workflowStatus: newStatus,
      agreementType: checkingAgreement,
    });
  } catch (err: any) {
    console.error('Failed to check signature status:', err);
    return c.json({ error: 'Failed to check signature status: ' + err.message }, 500);
  }
});

// ============== SIGN EQUITY AGREEMENT (Admin signs founder's uploaded doc) ==============

app.post('/:id/sign-equity-agreement', async (c) => {
  const workflowId = parseInt(c.req.param('id'));

  const workflow = await getWorkflowWithDetails(workflowId);
  if (!workflow) {
    return c.json({ error: 'Workflow not found' }, 404);
  }

  if (workflow.status !== OnboardingStatus.EQUITY_AGREEMENT_PENDING) {
    return c.json({ error: `Cannot sign equity agreement in status: ${workflow.status}` }, 400);
  }

  const now = new Date().toISOString();

  await updateWorkflowStatus(workflowId, OnboardingStatus.EQUITY_AGREEMENT_SIGNED, {
    equityAgreementSignedAt: now,
  });

  await logEvent(workflowId, OnboardingEventType.EQUITY_AGREEMENT_SIGNED, OnboardingActor.ADMIN);

  return c.json({ success: true, message: 'Equity agreement signed' });
});

// ============== MARK SHARES PURCHASED ==============

app.post('/:id/mark-shares-purchased', async (c) => {
  const workflowId = parseInt(c.req.param('id'));
  const body = await c.req.json();

  const schema = z.object({
    amount: z.string(),
    method: z.enum(['check', 'wire', 'ach']),
    date: z.string().optional(),
  });

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues }, 400);
  }

  const workflow = await getWorkflowWithDetails(workflowId);
  if (!workflow) {
    return c.json({ error: 'Workflow not found' }, 404);
  }

  if (workflow.status !== OnboardingStatus.EQUITY_AGREEMENT_SIGNED &&
      workflow.status !== OnboardingStatus.WIRE_INFO_PENDING) {
    return c.json({ error: `Cannot mark shares purchased in status: ${workflow.status}` }, 400);
  }

  const now = new Date().toISOString();
  const purchaseDate = parsed.data.date || now.split('T')[0];

  await updateWorkflowStatus(workflowId, OnboardingStatus.SHARES_PURCHASED, {
    sharePurchaseAmount: parsed.data.amount,
    sharePurchaseMethod: parsed.data.method,
    sharePurchaseDate: purchaseDate,
  });

  await logEvent(workflowId, OnboardingEventType.SHARES_PURCHASED, OnboardingActor.ADMIN, undefined, {
    amount: parsed.data.amount,
    method: parsed.data.method,
    date: purchaseDate,
  });

  // Send email to founder
  const founder = workflow.portfolioCompany.founder;
  const shareCount = workflow.authorizedShares && workflow.offerEquityPercent
    ? calculateShareCount(workflow.offerEquityPercent, workflow.authorizedShares)
    : 0;

  await onboardingEmails.sendSharesPurchasedEmail(
    { name: founder.name, email: founder.email, companyName: founder.companyName },
    {
      equityPercent: workflow.offerEquityPercent || '',
      sharePrice: workflow.sharePrice || '0.0001',
      shareCount,
      totalAmount: parsed.data.amount,
      grantDate: purchaseDate,
    }
  );

  return c.json({ success: true, message: 'Shares marked as purchased' });
});

// ============== FILE 83(b) ==============

app.post('/:id/file-83b', async (c) => {
  const workflowId = parseInt(c.req.param('id'));
  const body = await c.req.json();

  const schema = z.object({
    proofUrl: z.string().optional(),
  });

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues }, 400);
  }

  const workflow = await getWorkflowWithDetails(workflowId);
  if (!workflow) {
    return c.json({ error: 'Workflow not found' }, 404);
  }

  if (workflow.status !== OnboardingStatus.SHARES_PURCHASED) {
    return c.json({ error: `Cannot file 83(b) in status: ${workflow.status}` }, 400);
  }

  const now = new Date().toISOString();

  await updateWorkflowStatus(workflowId, OnboardingStatus.ELECTION_83B_FILED, {
    election83bFiledAt: now,
    election83bProofUrl: parsed.data.proofUrl,
  });

  await logEvent(workflowId, OnboardingEventType.ELECTION_83B_FILED, OnboardingActor.ADMIN, undefined, {
    proofUrl: parsed.data.proofUrl,
  });

  // Update status to certificate pending and send email to founder
  await updateWorkflowStatus(workflowId, OnboardingStatus.CERTIFICATE_PENDING);

  const founder = workflow.portfolioCompany.founder;
  const shareCount = workflow.authorizedShares && workflow.offerEquityPercent
    ? calculateShareCount(workflow.offerEquityPercent, workflow.authorizedShares)
    : 0;

  await onboardingEmails.sendCertificateRequestEmail(
    { name: founder.name, email: founder.email, companyName: founder.companyName },
    {
      equityPercent: workflow.offerEquityPercent || '',
      sharePrice: workflow.sharePrice || '0.0001',
      shareCount,
      totalAmount: workflow.sharePurchaseAmount || '',
      grantDate: workflow.sharePurchaseDate || '',
    }
  );

  return c.json({ success: true, message: '83(b) filed, certificate request sent to founder' });
});

// ============== 83(b) GENERATE + FILE VIA LOB ==============

// The date the restricted stock was transferred to MatCap — starts the hard
// 30-day §83(b) clock. Prefer the recorded purchase date, fall back to the
// equity-agreement signing date.
function transferDateOf(workflow: any): string {
  return workflow.sharePurchaseDate || (workflow.equityAgreementSignedAt || '').split('T')[0] || '';
}

function build83bInput(workflow: any, profile: election83b.TaxpayerProfile): election83b.ElectionInput {
  const founder = workflow.portfolioCompany.founder;
  const shareCount = workflow.authorizedShares && workflow.offerEquityPercent
    ? calculateShareCount(workflow.offerEquityPercent, workflow.authorizedShares)
    : 0;
  const pricePerShare = parseFloat(workflow.sharePrice || '0.0001') || 0.0001;
  const entityType = /llc|limited liability/i.test(workflow.entityType || '')
    ? 'limited liability company'
    : 'corporation';
  return {
    taxpayer: profile,
    companyName: workflow.entityName || founder.companyName || 'the Company',
    entityState: workflow.entityState || 'Delaware',
    entityType,
    shareCount,
    pricePerShare,
    // Stock purchased at FMV → $0 includible. Adjust fmvPerShare if the grant
    // price differs from FMV at transfer.
    fmvPerShare: pricePerShare,
    transferDate: transferDateOf(workflow),
  };
}

// Read-only: deadline countdown + config readiness + existing filings.
app.get('/:id/83b-info', async (c) => {
  const workflowId = parseInt(c.req.param('id'));
  const workflow = await getWorkflowWithDetails(workflowId);
  if (!workflow) return c.json({ error: 'Workflow not found' }, 404);

  const transferDate = transferDateOf(workflow);
  const configured = election83b.configuredFilers();
  let filings: any[] = [];
  try { filings = workflow.election83bFilings ? JSON.parse(workflow.election83bFilings) : []; } catch { filings = []; }

  return c.json({
    transferDate,
    deadline: election83b.electionDeadline(transferDate),
    daysRemaining: transferDate ? election83b.daysUntilDeadline(transferDate, new Date().toISOString()) : null,
    configuredFilers: configured,
    unconfiguredFilers: (['entity', 'personal'] as Filer[]).filter((f) => !configured.includes(f)),
    lobConfigured: lob.isConfigured(),
    lobLiveKey: lob.isConfigured() ? lob.isLiveKey() : false,
    irsConfigured: election83b.getIrsAddress() !== null,
    filings: Array.isArray(filings) ? filings : [],
  });
});

// Generate the election PDFs (one per configured filer) for review + signing.
// Does not change status or file anything.
app.post('/:id/generate-83b', async (c) => {
  const workflowId = parseInt(c.req.param('id'));
  const workflow = await getWorkflowWithDetails(workflowId);
  if (!workflow) return c.json({ error: 'Workflow not found' }, 404);

  const filers = election83b.configuredFilers();
  if (!filers.length) {
    return c.json({ error: 'No taxpayer profiles configured. Set MATCAP_83B_ENTITY_* and/or MATCAP_83B_PERSONAL_* secrets.' }, 400);
  }

  const transferDate = transferDateOf(workflow);
  const elections: any[] = [];
  for (const filer of filers) {
    const profile = election83b.getTaxpayerProfile(filer)!;
    const input = build83bInput(workflow, profile);
    const pdf = await election83b.generate83bPdf(input);
    const fileName = `83b Election - ${filer === 'entity' ? 'Entity' : 'Personal'} - ${input.companyName}.pdf`;
    let driveUrl: string | null = null;
    if (googleDrive.isConfigured() && workflow.driveFolderId) {
      try {
        const f = await googleDrive.uploadDocument(workflow.driveFolderId, fileName, pdf, 'application/pdf');
        driveUrl = f.webViewLink;
      } catch (e) {
        console.error('[83b] Drive upload failed, returning inline:', (e as Error).message);
      }
    }
    elections.push({
      filer,
      fileName,
      driveUrl,
      dataUrl: `data:application/pdf;base64,${pdf.toString('base64')}`,
      shareCount: input.shareCount,
      transferDate: input.transferDate,
    });
  }

  await logEvent(workflowId, OnboardingEventType.DOCUMENT_UPLOADED, OnboardingActor.ADMIN, undefined, {
    documentType: '83b_election_generated',
    filers,
  });

  return c.json({
    success: true,
    elections,
    deadline: election83b.electionDeadline(transferDate),
    daysRemaining: transferDate ? election83b.daysUntilDeadline(transferDate, new Date().toISOString()) : null,
    unconfiguredFilers: (['entity', 'personal'] as Filer[]).filter((f) => !filers.includes(f)),
    lobConfigured: lob.isConfigured(),
    irsConfigured: election83b.getIrsAddress() !== null,
  });
});

// Mail signed election PDFs to the IRS via Lob Certified Mail. Multipart:
// `entitySigned` and/or `personalSigned` files. Records tracking as proof and
// advances status once every configured filer has been filed.
app.post('/:id/file-83b-via-lob', async (c) => {
  const workflowId = parseInt(c.req.param('id'));
  const workflow = await getWorkflowWithDetails(workflowId);
  if (!workflow) return c.json({ error: 'Workflow not found' }, 404);

  if (!lob.isConfigured()) return c.json({ error: 'Lob is not configured (set LOB_API_KEY).' }, 400);
  const irs = election83b.getIrsAddress();
  if (!irs) return c.json({ error: 'IRS mailing address not configured (set MATCAP_83B_IRS_* secrets).' }, 400);
  if (workflow.status !== OnboardingStatus.SHARES_PURCHASED) {
    return c.json({ error: `Cannot file 83(b) in status: ${workflow.status}` }, 400);
  }

  const body = await c.req.parseBody();
  const now = new Date().toISOString();
  let filings: any[] = [];
  try { filings = workflow.election83bFilings ? JSON.parse(workflow.election83bFilings) : []; } catch { filings = []; }
  if (!Array.isArray(filings)) filings = [];

  const toSend: { filer: Filer; file: any }[] = [];
  for (const filer of ['entity', 'personal'] as Filer[]) {
    const key = filer === 'entity' ? 'entitySigned' : 'personalSigned';
    const f = (body as any)[key];
    if (f && typeof f === 'object' && typeof f.arrayBuffer === 'function') toSend.push({ filer, file: f });
  }
  if (!toSend.length) return c.json({ error: 'No signed election PDFs provided (entitySigned / personalSigned).' }, 400);

  const sent: any[] = [];
  for (const { filer, file } of toSend) {
    const profile = election83b.getTaxpayerProfile(filer);
    if (!profile) return c.json({ error: `Taxpayer profile for '${filer}' is not configured.` }, 400);
    const pdf = Buffer.from(await file.arrayBuffer());
    const from = election83b.getReturnAddress(profile);
    const companyName = workflow.entityName || workflow.portfolioCompany.founder.companyName;

    const result = await lob.sendCertifiedLetter({
      description: `83(b) election — ${filer} — ${companyName}`,
      to: { name: irs.name, addressLine1: irs.addressLine1, addressLine2: irs.addressLine2, city: irs.city, state: irs.state, zip: irs.zip },
      from: { name: from.name, addressLine1: from.addressLine1, addressLine2: from.addressLine2, city: from.city, state: from.state, zip: from.zip },
      pdf,
      fileName: `83b-${filer}.pdf`,
    });

    let driveUrl: string | null = null;
    if (googleDrive.isConfigured() && workflow.driveFolderId) {
      try {
        const df = await googleDrive.uploadDocument(workflow.driveFolderId, `83b Election SIGNED - ${filer}.pdf`, pdf, 'application/pdf');
        driveUrl = df.webViewLink;
      } catch { /* non-fatal */ }
    }

    const record = { filer, lobId: result.id, trackingNumber: result.trackingNumber, proofUrl: result.proofUrl, expectedDeliveryDate: result.expectedDeliveryDate, mailedAt: now, driveUrl };
    const idx = filings.findIndex((r: any) => r.filer === filer);
    if (idx >= 0) filings[idx] = record; else filings.push(record);
    sent.push(record);

    await logEvent(workflowId, OnboardingEventType.DOCUMENT_UPLOADED, OnboardingActor.ADMIN, undefined, {
      documentType: '83b_filed_via_lob', filer, lobId: result.id, trackingNumber: result.trackingNumber,
    });
  }

  const configured = election83b.configuredFilers();
  const allFiled = configured.length > 0 && configured.every((f) => filings.some((r: any) => r.filer === f));

  if (allFiled) {
    await updateWorkflowStatus(workflowId, OnboardingStatus.ELECTION_83B_FILED, {
      election83bFilings: JSON.stringify(filings),
      election83bFiledAt: now,
      election83bProofUrl: filings[0]?.proofUrl || null,
    });
    await logEvent(workflowId, OnboardingEventType.ELECTION_83B_FILED, OnboardingActor.ADMIN, undefined, { via: 'lob', count: filings.length });
    await updateWorkflowStatus(workflowId, OnboardingStatus.CERTIFICATE_PENDING);

    const founder = workflow.portfolioCompany.founder;
    const shareCount = workflow.authorizedShares && workflow.offerEquityPercent
      ? calculateShareCount(workflow.offerEquityPercent, workflow.authorizedShares) : 0;
    try {
      await onboardingEmails.sendCertificateRequestEmail(
        { name: founder.name, email: founder.email, companyName: founder.companyName },
        { equityPercent: workflow.offerEquityPercent || '', sharePrice: workflow.sharePrice || '0.0001', shareCount, totalAmount: workflow.sharePurchaseAmount || '', grantDate: workflow.sharePurchaseDate || '' }
      );
    } catch (e) { console.error('[83b] certificate email failed:', (e as Error).message); }
  } else {
    await updateWorkflowStatus(workflowId, OnboardingStatus.SHARES_PURCHASED, { election83bFilings: JSON.stringify(filings) });
  }

  return c.json({ success: true, filed: sent, allFiled, pendingFilers: configured.filter((f) => !filings.some((r: any) => r.filer === f)) });
});

// ============== VERIFY CERTIFICATE ==============

app.post('/:id/verify-certificate', async (c) => {
  const workflowId = parseInt(c.req.param('id'));
  const body = await c.req.json();

  const schema = z.object({
    certificateNumber: z.string().optional(),
  });

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues }, 400);
  }

  const workflow = await getWorkflowWithDetails(workflowId);
  if (!workflow) {
    return c.json({ error: 'Workflow not found' }, 404);
  }

  if (workflow.status !== OnboardingStatus.CERTIFICATE_PENDING || !workflow.certificateUrl) {
    return c.json({ error: 'Certificate not uploaded or wrong status' }, 400);
  }

  const now = new Date().toISOString();

  await updateWorkflowStatus(workflowId, OnboardingStatus.COMPLETED, {
    equityVerifiedAt: now,
    certificateNumber: parsed.data.certificateNumber,
  });

  await logEvent(workflowId, OnboardingEventType.CERTIFICATE_VERIFIED, OnboardingActor.ADMIN, undefined, {
    certificateNumber: parsed.data.certificateNumber,
  });

  await logEvent(workflowId, OnboardingEventType.WORKFLOW_COMPLETED, OnboardingActor.SYSTEM);

  // Move Drive folder to completed
  if (googleDrive.isConfigured() && workflow.driveFolderId) {
    try {
      await googleDrive.moveToFullyOnboarded(workflow.driveFolderId);
    } catch (err) {
      console.error('Failed to move Drive folder:', err);
    }
  }

  // Update portfolio company flags
  await db.update(portfolioCompanies)
    .set({
      advisorySigned: true,
      equitySigned: true,
      sharesPaid: true,
      certificateReceived: true,
      updatedAt: now,
    })
    .where(eq(portfolioCompanies.id, workflow.portfolioCompanyId));

  return c.json({ success: true, message: 'Onboarding complete!' });
});

// ============== SEND REMINDER ==============

app.post('/:id/send-reminder', async (c) => {
  const workflowId = parseInt(c.req.param('id'));

  const workflow = await getWorkflowWithDetails(workflowId);
  if (!workflow) {
    return c.json({ error: 'Workflow not found' }, 404);
  }

  const founder = workflow.portfolioCompany.founder;

  // Determine what action is pending based on status
  let action = '';
  switch (workflow.status) {
    case OnboardingStatus.OFFER_PENDING:
      action = 'Accept the offer';
      break;
    case OnboardingStatus.OFFER_ACCEPTED:
    case OnboardingStatus.ENTITY_INFO_PENDING:
      action = 'Submit company details';
      break;
    case OnboardingStatus.ADVISORY_AGREEMENT_SENT:
    case OnboardingStatus.ADMIN_SIGNED:
      action = 'Sign the advisory agreement';
      break;
    case OnboardingStatus.BOARD_APPROVAL_PENDING:
      action = 'Approve the equity issuance (board consent)';
      break;
    case OnboardingStatus.EQUITY_AGREEMENT_PENDING:
      action = 'Sign the stock agreement (check Dropbox Sign)';
      break;
    case OnboardingStatus.WIRE_INFO_PENDING:
      action = 'Upload your wire/payment info';
      break;
    case OnboardingStatus.CERTIFICATE_PENDING:
      action = 'Upload the stock certificate';
      break;
    default:
      return c.json({ error: 'No pending action for current status' }, 400);
  }

  // Calculate days since last update
  const lastUpdate = new Date(workflow.updatedAt);
  const now = new Date();
  const daysSince = Math.floor((now.getTime() - lastUpdate.getTime()) / (1000 * 60 * 60 * 24));

  await onboardingEmails.sendReminderEmail(
    { name: founder.name, email: founder.email, companyName: founder.companyName },
    action,
    daysSince
  );

  await logEvent(workflowId, OnboardingEventType.REMINDER_SENT, OnboardingActor.ADMIN, undefined, {
    action,
    daysSince,
  });

  return c.json({ success: true, message: `Reminder sent for: ${action}` });
});

// ============== UPLOAD 83(b) PROOF (Admin) ==============

app.post('/:id/upload-83b-proof', async (c) => {
  const workflowId = parseInt(c.req.param('id'));
  const body = await c.req.json();

  const schema = z.object({
    proofUrl: z.string(),
  });

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues }, 400);
  }

  const workflow = await getWorkflowWithDetails(workflowId);
  if (!workflow) {
    return c.json({ error: 'Workflow not found' }, 404);
  }

  await db.update(onboardingWorkflows)
    .set({
      election83bProofUrl: parsed.data.proofUrl,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(onboardingWorkflows.id, workflowId));

  await logEvent(workflowId, OnboardingEventType.DOCUMENT_UPLOADED, OnboardingActor.ADMIN, undefined, {
    documentType: '83b_proof',
    url: parsed.data.proofUrl,
  });

  return c.json({ success: true });
});

// ============== GET WORKFLOW EVENTS ==============

app.get('/:id/events', async (c) => {
  const workflowId = parseInt(c.req.param('id'));

  const events = await db.query.onboardingEvents.findMany({
    where: eq(onboardingEvents.workflowId, workflowId),
    orderBy: desc(onboardingEvents.createdAt),
  });

  return c.json(events);
});

// Toggle approved-for-law-firm
app.put('/:id/approved-for-law-firm', async (c) => {
  const workflowId = parseInt(c.req.param('id'));
  const body = await c.req.json();
  const { approved } = body;

  const workflow = await getWorkflowWithDetails(workflowId);
  if (!workflow) {
    return c.json({ error: 'Workflow not found' }, 404);
  }

  await db.update(onboardingWorkflows)
    .set({
      approvedForLawFirm: !!approved,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(onboardingWorkflows.id, workflowId));

  await logEvent(workflowId, 'approved_for_law_firm_toggled', OnboardingActor.ADMIN, undefined, { approved });

  return c.json({ success: true });
});

export default app;
