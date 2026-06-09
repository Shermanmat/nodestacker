import { Hono } from 'hono';
import { eq, isNotNull, and, isNull } from 'drizzle-orm';
import { db, publicUsers, publicCompanies, founders, investors, nodes, portfolioCompanies, onboardingWorkflows, onboardingEvents, founderNodeRelationships, nodeInvestorConnections, founderLeads, trials, ensureDefaultNodeRelationship } from '../db/index.js';
import { scoreApplication } from '../services/application-scorer.js';
import { z } from 'zod';
import * as postmark from 'postmark';

const postmarkClient = process.env.POSTMARK_API_KEY
  ? new postmark.ServerClient(process.env.POSTMARK_API_KEY)
  : null;

const app = new Hono();

// List all signups
app.get('/', async (c) => {
  const all = await db.select().from(publicUsers);
  return c.json(all.map(u => ({
    ...u,
    nodeContacts: u.nodeContacts ? JSON.parse(u.nodeContacts) : null,
  })));
});

// List portfolio applications
app.get('/applications', async (c) => {
  const apps = await db.select()
    .from(publicCompanies)
    .where(isNotNull(publicCompanies.applicationStatus));

  // Enrich with user info + any blurb the applicant built as the post-apply
  // next step (linked back via founder_leads.publicCompanyId).
  const enriched = await Promise.all(apps.map(async (app) => {
    const user = await db.query.publicUsers.findFirst({
      where: eq(publicUsers.id, app.userId),
    });
    const lead = await db.query.founderLeads.findFirst({
      where: eq(founderLeads.publicCompanyId, app.id),
    });
    return {
      ...app,
      user: user ? {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        linkedinUrl: user.linkedinUrl,
        twitterHandle: user.twitterHandle,
        city: user.city,
        oneLiner: user.oneLiner,
      } : null,
      blurb: lead && lead.investorBlurb ? {
        investorBlurb: lead.investorBlurb,
        oneLiner: lead.oneLiner,
      } : null,
    };
  }));

  return c.json(enriched);
});

// Approve portfolio application (converts user to founder + creates portfolio company)
app.post('/applications/:id/approve', async (c) => {
  const companyId = parseInt(c.req.param('id'));
  const company = await db.query.publicCompanies.findFirst({
    where: eq(publicCompanies.id, companyId),
  });
  if (!company) return c.json({ error: 'Company not found' }, 404);
  if (!['applied', 'interview_sent', 'trial_sent'].includes(company.applicationStatus || '')) return c.json({ error: 'Not a pending application' }, 400);

  const user = await db.query.publicUsers.findFirst({
    where: eq(publicUsers.id, company.userId),
  });
  if (!user) return c.json({ error: 'User not found' }, 404);

  const now = new Date().toISOString();

  // Create or find founder
  let founder = await db.query.founders.findFirst({
    where: eq(founders.email, user.email),
  });

  if (!founder) {
    const [created] = await db.insert(founders).values({
      name: `${user.firstName} ${user.lastName}`,
      email: user.email,
      companyName: company.companyName,
      companyStage: 'pre_seed',
      roundStatus: 'pre_round',
      city: user.city,
      createdAt: now,
    }).returning();
    founder = created;
    await ensureDefaultNodeRelationship(founder.id);
  }

  // Create portfolio company if not exists
  let portfolioCompany = await db.query.portfolioCompanies.findFirst({
    where: eq(portfolioCompanies.founderId, founder.id),
  });

  if (!portfolioCompany) {
    const [created] = await db.insert(portfolioCompanies).values({
      founderId: founder.id,
      oneLiner: company.oneLiner,
      createdAt: now,
      updatedAt: now,
    }).returning();
    portfolioCompany = created;
  }

  // Create onboarding workflow if not exists
  let workflow = await db.query.onboardingWorkflows.findFirst({
    where: eq(onboardingWorkflows.portfolioCompanyId, portfolioCompany.id),
  });

  if (!workflow) {
    const [created] = await db.insert(onboardingWorkflows).values({
      portfolioCompanyId: portfolioCompany.id,
      status: 'offer_pending',
      offerEquityPercent: '0.5',
      vestingMonths: 48,
      vestingCliffMonths: 0,
      createdAt: now,
      updatedAt: now,
    }).returning();
    workflow = created;

    // Log the event
    await db.insert(onboardingEvents).values({
      workflowId: workflow.id,
      eventType: 'workflow_started',
      actor: 'system',
      details: `Auto-created from portfolio application approval`,
      createdAt: now,
    });
  }

  // Mark application as approved
  await db.update(publicCompanies)
    .set({ applicationStatus: 'approved' })
    .where(eq(publicCompanies.id, companyId));

  // Mark user as converted
  await db.update(publicUsers)
    .set({ status: 'converted' })
    .where(eq(publicUsers.id, user.id));

  console.log(`[PORTFOLIO] Approved ${user.firstName} ${user.lastName} / ${company.companyName} → founder #${founder.id}, workflow #${workflow.id}`);

  return c.json({ success: true, founderId: founder.id, portfolioCompanyId: portfolioCompany.id, workflowId: workflow.id });
});

