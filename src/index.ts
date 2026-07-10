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
import docsOnboardingRoutes from './api/docs-onboarding.js';
import portalCrmRoutes from './api/portal-crm.js';
import peopleCapturesRoutes from './api/people-captures.js';
import adminPeopleRoutes from './api/admin-people.js';
import investorResearchRoutes from './api/investor-research.js';
import portfolioRoutes from './api/portfolio.js';
import broadcastRoutes from './api/broadcast.js';
import trialsRoutes from './api/trials.js';
import trialDeckRoutes from './api/trial-deck.js';
import adminAuthRoutes from './api/admin-auth.js';
import inboundRoutes from './api/inbound.js';
import onboardingRoutes from './api/onboarding.js';
import onboardingChatRoutes from './api/onboarding-chat.js';
import webhooksRoutes from './api/webhooks.js';
import granolaRoutes from './api/granola.js';
import commsApproveRoutes from './api/comms-approve.js';
import investorCandidatesRoutes from './api/investor-candidates.js';
import weeklyDigestRoutes from './api/weekly-digest.js';
import publicAuthRoutes from './api/public-auth.js';
import publicProfileRoutes from './api/public-profile.js';
import publicCompaniesRoutes from './api/public-companies.js';
import publicIntrosRoutes from './api/public-intros.js';
import publicPortfolioRoutes from './api/public-portfolio.js';
import publicDensityRoutes from './api/public-density.js';
import publicInvestorMatchRoutes from './api/public-investor-match.js';
import categoriesRoutes from './api/categories.js';
import matchingRoutes from './api/matching.js';
import marketplaceHealthRoutes from './api/marketplace-health.js';
import signupsRoutes from './api/signups.js';
import voiceInterviewsRoutes from './api/voice-interviews.js';
import blurbRoutes from './api/blurb.js';
import instantlyRoutes from './api/instantly.js';
import brandsRoutes from './api/brands.js';
import agentActionsRoutes from './api/agent-actions.js';
import mockCallAnalysisRoutes from './api/mock-call-analysis.js';
import gymRoutes from './api/gym.js';
import mcpRoutes from './api/mcp.js';
import mcpTokensRoutes from './api/mcp-tokens-routes.js';
import mcpRpcRoutes from './api/mcp-rpc.js';
import { sendWeeklyDigests, sendDigestPreviewToAdmin } from './services/weekly-digest.js';
import { withCronRun } from './services/cron-log.js';
import { adminGuard } from './api/middleware/admin-guard.js';
import { eq, and, or, inArray, isNull, sql } from 'drizzle-orm';
import { db, nodes, investors, founders, nodeInvestorConnections, founderNodeRelationships, introRequests } from './db/index.js';
import { desc } from 'drizzle-orm';

const app = new Hono();

// Liveness/readiness probe — fast, no DB, no auth. Fly's health check hits this
// so the proxy only routes once the app is actually listening (and waits for it
// on deploy), instead of blindly retrying a not-yet-bound instance.
app.get('/health', (c) => c.text('ok'));

// Middleware
app.use('*', logger());
app.use('/api/*', cors());

