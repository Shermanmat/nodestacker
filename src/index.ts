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
import categoriesRoutes from './api/categories.js';
import matchingRoutes from './api/matching.js';
import marketplaceHealthRoutes from './api/marketplace-health.js';
import signupsRoutes from './api/signups.js';
import voiceInterviewsRoutes from './api/voice-interviews.js';
import { sendWeeklyDigests } from './services/weekly-digest.js';
import { adminGuard } from './api/middleware/admin-guard.js';
import { eq } from 'drizzle-orm';
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
// Onboarding chat is public (founder intake interview)
// Admin endpoints (/leads, /leads/:id/convert) are protected below
app.route('/api/onboarding-chat', onboardingChatRoutes);
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
// Voice interview admin endpoints
app.use('/api/admin/voice-interviews', adminGuard);
app.use('/api/admin/voice-interviews/*', adminGuard);
// Weekly digest - preview requires admin, send allows token auth for cron
app.use('/api/weekly-digest/preview/*', adminGuard);

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

// Health check
app.get('/api/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));

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

// Marketing site
app.get('/welcome', serveStatic({ path: './public/welcome.html' }));
app.get('/founders', serveStatic({ path: './public/founders.html' }));
app.get('/investors', serveStatic({ path: './public/investors.html' }));
app.get('/nodes', serveStatic({ path: './public/nodes.html' }));

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

serve({
  fetch: app.fetch,
  port,
});
