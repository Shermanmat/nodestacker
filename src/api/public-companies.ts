import { Hono } from 'hono';
import { eq, and } from 'drizzle-orm';
import { db, publicUsers, publicCompanies, publicSessions } from '../db/index.js';
import { z } from 'zod';
import * as postmark from 'postmark';

const app = new Hono();

const postmarkClient = process.env.POSTMARK_API_KEY
  ? new postmark.ServerClient(process.env.POSTMARK_API_KEY)
  : null;

// Middleware to validate public session and get user
async function getAuthenticatedUser(c: any) {
  const sessionId = c.req.header('X-Public-Session');

  if (!sessionId) {
    return null;
  }

  const session = await db.query.publicSessions.findFirst({
    where: eq(publicSessions.id, sessionId),
  });

  if (!session || new Date() > new Date(session.expiresAt)) {
    return null;
  }

  const user = await db.query.publicUsers.findFirst({
    where: eq(publicUsers.id, session.userId),
  });

  return user;
}

// Sector options for dropdown
const SECTORS = [
  'AI/ML',
  'B2B SaaS',
  'Consumer',
  'Climate/Cleantech',
  'Crypto/Web3',
  'Defense/Govtech',
  'E-commerce',
  'Education',
  'Enterprise',
  'Fintech',
  'Hardware',
  'Healthcare/Biotech',
  'Infrastructure',
  'Marketplace',
  'Media/Entertainment',
  'Real Estate',
  'Robotics',
  'Security',
  'Other',
] as const;

const createCompanySchema = z.object({
  companyName: z.string().min(1, 'Company name is required'),
  oneLiner: z.string().min(1, 'One-liner is required'),
  url: z.string().url().optional().or(z.literal('')),
  sector: z.string().min(1, 'Sector is required'),
  applyToPortfolio: z.boolean().optional(),
});

const updateCompanySchema = createCompanySchema.partial();

// List user's companies
app.get('/', async (c) => {
  const user = await getAuthenticatedUser(c);

  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const companies = await db.select()
    .from(publicCompanies)
    .where(eq(publicCompanies.userId, user.id));

  return c.json(companies);
});

// Get sectors list (for dropdown)
app.get('/sectors', async (c) => {
  return c.json(SECTORS);
});

// Get single company
app.get('/:id', async (c) => {
  const user = await getAuthenticatedUser(c);

  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const companyId = parseInt(c.req.param('id'));

  const company = await db.query.publicCompanies.findFirst({
    where: and(
      eq(publicCompanies.id, companyId),
      eq(publicCompanies.userId, user.id)
    ),
  });

  if (!company) {
    return c.json({ error: 'Company not found' }, 404);
  }

  return c.json(company);
});

// Create company
app.post('/', async (c) => {
  const user = await getAuthenticatedUser(c);

  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const body = await c.req.json();
  const parsed = createCompanySchema.safeParse(body);

  if (!parsed.success) {
    const errorMsg = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ');
    return c.json({ error: errorMsg }, 400);
  }

  const now = new Date().toISOString();

  const applyToPortfolio = parsed.data.applyToPortfolio || false;

  const [company] = await db.insert(publicCompanies).values({
    userId: user.id,
    companyName: parsed.data.companyName,
    oneLiner: parsed.data.oneLiner,
    url: parsed.data.url || null,
    sector: parsed.data.sector,
    applicationStatus: applyToPortfolio ? 'applied' : null,
    appliedAt: applyToPortfolio ? now : null,
    createdAt: now,
  }).returning();

  if (applyToPortfolio) {
    console.log(`[PORTFOLIO] ${user.firstName} ${user.lastName} applied with ${parsed.data.companyName}`);
    await notifyAdminPortfolioApplication(user, parsed.data);
  }

  return c.json(company, 201);
});

