import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { serveStatic } from '@hono/node-server/serve-static';
import cron from 'node-cron';

import foundersRoutes from './api/founders.js';
import nodesRoutes from './api/nodes.js';
import investorsRoutes from './api/investors.js';
import introRequestsRoutes from './api/intro-requests.js';
import relationshipsRoutes from './api/relationships.js';
import digestRoutes from './api/digest.js';
import authRoutes from './api/auth.js';
import founderPortalRoutes from './api/founder-portal.js';
import investorResearchRoutes from './api/investor-research.js';
import portfolioRoutes from './api/portfolio.js';
import adminAuthRoutes from './api/admin-auth.js';
import inboundRoutes from './api/inbound.js';
import onboardingRoutes from './api/onboarding.js';
import onboardingChatRoutes from './api/onboarding-chat.js';
import webhooksRoutes from './api/webhooks.js';
import weeklyDigestRoutes from './api/weekly-digest.js';
import publicAuthRoutes from './api/public-auth.js';
import publicProfileRoutes from './api/public-profile.js';
import publicCompaniesRoutes from './api/public-companies.js';
import publicIntrosRoutes from './api/public-intros.js';
import publicPortfolioRoutes from './api/public-portfolio.js';
import categoriesRoutes from './api/categories.js';
import matchingRoutes from './api/matching.js';
import marketplaceHealthRoutes from './api/marketplace-health.js';
import signupsRoutes from './api/signups.js';
import voiceInterviewsRoutes from './api/voice-interviews.js';
import blurbRoutes from './api/blurb.js';
import instantlyRoutes from './api/instantly.js';
import brandsRoutes from './api/brands.js';
import { sendWeeklyDigests, sendDigestPreviewToAdmin } from './services/weekly-digest.js';
import { adminGuard } from './api/middleware/admin-guard.js';
import { eq, and, or, inArray, isNull, sql } from 'drizzle-orm';
import { db, nodes, investors, founders, nodeInvestorConnections, founderNodeRelationships, introRequests } from './db/index.js';
import { desc } from 'drizzle-orm';

const app = new Hono();

// Middleware
app.use('*', logger());
app.use('/api/*', cors());

// Public API Routes (no auth required)
app.route('/api/admin-auth', adminAuthRoutes);
app.route('/api/auth', authRoutes);
app.route('/api/portal', founderPortalRoutes);
// Public network signup/login (separate from founder auth)
app.route('/api/public', publicAuthRoutes);
app.route('/api/public', publicProfileRoutes);
app.route('/api/public/companies', publicCompaniesRoutes);
app.route('/api/public/intros', publicIntrosRoutes);
app.route('/api/public/portfolio', publicPortfolioRoutes);
// Onboarding chat is public (founder intake interview)
// Admin endpoints (/leads, /leads/:id/convert) are protected below
app.route('/api/onboarding-chat', onboardingChatRoutes);
// Blurb builder is public (founder self-service)
app.route('/api/blurb', blurbRoutes);
// Voice interview public endpoints (token-based auth)
app.route('/api', voiceInterviewsRoutes);
// Inbound webhook endpoint is public (uses token auth internally)
// Other inbound endpoints are protected below

// Protected Admin API Routes (require admin session)
// Need both patterns: base path for POST/GET list, and /* for individual resources
app.use('/api/founders', adminGuard);
app.use('/api/founders/*', adminGuard);
app.use('/api/nodes', adminGuard);
app.use('/api/nodes/*', adminGuard);
app.use('/api/categories', adminGuard);
app.use('/api/categories/*', adminGuard);
app.use('/api/investors', adminGuard);
app.use('/api/investors/*', adminGuard);
app.use('/api/intro-requests', adminGuard);
app.use('/api/intro-requests/*', adminGuard);
app.use('/api/relationships', adminGuard);
app.use('/api/relationships/*', adminGuard);
app.use('/api/digest', adminGuard);
app.use('/api/digest/*', adminGuard);
app.use('/api/portfolio', adminGuard);
app.use('/api/portfolio/*', adminGuard);
// Inbound admin endpoints (pending, logs, confirm, dismiss) - NOT the webhook
// Note: /api/inbound/intro-email is public (uses token auth)
app.use('/api/inbound/pending', adminGuard);
app.use('/api/inbound/logs', adminGuard);
app.use('/api/inbound/:id/confirm', adminGuard);
app.use('/api/inbound/:id/dismiss', adminGuard);
// Onboarding admin endpoints
app.use('/api/onboarding', adminGuard);
app.use('/api/onboarding/*', adminGuard);
// Onboarding chat admin endpoints (leads management)
app.use('/api/onboarding-chat/leads', adminGuard);
app.use('/api/onboarding-chat/leads/*', adminGuard);
// Matching system
app.use('/api/matching', adminGuard);
app.use('/api/matching/*', adminGuard);
// Marketplace health
app.use('/api/marketplace-health', adminGuard);
app.use('/api/marketplace-health/*', adminGuard);
app.use('/api/signups', adminGuard);
app.use('/api/signups/*', adminGuard);
// Instantly outreach
app.use('/api/instantly', adminGuard);
app.use('/api/instantly/*', adminGuard);
// Brands CRM
app.use('/api/brands', adminGuard);
app.use('/api/brands/*', adminGuard);
// Voice interview admin endpoints
app.use('/api/admin/voice-interviews', adminGuard);
app.use('/api/admin/voice-interviews/*', adminGuard);
// Weekly digest - preview requires admin, send allows token auth for cron
app.use('/api/weekly-digest/preview/*', adminGuard);
app.use('/api/weekly-digest/preview-admin', adminGuard);
// Shadow agent — admin-only manual trigger
app.use('/api/agent/*', adminGuard);

