/**
 * Instantly.ai outreach management routes
 * Manages cold email campaigns to expand the investor network
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, desc, sql } from 'drizzle-orm';
import { db, instantlyCampaigns, instantlyLeads, investors, nodes, nodeInvestorConnections } from '../db/index.js';
import * as instantly from '../services/instantly.js';
import { startInvestorResearch } from '../services/research-agent.js';

const app = new Hono();

// List all tracked campaigns with stats
app.get('/', async (c) => {
  const campaigns = await db.select().from(instantlyCampaigns).orderBy(desc(instantlyCampaigns.createdAt));
  return c.json(campaigns);
});

// Create a new campaign in Instantly + track locally
app.post('/campaigns', async (c) => {
  const schema = z.object({
    name: z.string().min(1),
    accountEmail: z.string().email(),
  });

  const body = await c.req.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues }, 400);
  }

  const result = await instantly.createCampaign(parsed.data.name, parsed.data.accountEmail);
  if (!result.success || !result.data) {
    return c.json({ error: result.error || 'Failed to create campaign' }, 502);
  }

  const now = new Date().toISOString();
  const campaign = await db.insert(instantlyCampaigns).values({
    instantlyCampaignId: result.data.id,
    name: parsed.data.name,
    status: 'draft',
    accountEmail: parsed.data.accountEmail,
    createdAt: now,
  }).returning();

  return c.json(campaign[0], 201);
});

// Activate a campaign
app.post('/campaigns/:id/activate', async (c) => {
  const id = parseInt(c.req.param('id'));
  const campaign = await db.query.instantlyCampaigns.findFirst({
    where: eq(instantlyCampaigns.id, id),
  });

  if (!campaign) return c.json({ error: 'Campaign not found' }, 404);

  const result = await instantly.activateCampaign(campaign.instantlyCampaignId);
  if (!result.success) {
    return c.json({ error: result.error || 'Failed to activate campaign' }, 502);
  }

  await db.update(instantlyCampaigns)
    .set({ status: 'active' })
    .where(eq(instantlyCampaigns.id, id));

  return c.json({ status: 'active' });
});

// Pause a campaign
app.post('/campaigns/:id/pause', async (c) => {
  const id = parseInt(c.req.param('id'));
  const campaign = await db.query.instantlyCampaigns.findFirst({
    where: eq(instantlyCampaigns.id, id),
  });

  if (!campaign) return c.json({ error: 'Campaign not found' }, 404);

  const result = await instantly.pauseCampaign(campaign.instantlyCampaignId);
  if (!result.success) {
    return c.json({ error: result.error || 'Failed to pause campaign' }, 502);
  }

  await db.update(instantlyCampaigns)
    .set({ status: 'paused' })
    .where(eq(instantlyCampaigns.id, id));

  return c.json({ status: 'paused' });
});

// Get campaign analytics from Instantly
app.get('/campaigns/:id/analytics', async (c) => {
  const id = parseInt(c.req.param('id'));
  const campaign = await db.query.instantlyCampaigns.findFirst({
    where: eq(instantlyCampaigns.id, id),
  });

  if (!campaign) return c.json({ error: 'Campaign not found' }, 404);

  const result = await instantly.getCampaignAnalytics(campaign.instantlyCampaignId);
  if (!result.success) {
    return c.json({ error: result.error || 'Failed to fetch analytics' }, 502);
  }

  return c.json({ campaign, analytics: result.data });
});

// Push leads to a campaign (with dedup)
app.post('/campaigns/:id/leads', async (c) => {
  const id = parseInt(c.req.param('id'));
  const campaign = await db.query.instantlyCampaigns.findFirst({
    where: eq(instantlyCampaigns.id, id),
  });

  if (!campaign) return c.json({ error: 'Campaign not found' }, 404);

  const schema = z.object({
    leads: z.array(z.object({
      name: z.string().min(1),
      email: z.string().email(),
      firm: z.string().optional(),
      role: z.string().optional(),
    })),
  });

  const body = await c.req.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues }, 400);
  }

  // Dedup against existing leads in this campaign
  const existingLeads = await db.select({ email: instantlyLeads.investorEmail })
    .from(instantlyLeads)
    .where(eq(instantlyLeads.instantlyCampaignId, campaign.instantlyCampaignId));
  const existingEmails = new Set(existingLeads.map(l => l.email.toLowerCase()));

  // Check which leads already exist as investors in Nodestacker
  const allInvestors = await db.select({ name: investors.name })
    .from(investors);
  const existingNames = new Set(allInvestors.map(i => i.name.toLowerCase()));

  const newLeads = [];
  let skipped = 0;
  let alreadyInDb = 0;

  for (const lead of parsed.data.leads) {
    if (existingEmails.has(lead.email.toLowerCase())) {
      skipped++;
      continue;
    }

    if (existingNames.has(lead.name.toLowerCase())) {
      alreadyInDb++;
    }

    newLeads.push(lead);
  }

  if (newLeads.length === 0) {
    return c.json({ pushed: 0, skipped, alreadyInDb, message: 'All leads already exist' });
  }

  // Push to Instantly
  const instantlyLeadPayload = newLeads.map(l => {
    const nameParts = l.name.split(' ');
    return {
      email: l.email,
      first_name: nameParts[0],
      last_name: nameParts.slice(1).join(' ') || undefined,
      company_name: l.firm || undefined,
    };
  });

  const result = await instantly.addLeadsBulk(campaign.instantlyCampaignId, instantlyLeadPayload);
  if (!result.success) {
    return c.json({ error: result.error || 'Failed to push leads to Instantly' }, 502);
  }

  // Track locally
  const now = new Date().toISOString();
  for (const lead of newLeads) {
    await db.insert(instantlyLeads).values({
      instantlyCampaignId: campaign.instantlyCampaignId,
      investorName: lead.name,
      investorFirm: lead.firm || null,
      investorEmail: lead.email,
      leadStatus: 'pending',
      createdAt: now,
      updatedAt: now,
    });
  }

  // Update campaign lead count
  await db.update(instantlyCampaigns)
    .set({ leadsCount: sql`${instantlyCampaigns.leadsCount} + ${newLeads.length}` })
    .where(eq(instantlyCampaigns.id, id));

  return c.json({ pushed: newLeads.length, skipped, alreadyInDb }, 201);
});

// List leads for a campaign
app.get('/campaigns/:id/leads', async (c) => {
  const id = parseInt(c.req.param('id'));
  const campaign = await db.query.instantlyCampaigns.findFirst({
    where: eq(instantlyCampaigns.id, id),
  });

  if (!campaign) return c.json({ error: 'Campaign not found' }, 404);

  const statusFilter = c.req.query('status');
  const leads = statusFilter
    ? await db.select().from(instantlyLeads).where(
        and(
          eq(instantlyLeads.instantlyCampaignId, campaign.instantlyCampaignId),
          eq(instantlyLeads.leadStatus, statusFilter),
        ),
      ).orderBy(desc(instantlyLeads.updatedAt))
    : await db.select().from(instantlyLeads).where(
        eq(instantlyLeads.instantlyCampaignId, campaign.instantlyCampaignId),
      ).orderBy(desc(instantlyLeads.updatedAt));

  return c.json(leads);
});

// Manually trigger reply sync across all active campaigns
app.post('/sync-replies', async (c) => {
  const { syncAllCampaigns } = await import('../scripts/sync-instantly-replies.js');
  const result = await syncAllCampaigns();
  return c.json(result);
});

// List all positive replies pending processing
app.get('/leads/positive', async (c) => {
  const leads = await db.select().from(instantlyLeads).where(
    and(
      eq(instantlyLeads.leadStatus, 'positive'),
      eq(instantlyLeads.processed, false),
    ),
  ).orderBy(desc(instantlyLeads.updatedAt));

  return c.json(leads);
});

// Import a positive lead into Nodestacker as an investor
app.post('/leads/:id/import', async (c) => {
  const id = parseInt(c.req.param('id'));
  const lead = await db.query.instantlyLeads.findFirst({
    where: eq(instantlyLeads.id, id),
  });

  if (!lead) return c.json({ error: 'Lead not found' }, 404);
  if (lead.processed) return c.json({ error: 'Lead already processed' }, 409);

  const now = new Date().toISOString();

  // Check for existing investor by name (case-insensitive dedup)
  const allInvestors = await db.select().from(investors);
  const existing = allInvestors.find(
    i => i.name.toLowerCase() === lead.investorName.toLowerCase(),
  );

  let investorId: number;

  if (existing) {
    investorId = existing.id;
    console.log(`[INSTANTLY] Investor "${lead.investorName}" already exists (id=${investorId})`);
  } else {
    // Create new investor
    const result = await db.insert(investors).values({
      name: lead.investorName,
      firm: lead.investorFirm,
      active: true,
      createdAt: now,
    }).returning();
    investorId = result[0].id;
    console.log(`[INSTANTLY] Created investor "${lead.investorName}" (id=${investorId})`);
  }

  // Find Mat Sherman node
  const matNode = await db.query.nodes.findFirst({
    where: eq(nodes.name, 'Mat Sherman'),
  });

  if (matNode) {
    // Check for existing connection
    const existingConnection = await db.query.nodeInvestorConnections.findFirst({
      where: and(
        eq(nodeInvestorConnections.nodeId, matNode.id),
        eq(nodeInvestorConnections.investorId, investorId),
      ),
    });

    if (!existingConnection) {
      await db.insert(nodeInvestorConnections).values({
        nodeId: matNode.id,
        investorId,
        connectionStrength: 'weak',
        addedBy: 'platform',
        validated: false,
        createdAt: now,
      });
      console.log(`[INSTANTLY] Connected investor ${investorId} to Mat Sherman node`);
    }
  }

  // Mark lead as processed
  await db.update(instantlyLeads).set({
    investorId,
    processed: true,
    processedAt: now,
    updatedAt: now,
  }).where(eq(instantlyLeads.id, id));

  // Trigger research in background
  startInvestorResearch(investorId).catch(err => {
    console.error(`[INSTANTLY] Research failed for investor ${investorId}:`, err);
  });

  return c.json({
    investorId,
    isNew: !existing,
    researchTriggered: true,
  }, 201);
});

export default app;