// Update company
app.put('/:id', async (c) => {
  const user = await getAuthenticatedUser(c);

  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const companyId = parseInt(c.req.param('id'));

  // Verify ownership
  const existing = await db.query.publicCompanies.findFirst({
    where: and(
      eq(publicCompanies.id, companyId),
      eq(publicCompanies.userId, user.id)
    ),
  });

  if (!existing) {
    return c.json({ error: 'Company not found' }, 404);
  }

  const body = await c.req.json();
  const parsed = updateCompanySchema.safeParse(body);

  if (!parsed.success) {
    const errorMsg = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ');
    return c.json({ error: errorMsg }, 400);
  }

  const body2 = body as Record<string, unknown>;
  const applyToPortfolio = body2.applyToPortfolio === true;

  // Build update object
  const updateData: Record<string, unknown> = {};
  if (parsed.data.companyName !== undefined) updateData.companyName = parsed.data.companyName;
  if (parsed.data.oneLiner !== undefined) updateData.oneLiner = parsed.data.oneLiner;
  if (parsed.data.url !== undefined) updateData.url = parsed.data.url || null;
  if (parsed.data.sector !== undefined) updateData.sector = parsed.data.sector;

  // Allow applying to portfolio on edit (only if not already applied/approved)
  if (applyToPortfolio && !existing.applicationStatus) {
    const now = new Date().toISOString();
    updateData.applicationStatus = 'applied';
    updateData.appliedAt = now;
    await notifyAdminPortfolioApplication(user, { companyName: existing.companyName, oneLiner: existing.oneLiner, sector: existing.sector });
  }

  if (Object.keys(updateData).length === 0) {
    return c.json({ error: 'No fields to update' }, 400);
  }

  const [updated] = await db.update(publicCompanies)
    .set(updateData)
    .where(eq(publicCompanies.id, companyId))
    .returning();

  return c.json(updated);
});

// Delete company
app.delete('/:id', async (c) => {
  const user = await getAuthenticatedUser(c);

  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const companyId = parseInt(c.req.param('id'));

  // Verify ownership
  const existing = await db.query.publicCompanies.findFirst({
    where: and(
      eq(publicCompanies.id, companyId),
      eq(publicCompanies.userId, user.id)
    ),
  });

  if (!existing) {
    return c.json({ error: 'Company not found' }, 404);
  }

  await db.delete(publicCompanies).where(eq(publicCompanies.id, companyId));

  return c.json({ success: true });
});

async function notifyAdminPortfolioApplication(user: any, company: any) {
  if (!postmarkClient) return;
  try {
    const adminEmail = process.env.ADMIN_NOTIFY_EMAIL || 'mat@matsherman.com';
    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
    await postmarkClient.sendEmail({
      From: process.env.POSTMARK_FROM_EMAIL || 'mat@matsherman.com',
      To: adminEmail,
      Subject: `Portfolio application: ${company.companyName} (${user.firstName} ${user.lastName})`,
      HtmlBody: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
          <h3>New Portfolio Application</h3>
          <table style="border-collapse: collapse; width: 100%;">
            <tr><td style="padding: 6px 12px; color: #666;">Founder</td><td style="padding: 6px 12px; font-weight: bold;">${user.firstName} ${user.lastName}</td></tr>
            <tr><td style="padding: 6px 12px; color: #666;">Email</td><td style="padding: 6px 12px;">${user.email}</td></tr>
            <tr><td style="padding: 6px 12px; color: #666;">Company</td><td style="padding: 6px 12px; font-weight: bold;">${company.companyName}</td></tr>
            <tr><td style="padding: 6px 12px; color: #666;">One-liner</td><td style="padding: 6px 12px;">${company.oneLiner || '—'}</td></tr>
            <tr><td style="padding: 6px 12px; color: #666;">Sector</td><td style="padding: 6px 12px;">${company.sector || '—'}</td></tr>
            <tr><td style="padding: 6px 12px; color: #666;">City</td><td style="padding: 6px 12px;">${user.city || '—'}</td></tr>
            ${user.linkedinUrl ? `<tr><td style="padding: 6px 12px; color: #666;">LinkedIn</td><td style="padding: 6px 12px;"><a href="${user.linkedinUrl}">${user.linkedinUrl}</a></td></tr>` : ''}
          </table>
          <p style="margin-top: 20px;"><a href="${baseUrl}/admin" style="background-color: #2563eb; color: white; padding: 10px 20px; text-decoration: none; border-radius: 6px; display: inline-block;">Review in Admin →</a></p>
        </div>
      `,
      TextBody: `New Portfolio Application\n\nFounder: ${user.firstName} ${user.lastName} (${user.email})\nCompany: ${company.companyName}\nOne-liner: ${company.oneLiner || '—'}\nSector: ${company.sector || '—'}\nCity: ${user.city || '—'}`,
    });
    console.log(`✅ Portfolio application notification sent for ${company.companyName}`);
  } catch (err) {
    console.error('Failed to send portfolio application notification:', err);
  }
}

export default app;
