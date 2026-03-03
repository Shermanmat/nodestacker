import { Context, Next } from 'hono';
import { getAdminSession } from '../admin-auth.js';

// Check if running in local dev mode
const isLocalDev = !process.env.BASE_URL || process.env.BASE_URL.includes('localhost');

/**
 * Middleware to protect admin routes
 * Requires X-Admin-Session header with valid session ID
 * Bypasses auth for local development
 */
export async function adminGuard(c: Context, next: Next) {
  // Bypass auth for local development
  if (isLocalDev) {
    c.set('admin', { email: 'mat@matsherman.com' });
    await next();
    return;
  }

  const sessionId = c.req.header('X-Admin-Session');
  const admin = await getAdminSession(sessionId);

  if (!admin) {
    return c.json({ error: 'Unauthorized - admin login required' }, 401);
  }

  // Attach admin to context for use in routes
  c.set('admin', admin);
  await next();
}