// Public API Routes (no auth required)
app.route('/api/admin-auth', adminAuthRoutes);
app.route('/api/auth', authRoutes);
app.route('/api/portal', founderPortalRoutes);
// Docs-first onboarding: already-incorporated companies upload formation docs
// (AOC + bylaws + initial board consent), we extract variables, founder confirms.
app.route('/api/portal/docs', docsOnboardingRoutes);
// Founder-private CRM: investor pipeline + self-added records + interaction logs.
// All routes scoped to the logged-in founder; no admin endpoint reads any of these.
app.route('/api/portal/crm', portalCrmRoutes);
// MCP token management — session-authed (founder mints/revokes their own tokens)
app.route('/api/portal/mcp-tokens', mcpTokensRoutes);
// MCP pipeline API — Bearer-token authed (the legacy local connector calls these).
app.route('/api/mcp', mcpRoutes);
// Remote MCP server — hosted Streamable-HTTP endpoint clients connect to directly
// (Cursor via URL+header, Claude Desktop via mcp-remote). Bearer-token auth inside.
app.route('/mcp', mcpRpcRoutes);
// Public lead-magnet capture — any standalone tool/page posts here to land
// an email in the unified people directory. No auth.
app.route('/api/people-captures', peopleCapturesRoutes);
// Admin unified People view (PR 2) — union of founders + signups + leads + captures
app.route('/api/admin/people', adminPeopleRoutes);
// Public network signup/login (separate from founder auth)
app.route('/api/public', publicAuthRoutes);
app.route('/api/public', publicProfileRoutes);
app.route('/api/public/companies', publicCompaniesRoutes);
app.route('/api/public/intros', publicIntrosRoutes);
app.route('/api/public/portfolio', publicPortfolioRoutes);
// Aggregated founder/user city counts for /expand map. Public.
app.route('/api/public/density', publicDensityRoutes);
// Investor matcher — public lead magnet. Takes founder profile, returns top
// 10 investors by category fit; captures the profile into people_captures.
app.route('/api/public/investor-match', publicInvestorMatchRoutes);
// Onboarding chat is public (founder intake interview)
// Admin endpoints (/leads, /leads/:id/convert) are protected below
app.route('/api/onboarding-chat', onboardingChatRoutes);
// Blurb builder is public (founder self-service)
app.route('/api/blurb', blurbRoutes);
// Trial deck upload is public — founders on /trial submit a deck by email
app.route('/api/trial-deck', trialDeckRoutes);
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
app.use('/api/investor-candidates', adminGuard);
app.use('/api/investor-candidates/*', adminGuard);
app.use('/api/intro-requests', adminGuard);
app.use('/api/intro-requests/*', adminGuard);
app.use('/api/relationships', adminGuard);
app.use('/api/relationships/*', adminGuard);
app.use('/api/digest', adminGuard);
app.use('/api/digest/*', adminGuard);
app.use('/api/portfolio', adminGuard);
app.use('/api/portfolio/*', adminGuard);
// Broadcast email to all portfolio founders — admin-only
app.use('/api/broadcast', adminGuard);
app.use('/api/broadcast/*', adminGuard);
// Trials — admin-only management of the 2-week audition stage
app.use('/api/trials', adminGuard);
app.use('/api/trials/*', adminGuard);
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
// Admin unified People view (CRM directory) — admin-only.
app.use('/api/admin/people', adminGuard);
app.use('/api/admin/people/*', adminGuard);
// Weekly digest - preview requires admin, send allows token auth for cron
app.use('/api/weekly-digest/preview/*', adminGuard);
app.use('/api/weekly-digest/preview-admin', adminGuard);
app.use('/api/weekly-digest/cron-runs', adminGuard);
// Shadow agent — admin-only manual trigger
app.use('/api/agent/*', adminGuard);
// Agent actions ledger / approval queue — admin-only
app.use('/api/agent-actions', adminGuard);
app.use('/api/agent-actions/*', adminGuard);
// Mock VC call analyzer — admin-only (transcripts are sensitive founder prep)
app.use('/api/mock-call-analysis', adminGuard);
app.use('/api/mock-call-analysis/*', adminGuard);

app.route('/api/categories', categoriesRoutes);
app.route('/api/founders', foundersRoutes);
app.route('/api/nodes', nodesRoutes);
app.route('/api/investors', investorsRoutes);
app.route('/api/investors', investorResearchRoutes);
app.route('/api/intro-requests', introRequestsRoutes);
app.route('/api/relationships', relationshipsRoutes);
app.route('/api/digest', digestRoutes);
app.route('/api/portfolio', portfolioRoutes);
app.route('/api/broadcast', broadcastRoutes);
app.route('/api/trials', trialsRoutes);
app.route('/api/inbound', inboundRoutes);
app.route('/api/onboarding', onboardingRoutes);
app.route('/api/webhooks', webhooksRoutes);
app.route('/api/granola', granolaRoutes);
app.route('/comms/approve', commsApproveRoutes);
app.route('/api/matching', matchingRoutes);
app.route('/api/investor-candidates', investorCandidatesRoutes);
app.route('/api/marketplace-health', marketplaceHealthRoutes);
app.route('/api/signups', signupsRoutes);
app.route('/api/weekly-digest', weeklyDigestRoutes);
app.route('/api/instantly', instantlyRoutes);
app.route('/api/brands', brandsRoutes);
app.route('/api/agent-actions', agentActionsRoutes);
app.route('/api/mock-call-analysis', mockCallAnalysisRoutes);
// Pitch Gym — founder-facing (own session auth inside the route), not admin-guarded
app.route('/api/gym', gymRoutes);
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

