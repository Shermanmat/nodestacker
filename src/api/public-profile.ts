import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, publicUsers, publicSessions } from '../db/index.js';
import { z } from 'zod';

const app = new Hono();

// Auto-add https:// to LinkedIn URLs
function normalizeLinkedinUrl(url: string | undefined | null): string | null {
  if (!url || url.trim() === '') return null;
  url = url.trim();
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return url;
  }
  if (url.startsWith('linkedin.com') || url.startsWith('www.linkedin.com')) {
    return 'https://' + url;
  }
  if (url.startsWith('in/')) {
    return 'https://linkedin.com/' + url;
  }
  if (!url.includes('/') && !url.includes('.')) {
    return 'https://linkedin.com/in/' + url;
  }
  return 'https://' + url;
}

// Middleware to validate public session
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

const updateProfileSchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  oneLiner: z.string().optional(),
  city: z.string().optional(),
  linkedinUrl: z.string().optional().or(z.literal('')).or(z.null()),
  twitterHandle: z.string().optional().or(z.null()),
});

// Get current user profile
app.get('/me', async (c) => {
  const user = await getAuthenticatedUser(c);

  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  return c.json({
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    oneLiner: user.oneLiner,
    city: user.city,
    linkedinUrl: user.linkedinUrl,
    twitterHandle: user.twitterHandle,
    createdAt: user.createdAt,
  });
});

// Update current user profile
app.put('/me', async (c) => {
  const user = await getAuthenticatedUser(c);

  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const body = await c.req.json();
  const parsed = updateProfileSchema.safeParse(body);

  if (!parsed.success) {
    const errorMsg = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ');
    return c.json({ error: errorMsg }, 400);
  }

  // Build update object, only including provided fields
  const updateData: Record<string, unknown> = {};
  if (parsed.data.firstName !== undefined) updateData.firstName = parsed.data.firstName;
  if (parsed.data.lastName !== undefined) updateData.lastName = parsed.data.lastName;
  if (parsed.data.oneLiner !== undefined) updateData.oneLiner = parsed.data.oneLiner;
  if (parsed.data.city !== undefined) updateData.city = parsed.data.city;
  if (parsed.data.linkedinUrl !== undefined) updateData.linkedinUrl = normalizeLinkedinUrl(parsed.data.linkedinUrl);
  if (parsed.data.twitterHandle !== undefined) updateData.twitterHandle = parsed.data.twitterHandle || null;

  if (Object.keys(updateData).length === 0) {
    return c.json({ error: 'No fields to update' }, 400);
  }

  const [updated] = await db.update(publicUsers)
    .set(updateData)
    .where(eq(publicUsers.id, user.id))
    .returning();

  return c.json({
    id: updated.id,
    firstName: updated.firstName,
    lastName: updated.lastName,
    email: updated.email,
    oneLiner: updated.oneLiner,
    city: updated.city,
    linkedinUrl: updated.linkedinUrl,
    twitterHandle: updated.twitterHandle,
    createdAt: updated.createdAt,
  });
});

export default app;