// Decline portfolio application
app.post('/applications/:id/decline', async (c) => {
  const companyId = parseInt(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));
  const reason: string | undefined = (body?.reason || '').trim() || undefined;

  // Get company and user info for the email
  const company = await db.select().from(publicCompanies).where(eq(publicCompanies.id, companyId)).get();
  if (!company) return c.json({ error: 'Company not found' }, 404);

  const user = await db.select().from(publicUsers).where(eq(publicUsers.id, company.userId)).get();

  await db.update(publicCompanies)
    .set({ applicationStatus: 'declined' })
    .where(eq(publicCompanies.id, companyId));

  // Send rejection email to the founder
  if (postmarkClient && user) {
    try {
      const reasonHtml = reason
        ? `<p>${reason.replace(/\n/g, '<br>')}</p>`
        : '';
      const reasonText = reason ? `\n${reason}\n` : '';
      await postmarkClient.sendEmail({
        From: process.env.POSTMARK_FROM_EMAIL || 'mat@matsherman.com',
        To: user.email,
        Subject: `Update on your MatCap application`,
        HtmlBody: `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
            <p>Hi ${user.firstName},</p>
            <p>Thanks for applying to MatCap and sharing what you're building.</p>
            <p>I have to be honest with you — I'm one person, and I can only work closely with a handful of founders at any given time. That keeps the bar high on who I take on, and it means I have to pass on a lot of good companies.</p>
            <p>Right now, ${company.companyName} isn't a fit for our portfolio.</p>
            ${reasonHtml}
            <p>Wishing you the best as you build.</p>
            <p>Mat Sherman<br>Founder, MatCap</p>
          </div>
        `,
        TextBody: `Hi ${user.firstName},\n\nThanks for applying to MatCap and sharing what you're building.\n\nI have to be honest with you — I'm one person, and I can only work closely with a handful of founders at any given time. That keeps the bar high on who I take on, and it means I have to pass on a lot of good companies.\n\nRight now, ${company.companyName} isn't a fit for our portfolio.${reasonText}\n\nWishing you the best as you build.\n\nMat Sherman\nFounder, MatCap`,
      });
    } catch (err) {
      console.error('Failed to send decline email:', err);
    }
  }

  return c.json({ success: true });
});

// Request a meeting with the founder (the new positive-path action)
app.post('/applications/:id/request-meeting', async (c) => {
  const companyId = parseInt(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));
  const note: string | undefined = (body?.note || '').trim() || undefined;

  const company = await db.select().from(publicCompanies).where(eq(publicCompanies.id, companyId)).get();
  if (!company) return c.json({ error: 'Company not found' }, 404);

  const user = await db.select().from(publicUsers).where(eq(publicUsers.id, company.userId)).get();
  if (!user) return c.json({ error: 'User not found' }, 404);

  await db.update(publicCompanies)
    .set({ applicationStatus: 'meeting_requested' })
    .where(eq(publicCompanies.id, companyId));

  if (postmarkClient) {
    try {
      const noteHtml = note ? `<p>${note.replace(/\n/g, '<br>')}</p>` : '';
      const noteText = note ? `\n${note}\n` : '';
      await postmarkClient.sendEmail({
        From: process.env.POSTMARK_FROM_EMAIL || 'mat@matsherman.com',
        To: user.email,
        Subject: `Re: your MatCap application — let's talk`,
        HtmlBody: `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
            <p>Hi ${user.firstName},</p>
            <p>Thanks for applying to MatCap. I'd love to learn more about ${company.companyName} and explore whether we'd be a good fit to work together.</p>
            <p>Reply with a few times that work this week or next — happy to do a call, or grab coffee if you're in Phoenix.</p>
            ${noteHtml}
            <p>Looking forward to it.</p>
            <p>Mat Sherman<br>Founder, MatCap</p>
          </div>
        `,
        TextBody: `Hi ${user.firstName},\n\nThanks for applying to MatCap. I'd love to learn more about ${company.companyName} and explore whether we'd be a good fit to work together.\n\nReply with a few times that work this week or next — happy to do a call, or grab coffee if you're in Phoenix.${noteText}\n\nLooking forward to it.\n\nMat Sherman\nFounder, MatCap`,
      });
    } catch (err) {
      console.error('Failed to send meeting-request email:', err);
      return c.json({ error: 'Failed to send email' }, 500);
    }
  }

  console.log(`[MEETING REQUEST] Sent to ${user.firstName} ${user.lastName} (${user.email}) for ${company.companyName}`);

  return c.json({ success: true });
});

