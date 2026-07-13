/**
 * Docs-first onboarding track (founder-facing, mounted at /api/portal/docs).
 *
 * For companies that are ALREADY INCORPORATED. Instead of typing entity details
 * by hand, the founder uploads their formation documents — Articles of
 * Incorporation (AOC), bylaws, and initial board consent — we extract the
 * variables with Claude, the founder reviews/confirms, and the workflow rejoins
 * the standard flow at ENTITY_INFO_RECEIVED (advisory agreement → board
 * approval → equity), reusing everything downstream.
 *
 * Entry: POST /api/portal/onboarding/incorporation-answer with path:'docs_first'
 * sets the workflow to DOCS_PENDING and intakeType 'docs_first'.
 */

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  db,
  founders,
  portfolioCompanies,
  onboardingWorkflows,
  onboardingEvents,
  boardMembers,
  OnboardingStatus,
  OnboardingEventType,
  OnboardingActor,
} from '../db/index.js';
import { getSessionFounderId } from './auth.js';
import { extractFormationDocuments, type ExtractedFormationData } from '../services/document-extraction.js';
import * as drive from '../services/google-drive.js';
import * as esign from '../services/esign.js';
import * as onboardingEmails from '../services/onboarding-emails.js';

type Variables = { founderId: number };

const app = new Hono<{ Variables: Variables }>();

// Auth — mirrors founder-portal: founders authenticate with X-Session-Id.
app.use('*', async (c, next) => {
  const sessionId = c.req.header('X-Session-Id');
  const founderId = await getSessionFounderId(sessionId);
  if (!founderId) return c.json({ error: 'Unauthorized' }, 401);
  c.set('founderId', founderId);
  await next();
});

async function logEvent(
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

/** Resolve the founder + portfolio company + workflow for the current session. */
async function loadContext(founderId: number) {
  const founder = await db.query.founders.findFirst({ where: eq(founders.id, founderId) });
  if (!founder) return { error: 'Founder not found' as const, status: 404 as const };
  const portfolioCompany = await db.query.portfolioCompanies.findFirst({
    where: eq(portfolioCompanies.founderId, founderId),
  });
  if (!portfolioCompany) return { error: 'Not a portfolio company' as const, status: 400 as const };
  const workflow = await db.query.onboardingWorkflows.findFirst({
    where: eq(onboardingWorkflows.portfolioCompanyId, portfolioCompany.id),
  });
  if (!workflow) return { error: 'No onboarding workflow found' as const, status: 404 as const };
  return { founder, portfolioCompany, workflow };
}

/**
 * Store a formation doc. Uses Google Drive when configured (preferred — keeps
 * everything in the company's Drive folder), otherwise falls back to local disk
 * under DATA_DIR/formation-docs so dev/self-host works without Drive creds.
 */
async function storeDoc(
  workflow: typeof onboardingWorkflows.$inferSelect,
  companyName: string,
  label: string,
  buf: Buffer
): Promise<{ url: string; folderId: string | null }> {
  const fileName = `${label}.pdf`;
  if (drive.isConfigured()) {
    let folderId = workflow.driveFolderId;
    let folderUrl = workflow.driveFolderUrl;
    if (!folderId) {
      const folder = await drive.createCompanyFolder(companyName);
      folderId = folder.id;
      folderUrl = folder.webViewLink;
      await db.update(onboardingWorkflows)
        .set({ driveFolderId: folderId, driveFolderUrl: folderUrl, updatedAt: new Date().toISOString() })
        .where(eq(onboardingWorkflows.id, workflow.id));
    }
    const uploaded = await drive.uploadDocument(folderId, fileName, buf, 'application/pdf');
    return { url: uploaded.webViewLink, folderId };
  }
  // Local fallback
  const fs = await import('fs/promises');
  const path = await import('path');
  const baseDir =
    (process.env.DATA_DIR || (process.env.NODE_ENV === 'production' ? '/app/data' : '.')) +
    '/formation-docs';
  const dir = path.join(baseDir, String(workflow.id));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, fileName), buf);
  return { url: `/formation-docs/${workflow.id}/${fileName}`, folderId: null };
}

/**
 * POST /upload — multipart with all three formation docs (aoc, bylaws,
 * boardConsent). Stores each, runs extraction, returns the extracted variables
 * for the founder to review. All three docs are required.
 */