app.route('/api/categories', categoriesRoutes);
app.route('/api/founders', foundersRoutes);
app.route('/api/nodes', nodesRoutes);
app.route('/api/investors', investorsRoutes);
app.route('/api/investors', investorResearchRoutes);
app.route('/api/intro-requests', introRequestsRoutes);
app.route('/api/relationships', relationshipsRoutes);
app.route('/api/digest', digestRoutes);
app.route('/api/portfolio', portfolioRoutes);
app.route('/api/inbound', inboundRoutes);
app.route('/api/onboarding', onboardingRoutes);
app.route('/api/webhooks', webhooksRoutes);
app.route('/api/matching', matchingRoutes);
app.route('/api/marketplace-health', marketplaceHealthRoutes);
app.route('/api/signups', signupsRoutes);
app.route('/api/weekly-digest', weeklyDigestRoutes);
app.route('/api/instantly', instantlyRoutes);
app.route('/api/brands', brandsRoutes);
// Health check
app.get('/api/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));

// Serve uploaded founder decks (unguessable filename = the access token)
app.get('/decks/:filename', async (c) => {
  const filename = c.req.param('filename');
  if (!/^[a-f0-9]{32}\.pdf$/i.test(filename)) {
    return c.text('Not found', 404);
  }
  const fs = await import('fs/promises');
  const path = await import('path');
  const decksDir = path.join(process.env.DATA_DIR || (process.env.NODE_ENV === 'production' ? '/app/data' : '.'), 'decks');
  try {
    const buf = await fs.readFile(path.join(decksDir, filename));
    c.header('Content-Type', 'application/pdf');
    c.header('Content-Disposition', `inline; filename="${filename}"`);
    c.header('Cache-Control', 'private, max-age=3600');
    return c.body(new Uint8Array(buf));
  } catch (_) {
    return c.text('Not found', 404);
  }
});

// Shadow agent — manual trigger (admin-only via /api/agent/* guard above)
app.post('/api/agent/run-now', async (c) => {
  const { runAgentTick } = await import('./services/agent.js');
  const result = await runAgentTick();
  return c.json(result);
});

// Auto-draft tick — picks one high-score pending suggestion + creates Gmail draft
app.post('/api/agent/auto-draft-now', async (c) => {
  const { runAutoDraftTick } = await import('./services/agent.js');
  const result = await runAutoDraftTick();
  return c.json(result);
});

// Rescore every pending match_suggestion using the current scoring formula.
// One-shot tool for the case where suggestions were generated under an older
// algorithm and now show stale scores in the audit table.
app.post('/api/agent/rescore-pending', async (c) => {
  const { rescorePendingSuggestions } = await import('./services/matching.js');
  const result = await rescorePendingSuggestions();
  return c.json(result);
});

// Clear all pending suggestions — destructive reset of the queue. Drops both
// the match_suggestions rows and the linked intro_requests in 'pending_suggestion'
// status. Use before re-running the agent under new gating to start clean.
app.post('/api/agent/clear-pending', async (c) => {
  const { matchSuggestions } = await import('./db/index.js');
  const pending = await db.select({
    id: matchSuggestions.id,
    introRequestId: matchSuggestions.introRequestId,
  }).from(matchSuggestions).where(eq(matchSuggestions.status, 'pending'));

  const introIds = pending.map(p => p.introRequestId).filter((x): x is number => x != null);
  let deletedIntros = 0;
  let deletedSuggestions = 0;

  if (introIds.length > 0) {
    const introRows = await db.select().from(introRequests)
      .where(and(
        eq(introRequests.status, 'pending_suggestion'),
        inArray(introRequests.id, introIds),
      ));
    for (const ir of introRows) {
      await db.delete(introRequests).where(eq(introRequests.id, ir.id));
      deletedIntros++;
    }
  }

  for (const s of pending) {
    await db.delete(matchSuggestions).where(eq(matchSuggestions.id, s.id));
    deletedSuggestions++;
  }

  return c.json({ deletedSuggestions, deletedIntros });
});

// Backfill investor emails from inbound_intro_logs. For each investor lacking
// an email, find the most recent inbound_intro_logs row where detectedInvestorId
// matches and copy from_email onto the investor record.
app.post('/api/agent/backfill-investor-emails', async (c) => {
  const { inboundIntroLogs } = await import('./db/index.js');
  const missing = await db.select({ id: investors.id, name: investors.name })
    .from(investors)
    .where(or(isNull(investors.email), eq(investors.email, '')));

  let updated = 0;
  const filled: Array<{ id: number; name: string; email: string }> = [];
  for (const inv of missing) {
    const logs = await db.select({ fromEmail: inboundIntroLogs.fromEmail })
      .from(inboundIntroLogs)
      .where(and(
        eq(inboundIntroLogs.detectedInvestorId, inv.id),
        sql`${inboundIntroLogs.fromEmail} IS NOT NULL AND ${inboundIntroLogs.fromEmail} != ''`,
      ))
      .orderBy(desc(inboundIntroLogs.createdAt))
      .limit(1);
    if (logs.length === 0) continue;
    const email = logs[0].fromEmail.trim().toLowerCase();
    if (!email || !email.includes('@')) continue;
    await db.update(investors).set({ email }).where(eq(investors.id, inv.id));
    filled.push({ id: inv.id, name: inv.name, email });
    updated++;
  }

  return c.json({
    candidates: missing.length,
    updated,
    sampleFilled: filled.slice(0, 10),
  });
});

// Mark a Gmail-drafted intro as actually sent — flips status to intro_request_sent
app.post('/api/intro-requests/:id/mark-sent', async (c) => {
  const id = parseInt(c.req.param('id'));
  const intro = await db.query.introRequests.findFirst({ where: eq(introRequests.id, id) });
  if (!intro) return c.json({ error: 'Intro request not found' }, 404);
  if (intro.status !== 'pending_suggestion') {
    return c.json({ error: `Not a pending suggestion (status: ${intro.status})` }, 400);
  }
  const now = new Date().toISOString();
  await db.update(introRequests).set({
    status: 'intro_request_sent',
    dateRequested: now.split('T')[0],
    updatedAt: now,
  }).where(eq(introRequests.id, id));
  // Mirror the match suggestion to approved
  const { matchSuggestions } = await import('./db/index.js');
  await db.update(matchSuggestions).set({ status: 'approved', reviewedAt: now })
    .where(eq(matchSuggestions.introRequestId, id));
  return c.json({ success: true });
});

// Mark an intro as resulting in an investment — flips status to 'invested'.
// This is the single binary outcome signal we track. Allowed from any
// post-pending status so admin can flip after the fact.
app.post('/api/intro-requests/:id/mark-invested', async (c) => {
  const id = parseInt(c.req.param('id'));
  const intro = await db.query.introRequests.findFirst({ where: eq(introRequests.id, id) });
  if (!intro) return c.json({ error: 'Intro request not found' }, 404);
  if (intro.status === 'pending_suggestion') {
    return c.json({ error: 'Cannot mark a pending suggestion as invested — send the intro first' }, 400);
  }
  const now = new Date().toISOString();
  await db.update(introRequests).set({
    status: 'invested',
    updatedAt: now,
  }).where(eq(introRequests.id, id));
  return c.json({ success: true });
});

// Discard a Gmail draft + the pending suggestion (deletes draft, rejects suggestion)
app.post('/api/intro-requests/:id/discard-draft', async (c) => {
  const id = parseInt(c.req.param('id'));
  const intro = await db.query.introRequests.findFirst({ where: eq(introRequests.id, id) });
  if (!intro) return c.json({ error: 'Intro request not found' }, 404);
  if (intro.status !== 'pending_suggestion') {
    return c.json({ error: `Not a pending suggestion (status: ${intro.status})` }, 400);
  }
  // Best-effort: delete the Gmail draft if one exists
  if (intro.gmailDraftId) {
    try {
      const { google } = await import('googleapis');
      const { getStatus } = await import('./services/gmail.js');
      // We don't have a public delete helper yet; do it inline.
      const stored = await getStatus();
      if (stored.connected) {
        const { OAuth2Client } = await import('google-auth-library');
        const client = new google.auth.OAuth2(process.env.GOOGLE_OAUTH_CLIENT_ID, process.env.GOOGLE_OAUTH_CLIENT_SECRET);
        // Reload refresh token via the same file used in gmail.ts
        const fs = await import('fs/promises');
        const path = await import('path');
        const credsFile = path.join(process.env.DATA_DIR || (process.env.NODE_ENV === 'production' ? '/app/data' : '.'), 'gmail-credentials.json');
        const raw = await fs.readFile(credsFile, 'utf8');
        const parsed = JSON.parse(raw);
        client.setCredentials({ refresh_token: parsed.refreshToken });
        const gmail = google.gmail({ version: 'v1', auth: client });
        await gmail.users.drafts.delete({ userId: 'me', id: intro.gmailDraftId });
      }
    } catch (e) {
      console.error('[DISCARD-DRAFT] Failed to delete Gmail draft', e);
      // Not fatal — still proceed with DB cleanup
    }
  }
  const now = new Date().toISOString();
  // Reject the linked match suggestion + free up the FK so we can delete
  const { matchSuggestions } = await import('./db/index.js');
  await db.update(matchSuggestions).set({
    status: 'rejected',
    reviewedAt: now,
    rejectionReason: 'Discarded after auto-draft',
    introRequestId: null,
  }).where(eq(matchSuggestions.introRequestId, id));
  await db.delete(introRequests).where(eq(introRequests.id, id));
  return c.json({ success: true });
});

// Gmail OAuth — returns the Google consent URL for the admin to redirect to
app.get('/api/agent/gmail/connect', async (c) => {
  const { getAuthUrl } = await import('./services/gmail.js');
  try {
    return c.json({ authUrl: getAuthUrl() });
  } catch (err: any) {
    return c.json({ error: err.message || 'Gmail OAuth not configured' }, 500);
  }
});

// Gmail OAuth — connection status
app.get('/api/agent/gmail/status', async (c) => {
  const { getStatus } = await import('./services/gmail.js');
  return c.json(await getStatus());
});

// Gmail OAuth — disconnect (deletes stored refresh token)
app.post('/api/agent/gmail/disconnect', async (c) => {
  const { disconnect } = await import('./services/gmail.js');
  await disconnect();
  return c.json({ success: true });
});

// Gmail OAuth — callback (public; Google redirects here after consent).
// Lives outside /api/agent/* so the admin guard doesn't block Google.
// The Google-issued `code` is the only credential needed; only Google can
// produce a valid one, so the public URL is acceptable.
app.get('/oauth/gmail/callback', async (c) => {
  const code = c.req.query('code');
  const errorParam = c.req.query('error');
  if (errorParam) {
    return c.html(`<h2>Gmail connect failed</h2><p>${errorParam}</p><p><a href="/admin">Back to admin</a></p>`, 400);
  }
  if (!code) {
    return c.html('<h2>Gmail connect: missing code parameter</h2><p><a href="/admin">Back to admin</a></p>', 400);
  }
  const { exchangeCodeForTokens } = await import('./services/gmail.js');
  try {
    const { email } = await exchangeCodeForTokens(code);
    return c.html(`<h2>Gmail connected ✓</h2><p>Linked account: <strong>${email || 'unknown'}</strong>. You can close this tab.</p><script>setTimeout(()=>{window.location.href='/admin';},1200);</script>`);
  } catch (err: any) {
    return c.html(`<h2>Gmail connect failed</h2><pre>${err.message || err}</pre><p><a href="/admin">Back to admin</a></p>`, 500);
  }
});

// Create a Gmail draft from a match suggestion / intro request.
// Body: { introRequestId } — pulls everything else from the DB + founder fields.
app.post('/api/agent/gmail/draft-intro', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const introRequestId = parseInt(body.introRequestId);
  if (!introRequestId || isNaN(introRequestId)) {
    return c.json({ error: 'introRequestId is required' }, 400);
  }

  const intro = await db.query.introRequests.findFirst({ where: eq(introRequests.id, introRequestId) });
  if (!intro) return c.json({ error: 'Intro request not found' }, 404);

  const founder = await db.query.founders.findFirst({ where: eq(founders.id, intro.founderId) });
  const investor = await db.query.investors.findFirst({ where: eq(investors.id, intro.investorId) });
  const node = await db.query.nodes.findFirst({ where: eq(nodes.id, intro.nodeId) });

  if (!founder || !investor) return c.json({ error: 'Missing founder or investor' }, 400);

  // Build the email — mirrors buildIntroDraft in admin.html.
  // When blurb is set, the blurb IS the entire email body (with variable
  // substitution). Fallback template only fires when no blurb is set.
  const investorFirst = (investor.name || '').split(/\s+/)[0] || 'there';
  const founderFirst = (founder.name || '').split(/\s+/)[0] || '';
  const companyName = founder.companyName || '';
  const stage = founder.companyStage ? String(founder.companyStage).replace(/_/g, ' ') : '';
  const nodeFirst = (node?.name || 'Mat').split(/\s+/)[0];
  const blurb = (founder.blurb || '').trim();
  const deckUrl = (founder.deckUrl || '').trim();
  const calendlyUrl = (founder.calendlyUrl || '').trim();

  const subject = companyName
    ? `Intro: ${founder.name} (${companyName}) <> ${investor.name}`
    : `Intro: ${founder.name} <> ${investor.name}`;

  const fillVars = (s: string) => s
    .replace(/\{\{investorFirst\}\}/g, investorFirst)
    .replace(/\{\{investorName\}\}/g, investor.name || '')
    .replace(/\{\{investorFirm\}\}/g, investor.firm || '')
    .replace(/\{\{founderFirst\}\}/g, founderFirst)
    .replace(/\{\{founderName\}\}/g, founder.name || '')
    .replace(/\{\{companyName\}\}/g, companyName);

  let bodyText: string;
  if (blurb) {
    bodyText = fillVars(blurb);
  } else {
    const lines: string[] = [];
    lines.push(`Hi ${investorFirst} —`);
    lines.push('');
    lines.push(`Want to intro you to ${founder.name}${companyName ? `, building ${companyName}` : ''}.`);
    if (stage) {
      lines.push('');
      lines.push(`They're raising a ${stage} round and I think they'd be a strong fit for your thesis.`);
    }
    if (deckUrl || calendlyUrl) {
      lines.push('');
      if (deckUrl) lines.push(`Deck: ${deckUrl}`);
      if (calendlyUrl) lines.push(`Book time: ${calendlyUrl}`);
    }
    lines.push('');
    lines.push(`${founderFirst || founder.name}, meet ${investorFirst}${investor.firm ? ` (${investor.role || 'investor'} at ${investor.firm})` : ''} — off to you both.`);
    lines.push('');
    lines.push(nodeFirst);
    bodyText = lines.join('\n');
  }

  // Locate the deck file on disk if uploaded
  let attachmentPath: string | undefined;
  let attachmentName: string | undefined;
  if (founder.deckFile) {
    const dataDir = process.env.DATA_DIR || (process.env.NODE_ENV === 'production' ? '/app/data' : '.');
    attachmentPath = `${dataDir}/decks/${founder.deckFile}`;
    attachmentName = `${companyName || founder.name} Deck.pdf`;
  }

  const { createDraft } = await import('./services/gmail.js');
  try {
    const result = await createDraft({
      to: investor.email || '',
      cc: founder.email || undefined,
      subject,
      body: bodyText,
      attachmentPath,
      attachmentName,
    });
    return c.json({ success: true, ...result, attached: !!attachmentPath });
  } catch (err: any) {
    return c.json({ error: err.message || 'Failed to create Gmail draft' }, 500);
  }
});