// Send trial invitation
app.post('/applications/:id/trial', async (c) => {
  const companyId = parseInt(c.req.param('id'));

  const company = await db.select().from(publicCompanies).where(eq(publicCompanies.id, companyId)).get();
  if (!company) return c.json({ error: 'Company not found' }, 404);

  const user = await db.select().from(publicUsers).where(eq(publicUsers.id, company.userId)).get();
  if (!user) return c.json({ error: 'User not found' }, 404);

  const baseUrl = process.env.BASE_URL || 'https://matcap.vc';

  // Update status
  await db.update(publicCompanies)
    .set({ applicationStatus: 'trial_sent' })
    .where(eq(publicCompanies.id, companyId));

  // Send trial email
  if (postmarkClient) {
    try {
      await postmarkClient.sendEmail({
        From: process.env.POSTMARK_FROM_EMAIL || 'mat@matsherman.com',
        To: user.email,
        Subject: `${user.firstName}, let's do a trial — MatCap`,
        HtmlBody: `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
            <p>Hi ${user.firstName},</p>
            <p>Thanks for applying to MatCap. I'd like to work together on a trial basis — I'll send your pitch to relevant investors in our network and we'll see if there's a fit.</p>
            <p>Before we get started, take a look at how the trial works:</p>
            <p style="margin: 24px 0;">
              <a href="${baseUrl}/trial" style="background-color: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: 600;">
                See How It Works
              </a>
            </p>
            <p>At the bottom of that page, you'll find a link to build your investor blurb — that's the first step.</p>
            <p>Looking forward to it.</p>
            <p>Mat Sherman<br>Founder, MatCap</p>
          </div>
        `,
        TextBody: `Hi ${user.firstName},\n\nThanks for applying to MatCap. I'd like to work together on a trial basis — I'll send your pitch to relevant investors in our network and we'll see if there's a fit.\n\nBefore we get started, take a look at how the trial works:\n${baseUrl}/trial\n\nAt the bottom of that page, you'll find a link to build your investor blurb — that's the first step.\n\nLooking forward to it.\n\nMat Sherman\nFounder, MatCap`,
      });
    } catch (err) {
      console.error('Failed to send trial email:', err);
      return c.json({ error: 'Failed to send email' }, 500);
    }
  }

  console.log(`[TRIAL] Sent trial invite to ${user.firstName} ${user.lastName} (${user.email}) for ${company.companyName}`);

  return c.json({ success: true });
});

// Shadow AI scorer: score (or re-score) one application. Advisory only.
app.post('/applications/:id/score', async (c) => {
  const id = parseInt(c.req.param('id'));
  try {
    const score = await scoreApplication(id);
    if (!score) return c.json({ error: 'Could not score (missing app or API key)' }, 400);
    return c.json({ success: true, score });
  } catch (err) {
    console.error('[score] failed:', err);
    return c.json({ error: err instanceof Error ? err.message : 'Score failed' }, 500);
  }
});

// Bulk-score every pending application that hasn't been scored yet (day-1 catch-up).
app.post('/applications/score-pending', async (c) => {
  const pending = await db.select().from(publicCompanies)
    .where(and(eq(publicCompanies.applicationStatus, 'applied'), isNull(publicCompanies.aiScore)));
  let scored = 0;
  for (const p of pending.slice(0, 25)) {
    try { if (await scoreApplication(p.id)) scored++; } catch (e) { console.error('[score-pending]', p.id, e); }
  }
  return c.json({ success: true, scored, remaining: Math.max(0, pending.length - 25) });
});

// Capture the admin's own reason for a decision — the gold training signal.
app.post('/applications/:id/decision-reason', async (c) => {
  const id = parseInt(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));
  const reason = typeof body.reason === 'string' ? body.reason.slice(0, 300) : '';
  await db.update(publicCompanies).set({ decisionReason: reason }).where(eq(publicCompanies.id, id));
  return c.json({ success: true });
});

