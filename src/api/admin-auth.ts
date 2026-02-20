import { Hono } from 'hono';
import { z } from 'zod';
import crypto from 'crypto';
import * as postmark from 'postmark';

const app = new Hono();

// Allowed admin emails
const ADMIN_EMAILS = ['mat@matsherman.com'];

// Initialize Postmark client
const postmarkClient = process.env.POSTMARK_API_KEY
  ? new postmark.ServerClient(process.env.POSTMARK_API_KEY)
  : null;

// In-memory token store (use Redis in production)
const adminTokens = new Map<string, { email: string; expires: Date }>();
const adminSessions = new Map<string, { email: string; expires: Date }>();

// Request magic link
app.post('/magic-link', async (c) => {
  const body = await c.req.json();
  const schema = z.object({ email: z.string().email() });
  const parsed = schema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'Invalid email' }, 400);
  }

  const email = parsed.data.email.toLowerCase();

  // Check if email is an admin
  if (!ADMIN_EMAILS.includes(email)) {
    // Don't reveal if email is admin or not
    return c.json({ success: true, message: 'If this email is registered as admin, a magic link has been sent.' });
  }

  // Generate token
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

  adminTokens.set(token, { email, expires });

  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
  const magicLink = `${baseUrl}/?admin_token=${token}`;

  console.log(`\n🔐 Admin magic link for ${email}:\n${magicLink}\n`);

  // Send email via Postmark
  if (postmarkClient) {
    try {
      await postmarkClient.sendEmail({
        From: process.env.POSTMARK_FROM_EMAIL || 'mat@matsherman.com',
        To: email,
        Subject: 'NodeStacker Admin Login',
        HtmlBody: `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
            <h2>Admin Login</h2>
            <p>Click the button below to log in to the NodeStacker admin dashboard:</p>
            <p style="margin: 30px 0;">
              <a href="${magicLink}" style="background-color: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
                Log In to Admin
              </a>
            </p>
            <p style="color: #666; font-size: 14px;">This link expires in 15 minutes.</p>
            <p style="color: #666; font-size: 14px;">If you didn't request this, you can ignore this email.</p>
          </div>
        `,
        TextBody: `Admin Login\n\nClick here to log in to NodeStacker admin: ${magicLink}\n\nThis link expires in 15 minutes.`,
      });
      console.log(`✅ Admin email sent to ${email}`);
    } catch (err) {
      console.error('Failed to send admin email:', err);
    }
  }

  return c.json({
    success: true,
    message: 'If this email is registered as admin, a magic link has been sent.',
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

  const tokenData = adminTokens.get(parsed.data.token);

  if (!tokenData) {
    return c.json({ error: 'Invalid or expired token' }, 401);
  }

  if (new Date() > tokenData.expires) {
    adminTokens.delete(parsed.data.token);
    return c.json({ error: 'Token expired' }, 401);
  }

  // Create session
  const sessionId = crypto.randomBytes(32).toString('hex');
  const sessionExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  adminSessions.set(sessionId, { email: tokenData.email, expires: sessionExpires });
  adminTokens.delete(parsed.data.token);

  return c.json({
    success: true,
    sessionId,
    admin: {
      email: tokenData.email,
    },
  });
});

// Get current session
app.get('/session', async (c) => {
  const sessionId = c.req.header('X-Admin-Session');

  if (!sessionId) {
    return c.json({ error: 'No session' }, 401);
  }

  const session = adminSessions.get(sessionId);

  if (!session || new Date() > session.expires) {
    if (session) adminSessions.delete(sessionId);
    return c.json({ error: 'Session expired' }, 401);
  }

  return c.json({
    admin: {
      email: session.email,
    },
  });
});

// Logout
app.post('/logout', async (c) => {
  const sessionId = c.req.header('X-Admin-Session');
  if (sessionId) {
    adminSessions.delete(sessionId);
  }
  return c.json({ success: true });
});

// Helper to validate admin session (for use in middleware)
export function getAdminSession(sessionId: string | undefined): { email: string } | null {
  if (!sessionId) return null;
  const session = adminSessions.get(sessionId);
  if (!session || new Date() > session.expires) {
    if (session) adminSessions.delete(sessionId);
    return null;
  }
  return { email: session.email };
}

export default app;
