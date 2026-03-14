import { Hono } from 'hono';
import { eq, isNotNull } from 'drizzle-orm';
import { db, publicUsers, publicCompanies, founders, investors, nodes, portfolioCompanies, onboardingWorkflows, onboardingEvents, founderNodeRelationships, nodeInvestorConnections } from '../db/index.js';
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

  // Enrich with user info
  const enriched = await Promise.all(apps.map(async (app) => {
    const user = await db.query.publicUsers.findFirst({
      where: eq(publicUsers.id, app.userId),
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
  if (company.applicationStatus !== 'applied' && company.applicationStatus !== 'interview_sent') return c.json({ error: 'Not a pending application' }, 400);

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
      await postmarkClient.sendEmail({
        From: process.env.POSTMARK_FROM_EMAIL || 'mat@matsherman.com',
        To: user.email,
        Subject: `Update on your MatCap application`,
        HtmlBody: `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
            <p>Hi ${user.firstName},</p>
            <p>Thank you for sharing your work with us — we genuinely appreciate you taking the time.</p>
            <p>After reviewing your application, we've decided not to move forward at this stage. This is less about your company's potential and more about where we are as investors — we don't yet know your market well enough to be a confident, value-adding partner for you right now.</p>
            <p>We wish you the best as you build, and hope our paths cross again down the road.</p>
            <p>Best,<br>The MatCap Team</p>
          </div>
        `,
        TextBody: `Hi ${user.firstName},\n\nThank you for sharing your work with us — we genuinely appreciate you taking the time.\n\nAfter reviewing your application, we've decided not to move forward at this stage. This is less about your company's potential and more about where we are as investors — we don't yet know your market well enough to be a confident, value-adding partner for you right now.\n\nWe wish you the best as you build, and hope our paths cross again down the road.\n\nBest,\nThe MatCap Team`,
      });
    } catch (err) {
      console.error('Failed to send decline email:', err);
    }
  }

  return c.json({ success: true });
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