// Start a REAL trial straight from an application, in one click.
// Unlike /trial (which only emails an invite + sets the label) and unlike
// /approve (which also spins up the equity onboarding), this does exactly what a
// no-equity audition needs: convert to a founder (founder + default node rel
// only — NO portfolio/onboarding/equity), create an active 2-week trial, and
// turn on the intro cadence so they start getting intros.
const TRIAL_DAYS = 14;
app.post('/applications/:id/start-trial', async (c) => {
  const companyId = parseInt(c.req.param('id'));
  const company = await db.query.publicCompanies.findFirst({ where: eq(publicCompanies.id, companyId) });
  if (!company) return c.json({ error: 'Company not found' }, 404);
  const user = await db.query.publicUsers.findFirst({ where: eq(publicUsers.id, company.userId) });
  if (!user) return c.json({ error: 'User not found' }, 404);

  const now = new Date().toISOString();

  // Convert → founder (find by email or create). Founder + default node
  // relationship only; the equity onboarding is deliberately NOT created here.
  let founder = await db.query.founders.findFirst({ where: eq(founders.email, user.email) });
  if (!founder) {
    const [created] = await db.insert(founders).values({
      name: `${user.firstName} ${user.lastName}`,
      email: user.email,
      companyName: company.companyName,
      companyStage: 'pre_seed',
      roundStatus: 'pre_round',
      city: user.city,
      createdAt: now,
    }).returning();
    founder = created;
    await ensureDefaultNodeRelationship(founder.id);
  }

  // Guard: one open trial per founder.
  const founderTrials = await db.query.trials.findMany({ where: eq(trials.founderId, founder.id) });
  if (founderTrials.some((t) => ['active', 'offer_made'].includes(t.status))) {
    return c.json({ error: 'This founder already has an open trial' }, 400);
  }

  const end = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const [trial] = await db.insert(trials).values({
    founderId: founder.id,
    status: 'active',
    startDate: now,
    endDate: end,
    introTargetMin: 5,
    introTargetMax: 15,
    createdAt: now,
    updatedAt: now,
  }).returning();

  // Engage the intro cadence + reflect the stage on the application.
  await db.update(founders).set({ introCadenceActive: true, cadenceStartDate: now.split('T')[0] }).where(eq(founders.id, founder.id));
  await db.update(publicCompanies).set({ applicationStatus: 'trial_sent' }).where(eq(publicCompanies.id, companyId));
  await db.update(publicUsers).set({ status: 'converted' }).where(eq(publicUsers.id, user.id));

  // Notify the founder their trial is live (non-fatal — the trial is already started).
  if (postmarkClient) {
    const baseUrl = process.env.BASE_URL || 'https://matcap.vc';
    try {
      await postmarkClient.sendEmail({
        From: process.env.POSTMARK_FROM_EMAIL || 'mat@matsherman.com',
        To: user.email,
        Subject: `${user.firstName}, your MatCap trial is live`,
        HtmlBody: `<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;"><p>Hi ${user.firstName},</p><p>Your 2-week MatCap trial just started. If you've filled out your blurb, expect intro requests to start going out to relevant investors in our network. If you haven't yet, your trial will pause until we get it — <a href="${baseUrl}/blurb">fill out your blurb</a> — and pick right back up once it's in.</p><p>Everything runs through your investor CRM:</p><p style="margin:24px 0;"><a href="${baseUrl}/founder" style="background:#2563eb;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;font-weight:600;display:inline-block;">Open your CRM</a></p><p>It's yours to run however you want — track our intros, add your own investors, and connect via MCP to customize it from your AI client.</p><p>At the end of the trial, we'll either make you an offer for 1% of your company or not. If we do, it's on you to decide whether to take it.</p><p>Good luck!</p><p>Mat Sherman<br>Founder, MatCap</p></div>`,
        TextBody: `Hi ${user.firstName},\n\nYour 2-week MatCap trial just started. If you've filled out your blurb, expect intro requests to start going out to relevant investors in our network. If you haven't yet, your trial will pause until we get it — fill out your blurb: ${baseUrl}/blurb — and pick right back up once it's in.\n\nEverything runs through your investor CRM. Open it here: ${baseUrl}/founder\n\nIt's yours to run however you want — track our intros, add your own investors, and connect via MCP to customize it from your AI client.\n\nAt the end of the trial, we'll either make you an offer for 1% of your company or not. If we do, it's on you to decide whether to take it.\n\nGood luck!\n\nMat Sherman\nFounder, MatCap`,
      });
    } catch (err) {
      console.error('Failed to send trial-started email:', err);
    }
  }

  console.log(`[TRIAL] Started trial #${trial.id} for ${user.firstName} ${user.lastName} → founder #${founder.id}`);
  return c.json({ success: true, founderId: founder.id, trialId: trial.id });
});