// Angel Club application (public, no auth)
app.post('/api/angel-club-apply', async (c) => {
  const body = await c.req.json();
  const { name, email, linkedin, firm, note } = body;

  if (!name || !email || !linkedin) {
    return c.json({ error: 'Name, email, and LinkedIn are required' }, 400);
  }

  // Notify Mat via email
  const { sendEmail } = await import('./services/email.js');
  await sendEmail({
    to: 'mat@matsherman.com',
    subject: `Angel Club Application: ${name}`,
    html: `
      <h2>New Angel Club Application</h2>
      <p><strong>Name:</strong> ${name}</p>
      <p><strong>Email:</strong> ${email}</p>
      <p><strong>LinkedIn:</strong> <a href="${linkedin}">${linkedin}</a></p>
      ${firm ? `<p><strong>Firm/Website:</strong> <a href="${firm}">${firm}</a></p>` : ''}
      ${note ? `<p><strong>Note:</strong> ${note}</p>` : ''}
    `,
    text: `New Angel Club Application\n\nName: ${name}\nEmail: ${email}\nLinkedIn: ${linkedin}${firm ? `\nFirm: ${firm}` : ''}${note ? `\nNote: ${note}` : ''}`,
  });

  return c.json({ success: true });
});

// Scout / YC application (public, no auth) — founders with an accelerator offer
// who want a market read before committing
app.post('/api/scout-apply', async (c) => {
  const body = await c.req.json();
  const { name, email, linkedin, company, oneLiner, accelerator, batch, stage, sector, note, source } = body;

  if (!name || !email || !linkedin || !company || !oneLiner || !accelerator || !stage || !sector) {
    return c.json({ error: 'Name, email, LinkedIn, company, one-liner, accelerator, stage, and sector are required' }, 400);
  }

  const { sendEmail } = await import('./services/email.js');
  await sendEmail({
    to: 'mat@matsherman.com',
    subject: `Scout application: ${name} — ${company} (${accelerator})`,
    html: `
      <h2>New Scout Application (${source || 'yc'})</h2>
      <p><strong>Accelerator:</strong> ${accelerator}${batch ? ` &mdash; ${batch}` : ''}</p>
      <p><strong>Name:</strong> ${name}</p>
      <p><strong>Email:</strong> ${email}</p>
      <p><strong>LinkedIn:</strong> <a href="${linkedin}">${linkedin}</a></p>
      <p><strong>Company:</strong> ${company}</p>
      <p><strong>One-liner:</strong> ${oneLiner}</p>
      <p><strong>Stage:</strong> ${stage}</p>
      <p><strong>Sector:</strong> ${sector}</p>
      ${note ? `<p><strong>Note:</strong> ${note}</p>` : ''}
    `,
    text: `New Scout Application (${source || 'yc'})\n\nAccelerator: ${accelerator}${batch ? ` — ${batch}` : ''}\nName: ${name}\nEmail: ${email}\nLinkedIn: ${linkedin}\nCompany: ${company}\nOne-liner: ${oneLiner}\nStage: ${stage}\nSector: ${sector}${note ? `\nNote: ${note}` : ''}`,
  });

  return c.json({ success: true });
});

