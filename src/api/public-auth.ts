import { Hono } from 'hono';
import { eq, and, lt } from 'drizzle-orm';
import { db, publicUsers, publicSessions } from '../db/index.js';
import { z } from 'zod';
import crypto from 'crypto';
import * as postmark from 'postmark';

const app = new Hono();

// Initialize Postmark client
const postmarkClient = process.env.POSTMARK_API_KEY
  ? new postmark.ServerClient(process.env.POSTMARK_API_KEY)
  : null;

// In-memory token store for magic links (use Redis in production)
const tokens = new Map<string, { email: string; expires: Date }>();

// Auto-add https:// to LinkedIn URLs
function normalizeLinkedinUrl(url: string | undefined): string | null {
  if (!url || url.trim() === '') return null;
  url = url.trim();
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return url;
  }
  // Handle linkedin.com/in/... or www.linkedin.com/in/...
  if (url.startsWith('linkedin.com') || url.startsWith('www.linkedin.com')) {
    return 'https://' + url;
  }
  // Handle just the username like "in/johndoe" or "johndoe"
  if (url.startsWith('in/')) {
    return 'https://linkedin.com/' + url;
  }
  // Assume it's just a username
  if (!url.includes('/') && !url.includes('.')) {
    return 'https://linkedin.com/in/' + url;
  }
  return 'https://' + url;
}

const signupSchema = z.object({
  firstName: z.string().min(1, 'First name is required'),
  lastName: z.string().min(1, 'Last name is required'),
  email: z.string().email('Invalid email'),
  role: z.enum(['founder', 'node', 'investor', 'other']).optional(),
  roleOther: z.string().optional(),
  oneLiner: z.string().min(1, 'One-liner intro is required'),
  city: z.string().min(1, 'City is required'),
  linkedinUrl: z.string().optional(),
  twitterHandle: z.string().optional(),
});

// Sign up - create new account
app.post('/signup', async (c) => {
  const body = await c.req.json();
  const parsed = signupSchema.safeParse(body);

  if (!parsed.success) {
    const errorMsg = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ');
    return c.json({ error: errorMsg }, 400);
  }

  // Check if email already exists
  const existing = await db.query.publicUsers.findFirst({
    where: eq(publicUsers.email, parsed.data.email),
  });

  if (existing) {
    return c.json({ error: 'An account with this email already exists' }, 400);
  }

  const now = new Date().toISOString();

  // Create user
  const [user] = await db.insert(publicUsers).values({
    firstName: parsed.data.firstName,
    lastName: parsed.data.lastName,
    email: parsed.data.email,
    role: parsed.data.role || null,
    roleOther: parsed.data.role === 'other' ? (parsed.data.roleOther || null) : null,
    oneLiner: parsed.data.oneLiner,
    city: parsed.data.city,
    linkedinUrl: normalizeLinkedinUrl(parsed.data.linkedinUrl),
    twitterHandle: parsed.data.twitterHandle || null,
    createdAt: now,
  }).returning();

  // Generate token for immediate login
  const token = crypto.randomBytes(32).toString('hex');
  const tokenExpires = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes
  tokens.set(token, { email: user.email, expires: tokenExpires });

  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
  const magicLink = `${baseUrl}/dashboard?token=${token}`;

  console.log(`\n🎉 New public user signed up: ${user.firstName} ${user.lastName} (${user.email})`);
  console.log(`🔐 Login link: ${magicLink}\n`);

  // Send welcome email with login link
  if (postmarkClient) {
    try {
      await postmarkClient.sendEmail({
        From: process.env.POSTMARK_FROM_EMAIL || 'mat@matsherman.com',
        To: user.email,
        Subject: 'Welcome to MatCap Network',
        HtmlBody: `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
            <h2>Welcome, ${user.firstName}!</h2>
            <p>Your MatCap Network account has been created. Click the button below to access your dashboard:</p>
            <p style="margin: 30px 0;">
              <a href="${magicLink}" style="background-color: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
                Go to Dashboard
              </a>
            </p>
            <p style="color: #666; font-size: 14px;">This link expires in 15 minutes. You can always request a new one from the login page.</p>
          </div>
        `,
        TextBody: `Welcome, ${user.firstName}!\n\nYour MatCap Network account has been created.\n\nClick here to access your dashboard: ${magicLink}\n\nThis link expires in 15 minutes.`,
      });
      console.log(`✅ Welcome email sent to ${user.email}`);
    } catch (err) {
      console.error('Failed to send welcome email:', err);
    }
  }

  return c.json({
    success: true,
    message: 'Account created! Check your email for a login link.',
    user: {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
    },
  }, 201);
});

