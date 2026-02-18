import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, founders } from '../db/index.js';
import { z } from 'zod';
import crypto from 'crypto';
import * as postmark from 'postmark';

const app = new Hono();

// Initialize Postmark client
const postmarkClient = process.env.POSTMARK_API_KEY
  ? new postmark.ServerClient(process.env.POSTMARK_API_KEY)
  : null;

// In-memory token store (use Redis in production)
const tokens = new Map<string, { founderId: number; expires: Date }>();
const sessions = new Map<string, { founderId: number; expires: Date }>();

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
        Subject: 'Your NodeStacker Login Link',
        HtmlBody: `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
            <h2>Hi ${founder.name},</h2>
            <p>Click the button below to log in to your NodeStacker founder portal:</p>
            <p style="margin: 30px 0;">
              <a href="${magicLink}" style="background-color: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
                Log In to NodeStacker
              </a>
            </p>
            <p style="color: #666; font-size: 14px;">This link expires in 15 minutes.</p>
            <p style="color: #666; font-size: 14px;">If you didn't request this, you can ignore this email.</p>
          </div>
        `,
        TextBody: `Hi ${founder.name},\n\nClick here to log in to NodeStacker: ${magicLink}\n\nThis link expires in 15 minutes.`,
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

  // Create session
  const sessionId = crypto.randomBytes(32).toString('hex');
  const sessionExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  sessions.set(sessionId, { founderId: tokenData.founderId, expires: sessionExpires });
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

  const session = sessions.get(sessionId);

  if (!session || new Date() > session.expires) {
    if (session) sessions.delete(sessionId);
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
    sessions.delete(sessionId);
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
        Subject: `You're invited to NodeStacker`,
        HtmlBody: `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
            <h2>Hi ${founder.name},</h2>
            <p>You've been invited to NodeStacker - your founder portal for managing investor intros.</p>
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
        TextBody: `Hi ${founder.name},\n\nYou've been invited to NodeStacker - your founder portal for managing investor intros.\n\nClick here to access your dashboard: ${magicLink}\n\nThis link expires in 7 days.\n\nBest,\nMat`,
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
export function getSessionFounderId(sessionId: string | undefined): number | null {
  if (!sessionId) return null;
  const session = sessions.get(sessionId);
  if (!session || new Date() > session.expires) {
    if (session) sessions.delete(sessionId);
    return null;
  }
  return session.founderId;
}

export default app;