// MatCap Community application (public, no auth)
app.post('/api/community-apply', async (c) => {
  const body = await c.req.json();
  const { name, email, linkedin, cityState, companyName, companyUrl, oneLiner, tier, note } = body;

  if (!name || !email || !linkedin || !cityState || !companyName || !oneLiner || !tier) {
    return c.json({ error: 'Name, email, LinkedIn, city/state, company, one-liner, and tier are required' }, 400);
  }

  const { sendEmail } = await import('./services/email.js');
  await sendEmail({
    to: 'mat@matsherman.com',
    subject: `Community Application: ${name} (${tier})`,
    html: `
      <h2>New MatCap Community Application</h2>
      <p><strong>Tier:</strong> ${tier}</p>
      <p><strong>Name:</strong> ${name}</p>
      <p><strong>Email:</strong> ${email}</p>
      <p><strong>LinkedIn:</strong> <a href="${linkedin}">${linkedin}</a></p>
      <p><strong>City / state:</strong> ${cityState}</p>
      <p><strong>Company:</strong> ${companyName}${companyUrl ? ` — <a href="${companyUrl}">${companyUrl}</a>` : ''}</p>
      <p><strong>One-liner:</strong> ${oneLiner}</p>
      ${note ? `<p><strong>Note:</strong> ${note}</p>` : ''}
    `,
    text: `New MatCap Community Application\n\nTier: ${tier}\nName: ${name}\nEmail: ${email}\nLinkedIn: ${linkedin}\nCity/state: ${cityState}\nCompany: ${companyName}${companyUrl ? ` (${companyUrl})` : ''}\nOne-liner: ${oneLiner}${note ? `\nNote: ${note}` : ''}`,
  });

  return c.json({ success: true });
});