// Pending-review digest — email the admin the count of intro requests awaiting
// approve/reject in the dashboard (no Gmail drafts).
app.post('/api/agent/pending-digest-now', async (c) => {
  const { runPendingDigestTick } = await import('./services/agent.js');
  const result = await runPendingDigestTick();
  return c.json(result);
});

// Follow-up agent — for every sent intro with no reply in 7+ days, create a
// short bump draft in the same Gmail thread (up to 2 bumps per intro).
app.post('/api/agent/followup-now', async (c) => {
  const { runFollowupTick } = await import('./services/agent.js');
  const result = await runFollowupTick();
  return c.json(result);
});

// One-shot: re-run the (now investor-scoped) reply check against every intro
// where replyDetectedAt is set. If the new check says the investor never
// actually replied, clear replyDetectedAt so the follow-up agent picks the
// intro back up. Used to recover from the node-as-reply false positives that
// existed before the gmail.ts fix.
app.post('/api/agent/recheck-replies', async (c) => {
  const { recheckReplyDetections } = await import('./services/agent.js');
  const result = await recheckReplyDetections();
  return c.json(result);
});

// List every intro where the investor hasn't replied yet, bucketed by age
// (polite / close-loop), oldest first. Drives the "Awaiting reply" panel.
app.get('/api/agent/pending-replies', async (c) => {
  const { getPendingReplies } = await import('./services/agent.js');
  const result = await getPendingReplies();
  return c.json(result);
});

// Draft a single follow-up bump for one intro. Picks the template by age,
// returns the Gmail draft URL so the admin lands on the draft in one click.
app.post('/api/agent/followup-one/:id', async (c) => {
  const id = parseInt(c.req.param('id'));
  if (!Number.isFinite(id)) return c.json({ ok: false, error: 'bad intro id' }, 400);
  const { draftFollowupForIntro } = await import('./services/agent.js');
  const result = await draftFollowupForIntro(id);
  return c.json(result);
});

// Reply classifier — runs the LLM over investor replies and applies the
// status transitions. Wraps with withCronRun for the cron path; admin can
// also trigger manually.
app.post('/api/agent/classify-replies-now', async (c) => {
  const { runReplyClassifierTick } = await import('./services/reply-classifier.js');
  const { withCronRun } = await import('./services/cron-log.js');
  const result = await withCronRun('reply_classifier', () => runReplyClassifierTick());
  return c.json(result);
});

app.get('/api/agent/replies-needing-human', async (c) => {
  const { getRepliesNeedingHuman } = await import('./services/reply-classifier.js');
  const result = await getRepliesNeedingHuman();
  return c.json(result);
});

// Backfill: auto-reply + archive passes that were classified before the
// quote-stripping fix and so never got an acknowledgement.
app.post('/api/agent/ack-passes-now', async (c) => {
  const { runPassAckBackfill } = await import('./services/reply-classifier.js');
  const result = await runPassAckBackfill();
  return c.json(result);
});

// Agent settings — kill switches + thresholds for autonomous behaviors.
// Today exposes the handoff auto-send flag; future autonomous flags go here.
app.get('/api/agent/settings', async (c) => {
  const { db, agentSettings } = await import('./db/index.js');
  const { eq } = await import('drizzle-orm');
  let row = await db.query.agentSettings.findFirst({ where: eq(agentSettings.id, 1) });
  if (!row) {
    await db.insert(agentSettings).values({ id: 1 });
    row = await db.query.agentSettings.findFirst({ where: eq(agentSettings.id, 1) });
  }
  return c.json(row);
});