// Update signup status
app.put('/:id/status', async (c) => {
  const id = parseInt(c.req.param('id'));
  const body = await c.req.json();
  const schema = z.object({
    status: z.enum(['pending', 'approved', 'converted']),
  });
  const parsed = schema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid status' }, 400);

  await db.update(publicUsers)
    .set({ status: parsed.data.status })
    .where(eq(publicUsers.id, id));

  return c.json({ success: true });
});

// Convert signup to founder
app.post('/:id/convert/founder', async (c) => {
  const id = parseInt(c.req.param('id'));
  const user = await db.query.publicUsers.findFirst({
    where: eq(publicUsers.id, id),
  });
  if (!user) return c.json({ error: 'User not found' }, 404);

  // Check if founder already exists with this email
  const existing = await db.query.founders.findFirst({
    where: eq(founders.email, user.email),
  });
  if (existing) {
    // Mark as converted and return existing
    await db.update(publicUsers).set({ status: 'converted' }).where(eq(publicUsers.id, id));
    return c.json({ success: true, founderId: existing.id, alreadyExisted: true });
  }

  const now = new Date().toISOString();
  const [founder] = await db.insert(founders).values({
    name: `${user.firstName} ${user.lastName}`,
    email: user.email,
    companyName: user.oneLiner || 'TBD',
    companyStage: 'pre_seed',
    roundStatus: 'pre_round',
    city: user.city,
    createdAt: now,
  }).returning();

  await ensureDefaultNodeRelationship(founder.id);
  await db.update(publicUsers).set({ status: 'converted' }).where(eq(publicUsers.id, id));

  return c.json({ success: true, founderId: founder.id });
});

// Convert signup to investor
app.post('/:id/convert/investor', async (c) => {
  const id = parseInt(c.req.param('id'));
  const user = await db.query.publicUsers.findFirst({
    where: eq(publicUsers.id, id),
  });
  if (!user) return c.json({ error: 'User not found' }, 404);

  const now = new Date().toISOString();
  const [investor] = await db.insert(investors).values({
    name: `${user.firstName} ${user.lastName}`,
    createdAt: now,
  }).returning();

  await db.update(publicUsers).set({ status: 'converted' }).where(eq(publicUsers.id, id));

  return c.json({ success: true, investorId: investor.id });
});

// Convert signup to node (also imports their investor contacts)
app.post('/:id/convert/node', async (c) => {
  const id = parseInt(c.req.param('id'));
  const user = await db.query.publicUsers.findFirst({
    where: eq(publicUsers.id, id),
  });
  if (!user) return c.json({ error: 'User not found' }, 404);

  const now = new Date().toISOString();
  const [node] = await db.insert(nodes).values({
    name: `${user.firstName} ${user.lastName}`,
    email: user.email,
    createdAt: now,
  }).returning();

  // Import node contacts as investor connections
  const contacts = user.nodeContacts ? JSON.parse(user.nodeContacts) : [];
  const importedContacts: { name: string; investorId: number; created: boolean }[] = [];

  for (const contact of contacts) {
    if (!contact.name) continue;

    // Check if investor exists by name
    let investor = await db.query.investors.findFirst({
      where: eq(investors.name, contact.name),
    });

    let created = false;
    if (!investor) {
      const [newInvestor] = await db.insert(investors).values({
        name: contact.name,
        firm: contact.firm || null,
        createdAt: now,
      }).returning();
      investor = newInvestor;
      created = true;
    }

    // Create node-investor connection
    await db.insert(nodeInvestorConnections).values({
      nodeId: node.id,
      investorId: investor.id,
      connectionStrength: 'medium',
      addedBy: 'signup',
      validated: false,
      createdAt: now,
    });

    importedContacts.push({ name: contact.name, investorId: investor.id, created });
  }

  await db.update(publicUsers).set({ status: 'converted' }).where(eq(publicUsers.id, id));

  return c.json({ success: true, nodeId: node.id, importedContacts });
});

export default app;