// Temporary seed endpoint for Ben Ehrlich intro
app.post('/api/debug/seed-ben-intro', async (c) => {
  const now = new Date().toISOString();

  // Find or create Will Preble
  let founder = await db.query.founders.findFirst({
    where: eq(founders.name, 'Will Preble'),
  });

  if (!founder) {
    const [created] = await db.insert(founders).values({
      name: 'Will Preble',
      email: 'will@covenantlabs.com',
      companyName: 'Covenant Labs',
      companyStage: 'seed',
      roundStatus: 'pre_round',
      createdAt: now,
    }).returning();
    founder = created;
  }

  // Find Ben Ehrlich
  const benNode = await db.query.nodes.findFirst({
    where: eq(nodes.name, 'Ben Ehrlich'),
  });

  if (!benNode) {
    return c.json({ error: 'Ben Ehrlich not found' }, 404);
  }

  // Find Zoe Weinberg
  const zoe = await db.query.investors.findFirst({
    where: eq(investors.name, 'Zoe Weinberg'),
  });

  if (!zoe) {
    return c.json({ error: 'Zoe Weinberg not found' }, 404);
  }

  // Create founder-node relationship if not exists
  const existingFnRel = await db.query.founderNodeRelationships.findFirst({
    where: eq(founderNodeRelationships.founderId, founder.id),
  });

  if (!existingFnRel || existingFnRel.nodeId !== benNode.id) {
    await db.insert(founderNodeRelationships).values({
      founderId: founder.id,
      nodeId: benNode.id,
      relationshipStrength: 'medium',
      howConnected: 'referred',
      createdAt: now,
    });
  }

  // Create intro request
  const [intro] = await db.insert(introRequests).values({
    founderId: founder.id,
    nodeId: benNode.id,
    investorId: zoe.id,
    status: 'introduced',
    dateRequested: '2025-01-02',
    dateIntroduced: '2025-01-02',
    createdAt: now,
    updatedAt: now,
  }).returning();

  return c.json({
    success: true,
    intro: {
      id: intro.id,
      founder: founder.name,
      node: benNode.name,
      investor: zoe.name,
      status: intro.status,
      dateIntroduced: intro.dateIntroduced,
    },
  });
});