app.post('/upload', async (c) => {
  const founderId = c.get('founderId') as number;
  const ctx = await loadContext(founderId);
  if ('error' in ctx) return c.json({ error: ctx.error }, ctx.status);
  const { founder, workflow } = ctx;

  const allowed = [
    OnboardingStatus.DOCS_PENDING,
    OnboardingStatus.DOCS_UPLOADED,
    OnboardingStatus.DOCS_EXTRACTED,
  ];
  if (!allowed.includes(workflow.status as any)) {
    return c.json({ error: `Cannot upload formation docs in status: ${workflow.status}` }, 400);
  }

  const body = await c.req.parseBody();
  const fields: { key: 'aoc' | 'bylaws' | 'boardConsent'; label: string }[] = [
    { key: 'aoc', label: 'ARTICLES_OF_INCORPORATION' },
    { key: 'bylaws', label: 'BYLAWS' },
    { key: 'boardConsent', label: 'INITIAL_BOARD_CONSENT' },
  ];

  const buffers: Record<string, Buffer> = {};
  for (const { key } of fields) {
    const file = body[key] as unknown as File | undefined;
    if (!file || typeof (file as any).arrayBuffer !== 'function') {
      return c.json({ error: `Missing required document: ${key}. All three (aoc, bylaws, boardConsent) are required.` }, 400);
    }
    if (file.size > 30 * 1024 * 1024) {
      return c.json({ error: `${key} is too large (max 30 MB)` }, 413);
    }
    const mime = (file as any).type || '';
    if (!mime.includes('pdf') && !file.name.toLowerCase().endsWith('.pdf')) {
      return c.json({ error: `${key} must be a PDF` }, 400);
    }
    buffers[key] = Buffer.from(await file.arrayBuffer());
  }

  // Store all three, then mark uploaded.
  const now = new Date().toISOString();
  const aocStore = await storeDoc(workflow, founder.companyName, 'articles-of-incorporation', buffers.aoc);
  const bylawsStore = await storeDoc(workflow, founder.companyName, 'bylaws', buffers.bylaws);
  const consentStore = await storeDoc(workflow, founder.companyName, 'initial-board-consent', buffers.boardConsent);

  await db.update(onboardingWorkflows)
    .set({
      status: OnboardingStatus.DOCS_UPLOADED,
      intakeType: 'docs_first',
      articlesOfIncorporationUrl: aocStore.url,
      bylawsUrl: bylawsStore.url,
      boardConsentUrl: consentStore.url,
      updatedAt: now,
    })
    .where(eq(onboardingWorkflows.id, workflow.id));

  await logEvent(workflow.id, OnboardingEventType.FORMATION_DOCS_UPLOADED, founder.email, {
    aoc: aocStore.url,
    bylaws: bylawsStore.url,
    boardConsent: consentStore.url,
  });

  // Extract. On failure leave status at DOCS_UPLOADED so the founder can retry.
  let extracted: ExtractedFormationData;
  try {
    extracted = await extractFormationDocuments({
      aoc: buffers.aoc,
      bylaws: buffers.bylaws,
      boardConsent: buffers.boardConsent,
    });
  } catch (err: any) {
    console.error('[docs-onboarding] extraction failed:', err);
    return c.json({
      success: true,
      uploaded: true,
      extracted: false,
      error: 'Documents uploaded, but automatic extraction failed. You can retry, or enter details manually.',
    }, 200);
  }

  await db.update(onboardingWorkflows)
    .set({
      status: OnboardingStatus.DOCS_EXTRACTED,
      extractionRaw: JSON.stringify(extracted),
      extractedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(onboardingWorkflows.id, workflow.id));

  await logEvent(workflow.id, OnboardingEventType.FORMATION_DOCS_EXTRACTED, founder.email, {
    entityName: extracted.entityName,
    confidence: extracted.confidence,
    warningCount: extracted.warnings.length,
  });

  return c.json({ success: true, uploaded: true, extracted: true, data: extracted });
});

/**
 * GET /extracted — return the stored extraction for the review screen, with the
 * pre-filled values the founder will confirm.
 */
app.get('/extracted', async (c) => {
  const founderId = c.get('founderId') as number;
  const ctx = await loadContext(founderId);
  if ('error' in ctx) return c.json({ error: ctx.error }, ctx.status);
  const { workflow } = ctx;

  if (!workflow.extractionRaw) {
    return c.json({ extracted: false, message: 'No formation-document extraction yet. Upload your docs first.' });
  }
  let data: ExtractedFormationData;
  try {
    data = JSON.parse(workflow.extractionRaw);
  } catch {
    return c.json({ extracted: false, message: 'Stored extraction was unreadable. Please re-upload.' });
  }
  return c.json({ extracted: true, status: workflow.status, data });
});

/**
 * POST /confirm — founder's reviewed/edited values. Writes the entity info onto
 * the workflow, creates board members (source 'extracted'), advances to
 * ENTITY_INFO_RECEIVED, and auto-sends the advisory agreement — the same
 * convergence the manual entity-info flow performs.
 */
app.post('/confirm', async (c) => {
  const founderId = c.get('founderId') as number;
  const body = await c.req.json();

  const schema = z.object({
    entityName: z.string().min(1),
    entityType: z.enum(['llc', 'c_corp', 's_corp', 'partnership', 'sole_prop', 'other']),
    entityState: z.string().min(2).max(2),
    ein: z.string().min(1, 'EIN is required'),
    authorizedShares: z.number().positive(),
    sharePrice: z.string().optional(),
    founderTitle: z.string().optional(),
    incorporationDate: z.string().optional(),
    boardMembers: z.array(z.object({
      name: z.string().min(1),
      email: z.string().email(),
      title: z.string().optional(),
    })).min(1, 'At least one board member is required'),
  });

  const parsed = schema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);

  const ctx = await loadContext(founderId);
  if ('error' in ctx) return c.json({ error: ctx.error }, ctx.status);
  const { founder, workflow } = ctx;

  if (workflow.status !== OnboardingStatus.DOCS_EXTRACTED &&
      workflow.status !== OnboardingStatus.DOCS_UPLOADED) {
    return c.json({ error: `Cannot confirm formation docs in status: ${workflow.status}` }, 400);
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
      authorizedShares: parsed.data.authorizedShares,
      sharePrice,
      founderTitle,
      incorporationDate: parsed.data.incorporationDate || workflow.incorporationDate || null,
      entityInfoReceivedAt: now,
      docsConfirmedAt: now,
      updatedAt: now,
    })
    .where(eq(onboardingWorkflows.id, workflow.id));

  // Create board members from the confirmed list (extracted from board consent,
  // emails supplied by the founder).
  for (const member of parsed.data.boardMembers) {
    await db.insert(boardMembers).values({
      workflowId: workflow.id,
      name: member.name,
      email: member.email,
      title: member.title || null,
      isFounder: member.email.toLowerCase() === founder.email.toLowerCase(),
      source: 'extracted',
      createdAt: now,
    });
  }

  await logEvent(workflow.id, OnboardingEventType.FORMATION_DOCS_CONFIRMED, founder.email, {
    entityName: parsed.data.entityName,
    entityType: parsed.data.entityType,
    authorizedShares: parsed.data.authorizedShares,
    boardMemberCount: parsed.data.boardMembers.length,
  });

  // Auto-send advisory agreement (same as manual entity-info convergence).
  let agreementSent = false;
  if (esign.isConfigured()) {
    try {
      const equityPercent = parseFloat(workflow.offerEquityPercent || '0');
      const shareCount = Math.round(parsed.data.authorizedShares * (equityPercent / 100));
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
      await db.update(onboardingWorkflows)
        .set({
          status: OnboardingStatus.ADVISORY_AGREEMENT_SENT,
          esignDocumentId: result.documentId,
          esignSignatureRequestId: result.signatureRequestId,
          agreementSentAt: now,
          updatedAt: now,
        })
        .where(eq(onboardingWorkflows.id, workflow.id));
      await logEvent(workflow.id, OnboardingEventType.ADVISORY_AGREEMENT_CREATED, 'system', {
        signatureRequestId: result.signatureRequestId,
      });
      agreementSent = true;
      console.log(`✅ Advisory agreement auto-sent for ${founder.companyName} (docs-first)`);
    } catch (err: any) {
      console.error('Failed to auto-send advisory agreement (docs-first):', err);
    }
  }

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
      ? 'Company details confirmed from your formation documents! The advisory agreement has been sent to your email for signature.'
      : 'Company details confirmed! We will prepare the advisory agreement.',
  });
});

export default app;