app.put('/api/agent/settings', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { db, agentSettings } = await import('./db/index.js');
  const { eq } = await import('drizzle-orm');
  const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (typeof body.autoSendHandoff === 'boolean') patch.autoSendHandoff = body.autoSendHandoff;
  if (typeof body.autoSendHandoffMinConfidence === 'number') {
    const v = Math.max(0, Math.min(1, body.autoSendHandoffMinConfidence));
    patch.autoSendHandoffMinConfidence = String(v);
  }
  if (typeof body.autoSendHandoffMaxReplyChars === 'number') {
    patch.autoSendHandoffMaxReplyChars = Math.max(50, Math.min(2000, Math.floor(body.autoSendHandoffMaxReplyChars)));
  }
  if (typeof body.autoReplyToPass === 'boolean') patch.autoReplyToPass = body.autoReplyToPass;
  if (typeof body.autoReplyToPassMaxReplyChars === 'number') {
    patch.autoReplyToPassMaxReplyChars = Math.max(100, Math.min(5000, Math.floor(body.autoReplyToPassMaxReplyChars)));
  }
  if (typeof body.autoSendFollowups === 'boolean') patch.autoSendFollowups = body.autoSendFollowups;
  // Upsert (id=1 singleton)
  const existing = await db.query.agentSettings.findFirst({ where: eq(agentSettings.id, 1) });
  if (existing) {
    await db.update(agentSettings).set(patch).where(eq(agentSettings.id, 1));
  } else {
    await db.insert(agentSettings).values({ id: 1, ...patch });
  }
  const row = await db.query.agentSettings.findFirst({ where: eq(agentSettings.id, 1) });
  return c.json(row);
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
  const { matchSuggestions, followupLogs } = await import('./db/index.js');
  const pending = await db.select({
    id: matchSuggestions.id,
    introRequestId: matchSuggestions.introRequestId,
  }).from(matchSuggestions).where(eq(matchSuggestions.status, 'pending'));

  const introIds = pending.map(p => p.introRequestId).filter((x): x is number => x != null);

  // Order matters because of FK constraints:
  // 1. followup_logs.intro_request_id is NOT NULL → must clear before deleting intros
  // 2. match_suggestions.intro_request_id references intros → clear before deleting intros
  // 3. then delete the intro_requests themselves
  let deletedFollowups = 0;
  let deletedSuggestions = 0;
  let deletedIntros = 0;

  if (introIds.length > 0) {
    const followupResult = await db.delete(followupLogs)
      .where(inArray(followupLogs.introRequestId, introIds)).returning();
    deletedFollowups = followupResult.length;
  }

  const suggResult = await db.delete(matchSuggestions)
    .where(eq(matchSuggestions.status, 'pending')).returning();
  deletedSuggestions = suggResult.length;

  if (introIds.length > 0) {
    const introResult = await db.delete(introRequests)
      .where(and(
        eq(introRequests.status, 'pending_suggestion'),
        inArray(introRequests.id, introIds),
      )).returning();
    deletedIntros = introResult.length;
  }

  return c.json({ deletedSuggestions, deletedIntros, deletedFollowups });
});

// Backfill default Pre-seed + Seed stage tags onto any founder that currently
// has zero stage assignments. Matches the auto-assignment in POST /api/founders,
// applied retroactively. Idempotent — re-running has no effect on already-tagged.
app.post('/api/agent/backfill-founder-stages', async (c) => {
  const { founderCategoryAssignments, investorCategories } = await import('./db/index.js');
  const stageCats = await db.select({ id: investorCategories.id, name: investorCategories.name })
    .from(investorCategories)
    .where(eq(investorCategories.type, 'stage'));
  const defaultStageNames = new Set(['pre-seed', 'preseed', 'seed']);
  const defaultStages = stageCats.filter(s => defaultStageNames.has(s.name.toLowerCase()));
  if (defaultStages.length === 0) {
    return c.json({ error: 'No Pre-seed or Seed categories found in DB' }, 400);
  }
  const allStageIds = new Set(stageCats.map(s => s.id));

  const allFounders = await db.select({ id: founders.id, name: founders.name }).from(founders);
  const assignments = await db.select().from(founderCategoryAssignments);
  const stageByFounder = new Map<number, Set<number>>();
  for (const a of assignments) {
    if (!allStageIds.has(a.categoryId)) continue;
    if (!stageByFounder.has(a.founderId)) stageByFounder.set(a.founderId, new Set());
    stageByFounder.get(a.founderId)!.add(a.categoryId);
  }

  const filled: Array<{ id: number; name: string }> = [];
  for (const f of allFounders) {
    if ((stageByFounder.get(f.id)?.size || 0) > 0) continue;
    for (const stage of defaultStages) {
      await db.insert(founderCategoryAssignments)
        .values({ founderId: f.id, categoryId: stage.id })
        .onConflictDoNothing();
    }
    filled.push({ id: f.id, name: f.name });
  }

  return c.json({
    candidates: allFounders.length,
    updated: filled.length,
    sampleFilled: filled.slice(0, 20),
    stagesAssigned: defaultStages.map(s => s.name),
  });
});

