import { Hono } from 'hono';
import { eq, lt } from 'drizzle-orm';
import { db, founders, founderSessions } from '../db/index.js';
import { z } from 'zod';
import crypto from 'crypto';
import * as postmark from 'postmark';

const app = new Hono();

// Initialize Postmark client
const postmarkClient = process.env.POSTMARK_API_KEY
  ? new postmark.ServerClient(process.env.POSTMARK_API_KEY)
  : null;

// Magic-link tokens are short-lived (15 min) and kept in memory. Founder
// sessions, by contrast, are persisted in the DB (founder_sessions) so a login
// survives server restarts and deploys — an in-memory session map logs every
// founder out on every deploy.
const tokens = new Map<string, { founderId: number; expires: Date }>();

// How long a founder stays logged in (4 weeks).
const SESSION_TTL_MS = 28 * 24 * 60 * 60 * 1000;

// Sweep expired founder sessions hourly.
setInterval(async () => {
  try {
    await db.delete(founderSessions).where(lt(founderSessions.expiresAt, new Date().toISOString()));
  } catch (err) {
    console.error('[auth] founder_sessions cleanup failed:', err);
  }
}, 60 * 60 * 1000);

// Request magic link
app.post('/magic-link', async (c) => {
  const body = await c.req.json();
  const schema = z.object({ email: z.string().email() });
  const parsed = schema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'Invalid email' }, 400);
  }

  const founder = await db.query.founders.findFirst({
    where: eq(founders.email, parsed.data.email),
  });

  if (!founder) {
    // Don't reveal if email exists or not
    return c.json({ success: true, message: 'If this email exists, a magic link has been sent.' });
  }

  // Generate token
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

  tokens.set(token, { founderId: founder.id, expires });

  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
  const magicLink = `${baseUrl}/founder?token=${token}`;

  console.log(`\n🔐 Magic link for ${founder.email}:\n${magicLink}\n`);

  // Send email via Postmark
  if (postmarkClient) {
    try {
      await postmarkClient.sendEmail({
        From: process.env.POSTMARK_FROM_EMAIL || 'mat@matsherman.com',
        To: founder.email,
        Subject: 'Your MatCap Login Link',
        HtmlBody: `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
            <h2>Hi ${founder.name},</h2>
            <p>Click the button below to log in to your MatCap founder portal:</p>
            <p style="margin: 30px 0;">
              <a href="${magicLink}" style="background-color: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
                Log In to MatCap
              </a>
            </p>
            <p style="color: #666; font-size: 14px;">This link expires in 15 minutes.</p>
            <p style="color: #666; font-size: 14px;">If you didn't request this, you can ignore this email.</p>
          </div>
        `,
        TextBody: `Hi ${founder.name},\n\nClick here to log in to MatCap: ${magicLink}\n\nThis link expires in 15 minutes.`,
      });
      console.log(`✅ Email sent to ${founder.email}`);
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

  // Create a persisted session (survives restarts/deploys), valid for 4 weeks.
  const sessionId = crypto.randomBytes(32).toString('hex');
  const nowIso = new Date().toISOString();
  await db.insert(founderSessions).values({
    id: sessionId,
    founderId: tokenData.founderId,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    createdAt: nowIso,
  });
  tokens.delete(parsed.data.token);

  const founder = await db.query.founders.findFirst({
    where: eq(founders.id, tokenData.founderId),
  });

  return c.json({
    success: true,
    sessionId,
    founder: {
      id: founder!.id,
      name: founder!.name,
      email: founder!.email,
      companyName: founder!.companyName,
    },
  });
});

// Get current session
app.get('/session', async (c) => {
  const sessionId = c.req.header('X-Session-Id');

  if (!sessionId) {
    return c.json({ error: 'No session' }, 401);
  }

  const session = await db.query.founderSessions.findFirst({
    where: eq(founderSessions.id, sessionId),
  });

  if (!session || new Date() > new Date(session.expiresAt)) {
    if (session) await db.delete(founderSessions).where(eq(founderSessions.id, sessionId));
    return c.json({ error: 'Session expired' }, 401);
  }

  const founder = await db.query.founders.findFirst({
    where: eq(founders.id, session.founderId),
  });

  if (!founder) {
    return c.json({ error: 'Founder not found' }, 404);
  }

  return c.json({
    founder: {
      id: founder.id,
      name: founder.name,
      email: founder.email,
      companyName: founder.companyName,
      companyStage: founder.companyStage,
      roundStatus: founder.roundStatus,
    },
  });
});

// Logout
app.post('/logout', async (c) => {
  const sessionId = c.req.header('X-Session-Id');
  if (sessionId) {
    await db.delete(founderSessions).where(eq(founderSessions.id, sessionId));
  }
  return c.json({ success: true });
});

// Admin: Generate login link for any founder (for impersonation/invites)
app.post('/admin/generate-link/:founderId', async (c) => {
  const founderId = parseInt(c.req.param('founderId'));
  const body = await c.req.json().catch(() => ({}));
  const sendEmail = body.sendEmail === true;

  const founder = await db.query.founders.findFirst({
    where: eq(founders.id, founderId),
  });

  if (!founder) {
    return c.json({ error: 'Founder not found' }, 404);
  }

  // Generate token with longer expiry for invite links (7 days)
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  tokens.set(token, { founderId: founder.id, expires });

  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
  const magicLink = `${baseUrl}/founder?token=${token}`;

  console.log(`\n🔐 Admin generated link for ${founder.name} (${founder.email}):\n${magicLink}\n`);

  let emailSent = false;

  // Optionally send invite email
  if (sendEmail && postmarkClient) {
    try {
      await postmarkClient.sendEmail({
        From: process.env.POSTMARK_FROM_EMAIL || 'mat@matsherman.com',
        To: founder.email,
        Subject: `You're invited to MatCap`,
        HtmlBody: `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
            <h2>Hi ${founder.name},</h2>
            <p>You've been invited to MatCap - your founder portal for managing investor intros.</p>
            <p>Click the button below to access your dashboard:</p>
            <p style="margin: 30px 0;">
              <a href="${magicLink}" style="background-color: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
                Access Your Portal
              </a>
            </p>
            <p style="color: #666; font-size: 14px;">This link expires in 7 days. You can always request a new one from the login page.</p>
            <p>Best,<br>Mat</p>
          </div>
        `,
        TextBody: `Hi ${founder.name},\n\nYou've been invited to MatCap - your founder portal for managing investor intros.\n\nClick here to access your dashboard: ${magicLink}\n\nThis link expires in 7 days.\n\nBest,\nMat`,
      });
      emailSent = true;
      console.log(`✅ Invite email sent to ${founder.email}`);
    } catch (err) {
      console.error('Failed to send invite email:', err);
    }
  }

  return c.json({
    success: true,
    founder: {
      id: founder.id,
      name: founder.name,
      email: founder.email,
    },
    magicLink,
    expiresAt: expires.toISOString(),
    emailSent,
  });
});

// Helper to validate session (for use in other routes)
export async function getSessionFounderId(sessionId: string | undefined): Promise<number | null> {
  if (!sessionId) return null;
  const session = await db.query.founderSessions.findFirst({
    where: eq(founderSessions.id, sessionId),
  });
  if (!session || new Date() > new Date(session.expiresAt)) {
    if (session) await db.delete(founderSessions).where(eq(founderSessions.id, sessionId));
    return null;
  }
  return session.founderId;
}

export default app;