// Temporary seed endpoint for Ben Ehrlich's investors
app.post('/api/debug/seed-ben-investors', async (c) => {
  // Find Ben Ehrlich's node ID
  const benNode = await db.query.nodes.findFirst({
    where: eq(nodes.name, 'Ben Ehrlich'),
  });

  if (!benNode) {
    return c.json({ error: 'Ben Ehrlich node not found' }, 404);
  }

  const investorsToAdd = [
    { name: 'Zoe Weinberg', firm: 'ex/ante' },
    { name: 'Nick Fitz', firm: 'Juniper Ventures' },
    { name: 'Griff Bohm', firm: 'Juniper Ventures' },
    { name: 'Arkady Kulik', firm: 'Arkane Capital' },
  ];

  const results = [];
  const now = new Date().toISOString();

  for (const inv of investorsToAdd) {
    // Check if investor already exists
    let investor = await db.query.investors.findFirst({
      where: eq(investors.name, inv.name),
    });

    if (!investor) {
      // Create investor
      const [created] = await db.insert(investors).values({
        name: inv.name,
        firm: inv.firm,
        createdAt: now,
      }).returning();
      investor = created;
      results.push({ action: 'created', investor: inv.name });
    } else {
      results.push({ action: 'exists', investor: inv.name });
    }

    // Check if connection already exists
    const allBenConns = await db.query.nodeInvestorConnections.findMany({
      where: eq(nodeInvestorConnections.nodeId, benNode.id),
    });
    const connExists = allBenConns.some(c => c.investorId === investor.id);

    if (!connExists) {
      // Create connection
      await db.insert(nodeInvestorConnections).values({
        nodeId: benNode.id,
        investorId: investor.id,
        connectionStrength: 'medium',
        addedBy: 'admin',
        validated: false,
        createdAt: now,
      });
      results.push({ action: 'connected', investor: inv.name, nodeId: benNode.id });
    }
  }

  return c.json({ success: true, benNodeId: benNode.id, results });
});

