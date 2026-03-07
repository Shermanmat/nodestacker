import { Hono } from 'hono';
import { eq, and } from 'drizzle-orm';
import { db, publicUsers, publicCompanies, publicSessions } from '../db/index.js';
import { z } from 'zod';

const app = new Hono();

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

  const [company] = await db.insert(publicCompanies).values({
    userId: user.id,
    companyName: parsed.data.companyName,
    oneLiner: parsed.data.oneLiner,
    url: parsed.data.url || null,
    sector: parsed.data.sector,
    createdAt: now,
  }).returning();

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

  // Build update object
  const updateData: Record<string, unknown> = {};
  if (parsed.data.companyName !== undefined) updateData.companyName = parsed.data.companyName;
  if (parsed.data.oneLiner !== undefined) updateData.oneLiner = parsed.data.oneLiner;
  if (parsed.data.url !== undefined) updateData.url = parsed.data.url || null;
  if (parsed.data.sector !== undefined) updateData.sector = parsed.data.sector;

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

export default app;
