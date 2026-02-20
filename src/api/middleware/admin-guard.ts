import { Context, Next } from 'hono';
import { getAdminSession } from '../admin-auth.js';

/**
 * Middleware to protect admin routes
 * Requires X-Admin-Session header with valid session ID
 */
export async function adminGuard(c: Context, next: Next) {
  const sessionId = c.req.header('X-Admin-Session');
  const admin = getAdminSession(sessionId);

  if (!admin) {
    return c.json({ error: 'Unauthorized - admin login required' }, 401);
  }

  // Attach admin to context for use in routes
  c.set('admin', admin);
  await next();
}