// Request magic link for login
app.post('/login', async (c) => {
  const body = await c.req.json();
  const schema = z.object({ email: z.string().email() });
  const parsed = schema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'Invalid email' }, 400);
  }

  const user = await db.query.publicUsers.findFirst({
    where: eq(publicUsers.email, parsed.data.email),
  });

  if (!user) {
    // Don't reveal if email exists or not
    return c.json({ success: true, message: 'If this email exists, a magic link has been sent.' });
  }

  // Generate token
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

  tokens.set(token, { email: user.email, expires });

  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
  const magicLink = `${baseUrl}/dashboard?token=${token}`;

  console.log(`\n🔐 Magic link for ${user.email}:\n${magicLink}\n`);

  // Send email via Postmark
  if (postmarkClient) {
    try {
      await postmarkClient.sendEmail({
        From: process.env.POSTMARK_FROM_EMAIL || 'mat@matsherman.com',
        To: user.email,
        Subject: 'Your MatCap Login Link',
        HtmlBody: `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
            <h2>Hi ${user.firstName},</h2>
            <p>Click the button below to log in to your MatCap dashboard:</p>
            <p style="margin: 30px 0;">
              <a href="${magicLink}" style="background-color: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
                Log In to MatCap
              </a>
            </p>
            <p style="color: #666; font-size: 14px;">This link expires in 15 minutes.</p>
            <p style="color: #666; font-size: 14px;">If you didn't request this, you can ignore this email.</p>
          </div>
        `,
        TextBody: `Hi ${user.firstName},\n\nClick here to log in to MatCap: ${magicLink}\n\nThis link expires in 15 minutes.`,
      });
      console.log(`✅ Email sent to ${user.email}`);
    } catch (err) {
      console.error('Failed to send email:', err);
    }
  }

  return c.json({
    success: true,
    message: 'If this email exists, a magic link has been sent.',
  });
});

// Verify token and create session
app.post('/verify', async (c) => {
  const body = await c.req.json();
  const schema = z.object({ token: z.string() });
  const parsed = schema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'Invalid token' }, 400);
  }

  const tokenData = tokens.get(parsed.data.token);

  if (!tokenData) {
    return c.json({ error: 'Invalid or expired token' }, 401);
  }

  if (new Date() > tokenData.expires) {
    tokens.delete(parsed.data.token);
    return c.json({ error: 'Token expired' }, 401);
  }

  // Find user
  const user = await db.query.publicUsers.findFirst({
    where: eq(publicUsers.email, tokenData.email),
  });

  if (!user) {
    tokens.delete(parsed.data.token);
    return c.json({ error: 'User not found' }, 404);
  }

  // Create session (stored in DB for persistence)
  const sessionId = crypto.randomBytes(32).toString('hex');
  const sessionExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
  const now = new Date().toISOString();

  await db.insert(publicSessions).values({
    id: sessionId,
    userId: user.id,
    expiresAt: sessionExpires.toISOString(),
    createdAt: now,
  });

  tokens.delete(parsed.data.token);

  return c.json({
    success: true,
    sessionId,
    user: {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      oneLiner: user.oneLiner,
      city: user.city,
      linkedinUrl: user.linkedinUrl,
      twitterHandle: user.twitterHandle,
    },
  });
});

// Get current session
app.get('/session', async (c) => {
  const sessionId = c.req.header('X-Public-Session');

  if (!sessionId) {
    return c.json({ error: 'No session' }, 401);
  }

  const session = await db.query.publicSessions.findFirst({
    where: eq(publicSessions.id, sessionId),
  });

  if (!session || new Date() > new Date(session.expiresAt)) {
    if (session) {
      await db.delete(publicSessions).where(eq(publicSessions.id, sessionId));
    }
    return c.json({ error: 'Session expired' }, 401);
  }

  const user = await db.query.publicUsers.findFirst({
    where: eq(publicUsers.id, session.userId),
  });

  if (!user) {
    return c.json({ error: 'User not found' }, 404);
  }

  return c.json({
    user: {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      oneLiner: user.oneLiner,
      city: user.city,
      linkedinUrl: user.linkedinUrl,
      twitterHandle: user.twitterHandle,
    },
  });
});

// Logout
app.post('/logout', async (c) => {
  const sessionId = c.req.header('X-Public-Session');
  if (sessionId) {
    await db.delete(publicSessions).where(eq(publicSessions.id, sessionId));
  }
  return c.json({ success: true });
});

// Helper to get user ID from session (for use in other routes)
export async function getPublicSessionUserId(sessionId: string | undefined): Promise<number | null> {
  if (!sessionId) return null;

  const session = await db.query.publicSessions.findFirst({
    where: eq(publicSessions.id, sessionId),
  });

  if (!session || new Date() > new Date(session.expiresAt)) {
    if (session) {
      await db.delete(publicSessions).where(eq(publicSessions.id, sessionId));
    }
    return null;
  }

  return session.userId;
}

// Cleanup expired sessions (run hourly)
setInterval(async () => {
  try {
    const now = new Date().toISOString();
    await db.delete(publicSessions).where(lt(publicSessions.expiresAt, now));
  } catch (err) {
    console.error('[PUBLIC-AUTH] Failed to cleanup expired sessions:', err);
  }
}, 60 * 60 * 1000);

// Save node contacts (investor connections from signup)
app.post('/node-contacts', async (c) => {
  const body = await c.req.json();
  const schema = z.object({
    email: z.string().email(),
    contacts: z.array(z.object({
      name: z.string().min(1),
      firm: z.string().optional(),
    })).min(1).max(3),
  });

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid data' }, 400);
  }

  const user = await db.query.publicUsers.findFirst({
    where: eq(publicUsers.email, parsed.data.email),
  });

  if (!user) {
    return c.json({ error: 'User not found' }, 404);
  }

  await db.update(publicUsers)
    .set({ nodeContacts: JSON.stringify(parsed.data.contacts) })
    .where(eq(publicUsers.id, user.id));

  console.log(`[NODE-CONTACTS] ${user.firstName} ${user.lastName} submitted ${parsed.data.contacts.length} investor contacts`);

  return c.json({ success: true });
});

export default app;