// Temporary debug endpoint for node stats (public)
app.get('/api/debug/node-stats', async (c) => {
  const allNodes = await db.select().from(nodes);
  const stats = [];

  for (const node of allNodes) {
    const connections = await db.query.nodeInvestorConnections.findMany({
      where: eq(nodeInvestorConnections.nodeId, node.id),
    });
    const intros = await db.query.introRequests.findMany({
      where: eq(introRequests.nodeId, node.id),
    });

    // Count by status
    const byStatus: Record<string, number> = {};
    for (const intro of intros) {
      byStatus[intro.status] = (byStatus[intro.status] || 0) + 1;
    }

    // Intro request accept rate = intros that were actually made / total requests
    // Accepted = statuses that indicate the node agreed to make the intro
    const acceptedStatuses = ['introduced', 'meeting_scheduled', 'in_discussions', 'invested'];
    const acceptedIntros = intros.filter(i => acceptedStatuses.includes(i.status)).length;

    // Pending = still waiting on node decision
    const pendingStatuses = ['intro_request_sent', 'waiting_on_node'];
    const pendingIntros = intros.filter(i => pendingStatuses.includes(i.status)).length;

    // Declined/passed/ignored
    const passedIntros = intros.filter(i => i.status === 'passed').length;
    const ignoredIntros = intros.filter(i => i.status === 'ignored').length;

    // Accept rate = accepted / (accepted + passed + ignored) - excludes pending
    const decidedIntros = acceptedIntros + passedIntros + ignoredIntros;

    stats.push({
      node: node.name,
      network: {
        total: connections.length,
        strong: connections.filter(c => c.connectionStrength === 'strong').length,
        medium: connections.filter(c => c.connectionStrength === 'medium').length,
        weak: connections.filter(c => c.connectionStrength === 'weak').length,
      },
      intros: {
        total: intros.length,
        byStatus,
        accepted: acceptedIntros,
        pending: pendingIntros,
        passed: passedIntros,
        ignored: ignoredIntros,
        acceptRate: decidedIntros > 0 ? Math.round((acceptedIntros / decidedIntros) * 100) + '%' : 'N/A',
      },
    });
  }

  return c.json(stats);
});

// Explicit route for founder portal
app.get('/founder', serveStatic({ path: './public/founder.html' }));

// Explicit route for founder onboarding (conversational intake)
app.get('/onboarding', serveStatic({ path: './public/onboarding.html' }));

// Public network pages
app.get('/signup', serveStatic({ path: './public/signup.html' }));
app.get('/dashboard', serveStatic({ path: './public/dashboard.html' }));

// Voice interview (public, token-based)
app.get('/voice-interview', serveStatic({ path: './public/voice-interview.html' }));

// Blurb builder
app.get('/blurb', serveStatic({ path: './public/blurb.html' }));
app.get('/trial', serveStatic({ path: './public/trial.html' }));