// Backfill investor emails from inbound_intro_logs. For each investor lacking
// an email, find the most recent inbound_intro_logs row where detectedInvestorId
// matches and copy from_email onto the investor record.
app.post('/api/agent/backfill-investor-emails', async (c) => {
  const { inboundIntroLogs } = await import('./db/index.js');
  // First: revert any prior bad backfills where the email is a known admin/node
  // address. inbound_intro_logs stores from_email for BOTH inbound and outbound
  // threads, so an earlier sweep stamped Mat's own address onto investors who
  // had only ever been mailed BY him, never replied.
  const adminAddresses = [
    'mat@matsherman.com', 'mat@matcap.vc',
    process.env.ADMIN_EMAIL || '',
  ].filter(Boolean).map(s => s.toLowerCase());
  await db.update(investors).set({ email: null })
    .where(inArray(investors.email, adminAddresses));

  // Also load node emails to skip — any address belonging to a node is "us"
  const nodeRows = await db.select({ email: nodes.email }).from(nodes);
  const nodeEmails = new Set(nodeRows.map(n => (n.email || '').toLowerCase()).filter(Boolean));
  const skipAddresses = new Set([...adminAddresses, ...nodeEmails]);

  const missing = await db.select({ id: investors.id, name: investors.name })
    .from(investors)
    .where(or(isNull(investors.email), eq(investors.email, '')));

  let updated = 0;
  const filled: Array<{ id: number; name: string; email: string }> = [];
  for (const inv of missing) {
    // Pull ALL inbound from_email values for this investor and pick the first
    // one that ISN'T an admin/node address. The investor's real reply address
    // appears once they've actually responded.
    const logs = await db.select({ fromEmail: inboundIntroLogs.fromEmail })
      .from(inboundIntroLogs)
      .where(and(
        eq(inboundIntroLogs.detectedInvestorId, inv.id),
        sql`${inboundIntroLogs.fromEmail} IS NOT NULL AND ${inboundIntroLogs.fromEmail} != ''`,
      ))
      .orderBy(desc(inboundIntroLogs.createdAt));
    let chosen: string | null = null;
    for (const log of logs) {
      const candidate = (log.fromEmail || '').trim().toLowerCase();
      if (!candidate || !candidate.includes('@')) continue;
      if (skipAddresses.has(candidate)) continue;
      chosen = candidate;
      break;
    }
    if (!chosen) continue;
    await db.update(investors).set({ email: chosen }).where(eq(investors.id, inv.id));
    filled.push({ id: inv.id, name: inv.name, email: chosen });
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
  // Optional overrides: when the admin edits subject/body/to in the draft
  // modal before clicking "Create Gmail draft" or "Send now", these come
  // through verbatim. Without them the server builds from founder.blurb.
  const subjectOverride: string | undefined = body.subjectOverride;
  const bodyOverride: string | undefined = body.bodyOverride;
  const toOverride: string | undefined = body.toOverride;
  // sendNow=true: skip draft, send the message directly + flip status to
  // intro_request_sent + mark match_suggestion approved in one step.
  const sendNow: boolean = !!body.sendNow;

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

  // Stage 1 — the ask: subject is the company; body is the founder's blurb.
  const subject = companyName || founder.name;

  // {{investorName}} / {{founderName}} default to first name (matches gmail.ts).
  const fillVars = (s: string) => s
    .replace(/\{\{investorFirst\}\}/g, investorFirst)
    .replace(/\{\{investorFull\}\}/g, investor.name || '')
    .replace(/\{\{investorName\}\}/g, investorFirst)
    .replace(/\{\{investorFirm\}\}/g, investor.firm || '')
    .replace(/\{\{founderFirst\}\}/g, founderFirst)
    .replace(/\{\{founderFull\}\}/g, founder.name || '')
    .replace(/\{\{founderName\}\}/g, founderFirst)
    .replace(/\{\{companyName\}\}/g, companyName);

  // The founder's blurb is the forwardable ask. Fallback to a short ask if unset.
  let bodyText: string;
  if (blurb) {
    bodyText = fillVars(blurb);
  } else {
    const lines: string[] = [];
    lines.push(`Hi ${investorFirst} —`);
    lines.push('');
    lines.push(`Wanted to see if you'd be open to meeting ${founder.name}${companyName ? `, founder of ${companyName}` : ''}.`);
    if (stage) lines.push(`They're raising a ${stage} round.`);
    lines.push('');
    lines.push('Want me to make the intro?');
    lines.push('');
    lines.push(nodeFirst);
    bodyText = lines.join('\n');
  }

  // Stage 1 (the ask) carries the founder's deck if one's uploaded. The stage-2
  // connection email (founder <> investor) never attaches it.
  let attachmentPath: string | undefined;
  let attachmentName: string | undefined;
  if (founder.deckFile) {
    const dataDir = process.env.DATA_DIR || (process.env.NODE_ENV === 'production' ? '/app/data' : '.');
    attachmentPath = `${dataDir}/decks/${founder.deckFile}`;
    attachmentName = `${companyName || founder.name} Deck.pdf`;
  }

  // Admin overrides win — edits made in the draft modal land in the Gmail draft.
  const finalSubject = (subjectOverride != null && subjectOverride.trim()) ? subjectOverride : subject;
  const finalBody = (bodyOverride != null && bodyOverride.trim()) ? bodyOverride : bodyText;
  const finalTo = (toOverride != null && toOverride.trim()) ? toOverride : (investor.email || '');

  if (sendNow) {
    const { sendGmail } = await import('./services/gmail.js');
    try {
      const sent = await sendGmail({
        to: finalTo,
        subject: finalSubject,
        body: finalBody,
        attachmentPath,
        attachmentName,
      });
      const now = new Date().toISOString();
      await db.update(introRequests).set({
        status: 'intro_request_sent',
        dateRequested: now.split('T')[0],
        gmailThreadId: sent.threadId || null,
        updatedAt: now,
      }).where(eq(introRequests.id, intro.id));
      const { matchSuggestions } = await import('./db/index.js');
      await db.update(matchSuggestions)
        .set({ status: 'approved', reviewedAt: now })
        .where(eq(matchSuggestions.introRequestId, intro.id));
      return c.json({ success: true, sent: true, ...sent, attached: !!attachmentPath });
    } catch (err: any) {
      return c.json({ error: err.message || 'Failed to send via Gmail' }, 500);
    }
  }

  const { createDraft } = await import('./services/gmail.js');
  try {
    const result = await createDraft({
      to: finalTo,
      subject: finalSubject,
      body: finalBody,
      attachmentPath,
      attachmentName,
    });
    return c.json({ success: true, sent: false, ...result, attached: !!attachmentPath });
  } catch (err: any) {
    return c.json({ error: err.message || 'Failed to create Gmail draft' }, 500);
  }
});

// Investor Network application (public, no auth)
app.post('/api/investors-apply', async (c) => {
  const body = await c.req.json();
  const { name, email, linkedin, firm, note } = body;

  if (!name || !email || !linkedin) {
    return c.json({ error: 'Name, email, and LinkedIn are required' }, 400);
  }

  // Notify Mat via email
  const { sendEmail } = await import('./services/email.js');
  await sendEmail({
    to: 'mat@matsherman.com',
    subject: `Investor Network Application: ${name}`,
    html: `
      <h2>New Investor Network Application</h2>
      <p><strong>Name:</strong> ${name}</p>
      <p><strong>Email:</strong> ${email}</p>
      <p><strong>LinkedIn:</strong> <a href="${linkedin}">${linkedin}</a></p>
      ${firm ? `<p><strong>Firm/Website:</strong> <a href="${firm}">${firm}</a></p>` : ''}
      ${note ? `<p><strong>Note:</strong> ${note}</p>` : ''}
    `,
    text: `New Investor Network Application\n\nName: ${name}\nEmail: ${email}\nLinkedIn: ${linkedin}${firm ? `\nFirm: ${firm}` : ''}${note ? `\nNote: ${note}` : ''}`,
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
app.get('/how-it-works', (c) => c.redirect('/trial', 301));
// Founder-facing explainer: the Treadmill model of how MatCap works.
app.get('/treadmill', serveStatic({ path: './public/treadmill.html' }));

// Marketing site
app.get('/founders', (c) => c.redirect('/signup', 302));
app.get('/investors', serveStatic({ path: './public/investors.html' }));
app.get('/crm', serveStatic({ path: './public/crm.html' }));
app.get('/grant-pools', serveStatic({ path: './public/grant-pools.html' }));
app.get('/nodes', serveStatic({ path: './public/nodes.html' }));
app.get('/angel-club', (c) => c.redirect('/investors', 302));
app.get('/yc', serveStatic({ path: './public/yc.html' }));
app.get('/scout', (c) => c.redirect('/yc', 302));
app.get('/retreats/7', serveStatic({ path: './public/retreats/7/index.html' }));
app.get('/retreats/7/sponsor', serveStatic({ path: './public/retreats/7/sponsor.html' }));
app.get('/project2045', serveStatic({ path: './public/project2045.html' }));
app.get('/community', serveStatic({ path: './public/community.html' }));
app.get('/cohort', serveStatic({ path: './public/cohort.html' }));
app.get('/intros', serveStatic({ path: './public/intros.html' }));
app.get('/expand', serveStatic({ path: './public/expand.html' }));
app.get('/equity-calculator', serveStatic({ path: './public/equity-calculator.html' }));
app.get('/raise-planner', serveStatic({ path: './public/raise-planner.html' }));
app.get('/investor-matcher', serveStatic({ path: './public/investor-matcher.html' }));
app.get('/case-studies', serveStatic({ path: './public/case-studies.html' }));
app.get('/case-studies/rosotics', serveStatic({ path: './public/case-studies/rosotics.html' }));
app.get('/case-studies/stealth-300k', (c) => c.redirect('/case-studies/ryniant', 301));
app.get('/case-studies/autio', serveStatic({ path: './public/case-studies/autio.html' }));
app.get('/case-studies/peachpay', serveStatic({ path: './public/case-studies/peachpay.html' }));
app.get('/case-studies/insured-nomads', serveStatic({ path: './public/case-studies/insured-nomads.html' }));
app.get('/case-studies/breathe-ev', (c) => c.redirect('/case-studies', 301));
app.get('/case-studies/othersideai', serveStatic({ path: './public/case-studies/othersideai.html' }));
app.get('/case-studies/kalendar-ai', serveStatic({ path: './public/case-studies/kalendar-ai.html' }));
app.get('/case-studies/legix', serveStatic({ path: './public/case-studies/legix.html' }));
app.get('/case-studies/notary-everyday', serveStatic({ path: './public/case-studies/notary-everyday.html' }));
app.get('/case-studies/ryniant', serveStatic({ path: './public/case-studies/ryniant.html' }));
// Old stealth slugs → 301 to the de-anonymized clean URLs
app.get('/case-studies/stealth-vertical-ai', (c) => c.redirect('/case-studies/legix', 301));
app.get('/case-studies/stealth-proptech', (c) => c.redirect('/case-studies/notary-everyday', 301));

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
    const result = await withCronRun('weekly_digest', () => sendWeeklyDigests());
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
    const result = await withCronRun('weekly_digest_preview', () => sendDigestPreviewToAdmin());
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

// "The system needs you" digest — 2x/day (9am + 5pm Arizona = 16:00 + 00:00 UTC).
// Emails the admin everything in the agent ledger awaiting a human decision
// (status 'proposed'); no email when nothing is pending.
cron.schedule('0 0,16 * * *', async () => {
  console.log('[CRON] Running agent needs-you digest...');
  try {
    const { sendNeedsYouDigest } = await import('./services/agent-actions.js');
    const result = await withCronRun('agent_needs_you_digest', () => sendNeedsYouDigest());
    console.log('[CRON] Needs-you digest:', result);
  } catch (err) {
    console.error('[CRON] Needs-you digest failed:', err);
  }
}, {
  timezone: 'UTC'
});
console.log('[CRON] Agent needs-you digest scheduled for 00:00 + 16:00 UTC (5pm + 9am Arizona)');

// Pending-review digest — emails the admin "N intro requests are loaded into your
// dashboard" with a button to approve/reject. No Gmail drafts; approving in the
// dashboard sends the ask through the app (Postmark).
// 10am Arizona = 17:00 UTC. After the shadow-agent's 9am suggestion run so the
// queue is fresh.
cron.schedule('0 17 * * *', async () => {
  console.log('[CRON] Running pending-review digest...');
  try {
    const { runPendingDigestTick } = await import('./services/agent.js');
    const result = await runPendingDigestTick();
    console.log('[CRON] Pending-review digest result:', result);
  } catch (err) {
    console.error('[CRON] Pending-review digest failed:', err);
  }
}, {
  timezone: 'UTC'
});

console.log('[CRON] Pending-review digest scheduled for daily 17:00 UTC (10am Arizona)');

// Follow-up agent — runs daily at 18:00 UTC (11am AZ), an hour after auto-draft.
cron.schedule('0 18 * * *', async () => {
  console.log('[CRON] Running follow-up tick...');
  try {
    const { runFollowupTick } = await import('./services/agent.js');
    const result = await runFollowupTick();
    console.log('[CRON] Follow-up tick result:', result);
  } catch (err) {
    console.error('[CRON] Follow-up tick failed:', err);
  }
}, {
  timezone: 'UTC'
});

console.log('[CRON] Follow-up agent scheduled for daily 18:00 UTC (11am Arizona)');

// Trial decision nudge — daily 16:30 UTC (9:30am Arizona). Emails admin for any
// active trial that hit its end date with no offer/pass decision.
cron.schedule('30 16 * * *', async () => {
  console.log('[CRON] Running trial decision nudge...');
  try {
    const { sendTrialDecisionNudges } = await import('./services/trials.js');
    const result = await sendTrialDecisionNudges();
    console.log('[CRON] Trial decision nudge result:', result);
  } catch (err) {
    console.error('[CRON] Trial decision nudge failed:', err);
  }
}, {
  timezone: 'UTC'
});

// Reply classifier — every hour at :15 past, classify any new investor
// replies and apply status transitions.
cron.schedule('15 * * * *', async () => {
  console.log('[CRON] Running reply classifier tick...');
  try {
    const { runReplyClassifierTick } = await import('./services/reply-classifier.js');
    const { withCronRun } = await import('./services/cron-log.js');
    const result = await withCronRun('reply_classifier', () => runReplyClassifierTick());
    console.log('[CRON] Reply classifier result:', result);
  } catch (err) {
    console.error('[CRON] Reply classifier failed:', err);
  }
}, {
  timezone: 'UTC'
});

// Investor discovery — once a day, find a small batch of active pre-seed/seed
// first-check investors via web search and queue them for admin review.
cron.schedule('0 15 * * *', async () => {
  console.log('[CRON] Running investor discovery tick...');
  try {
    const { runInvestorDiscoveryTick } = await import('./services/investor-discovery.js');
    const { withCronRun } = await import('./services/cron-log.js');
    const result = await withCronRun('investor_discovery', () => runInvestorDiscoveryTick(15));
    console.log('[CRON] Investor discovery result:', result);
  } catch (err) {
    console.error('[CRON] Investor discovery failed:', err);
  }
}, { timezone: 'UTC' });

console.log('[CRON] Trial decision nudge scheduled for daily 16:30 UTC (9:30am Arizona)');
console.log('[CRON] Reply classifier scheduled hourly at :15');
console.log('[CRON] Investor discovery scheduled daily at 15:00 UTC');

serve({
  fetch: app.fetch,
  port,
  hostname: '0.0.0.0',
});