// Marketing site
app.get('/welcome', serveStatic({ path: './public/welcome.html' }));
app.get('/founders', (c) => c.redirect('/signup', 302));
app.get('/investors', (c) => c.redirect('/angel-club', 302));
app.get('/nodes', serveStatic({ path: './public/nodes.html' }));
app.get('/angel-club', serveStatic({ path: './public/angel-club.html' }));
app.get('/yc', serveStatic({ path: './public/yc.html' }));
app.get('/scout', (c) => c.redirect('/yc', 302));
app.get('/retreats/7', serveStatic({ path: './public/retreats/7/index.html' }));
app.get('/retreats/7/sponsor', serveStatic({ path: './public/retreats/7/sponsor.html' }));
app.get('/project2045', serveStatic({ path: './public/project2045.html' }));
app.get('/community', serveStatic({ path: './public/community.html' }));
app.get('/intros', serveStatic({ path: './public/intros.html' }));
app.get('/case-studies', serveStatic({ path: './public/case-studies.html' }));
app.get('/case-studies/rosotics', serveStatic({ path: './public/case-studies/rosotics.html' }));
app.get('/case-studies/autio', serveStatic({ path: './public/case-studies/autio.html' }));
app.get('/case-studies/peachpay', serveStatic({ path: './public/case-studies/peachpay.html' }));
app.get('/case-studies/insured-nomads', serveStatic({ path: './public/case-studies/insured-nomads.html' }));
app.get('/case-studies/breathe-ev', (c) => c.redirect('/case-studies', 301));
app.get('/case-studies/othersideai', serveStatic({ path: './public/case-studies/othersideai.html' }));
app.get('/case-studies/kalendar-ai', serveStatic({ path: './public/case-studies/kalendar-ai.html' }));
app.get('/case-studies/stealth-vertical-ai', serveStatic({ path: './public/case-studies/stealth-vertical-ai.html' }));
app.get('/case-studies/stealth-proptech', serveStatic({ path: './public/case-studies/stealth-proptech.html' }));

// Admin dashboard - serve with no-cache headers to prevent proxy caching
const serveAdminHtml = async (c: any) => {
  const fs = await import('fs');
  const html = fs.readFileSync('./public/admin.html', 'utf-8');
  c.header('Cache-Control', 'no-store, no-cache, must-revalidate');
  c.header('Pragma', 'no-cache');
  c.header('Expires', '0');
  return c.html(html);
};
app.get('/admin', serveAdminHtml);
app.get('/admin2', serveAdminHtml);
app.get('/admin-fresh', serveAdminHtml);

// Serve static files from public directory
app.use('/*', serveStatic({ root: './public' }));

// Fallback to landing page
app.get('*', serveStatic({ path: './public/index.html' }));

const port = parseInt(process.env.PORT || '3000');
console.log(`NodeStacker server running on http://localhost:${port}`);

// Schedule weekly digest emails
// Friday 5pm Arizona (MST/UTC-7) = Saturday 00:00 UTC
// Cron: minute hour day month weekday
cron.schedule('0 0 * * 6', async () => {
  console.log('[CRON] Running weekly digest job...');
  try {
    const result = await sendWeeklyDigests();
    console.log('[CRON] Weekly digest complete:', result);
  } catch (err) {
    console.error('[CRON] Weekly digest failed:', err);
  }
}, {
  timezone: 'UTC'
});

console.log('[CRON] Weekly digest scheduled for Saturday 00:00 UTC (Friday 5pm Arizona)');

// Schedule admin preview email — 1 hour before the digest
// Friday 4pm Arizona = Friday 23:00 UTC
cron.schedule('0 23 * * 5', async () => {
  console.log('[CRON] Sending digest preview to admin...');
  try {
    const result = await sendDigestPreviewToAdmin();
    console.log('[CRON] Digest preview complete:', result);
  } catch (err) {
    console.error('[CRON] Digest preview failed:', err);
  }
}, {
  timezone: 'UTC'
});

console.log('[CRON] Digest preview scheduled for Friday 23:00 UTC (4pm Arizona, 1 hour before digest)');

// Shadow agent — generates match suggestions and emails admin a digest.
// Phase 1: visibility only. Nothing is sent autonomously; admin still approves
// each suggestion in the matching tab.
// Monday + Thursday 16:00 UTC = 9am Arizona — start of week + mid-week
cron.schedule('0 16 * * 1,4', async () => {
  console.log('[CRON] Running shadow agent tick...');
  try {
    const { runAgentTick } = await import('./services/agent.js');
    const result = await runAgentTick();
    console.log('[CRON] Agent tick complete:', result);
  } catch (err) {
    console.error('[CRON] Agent tick failed:', err);
  }
}, {
  timezone: 'UTC'
});

console.log('[CRON] Shadow agent scheduled for Mon + Thu 16:00 UTC (9am Arizona)');

// Auto-draft tick — picks ONE high-score pending suggestion per day and creates
// a Gmail draft. Status stays pending_suggestion. Admin reviews + sends from
// Gmail, then clicks "Mark as sent" in admin.
// 10am Arizona = 17:00 UTC. After the shadow-agent's 9am suggestion run so the
// queue is fresh.
cron.schedule('0 17 * * *', async () => {
  console.log('[CRON] Running auto-draft tick...');
  try {
    const { runAutoDraftTick } = await import('./services/agent.js');
    const result = await runAutoDraftTick();
    console.log('[CRON] Auto-draft tick result:', result);
  } catch (err) {
    console.error('[CRON] Auto-draft tick failed:', err);
  }
}, {
  timezone: 'UTC'
});

console.log('[CRON] Auto-draft scheduled for daily 17:00 UTC (10am Arizona)');

serve({
  fetch: app.fetch,
  port,
  hostname: '0.0.0.0',
});
