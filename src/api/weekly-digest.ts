import { Hono } from 'hono';
import { sendWeeklyDigests, previewDigest, sendDigestPreviewToAdmin } from '../services/weekly-digest.js';

const app = new Hono();

/**
 * Trigger weekly digest emails to all founders with activity
 * POST /api/weekly-digest/send
 *
 * Can be called by:
 * - Cron job (with token auth)
 * - Admin manually
 */
app.post('/send', async (c) => {
  // Allow token auth for cron jobs
  const token = c.req.query('token');
  const expectedToken = process.env.CRON_SECRET;

  // If token provided, verify it (for cron)
  // If no token, rely on admin guard middleware
  if (token && expectedToken && token !== expectedToken) {
    return c.json({ error: 'Invalid token' }, 401);
  }

  console.log('[WEEKLY-DIGEST] Starting weekly digest send...');
  const result = await sendWeeklyDigests();

  return c.json({
    success: true,
    ...result,
  });
});

/**
 * Trigger an admin preview email — same content the cron sends Friday 4pm AZ.
 * POST /api/weekly-digest/preview-admin
 * Admin-protected (mounted under adminGuard via /api/weekly-digest/preview/*).
 */
app.post('/preview-admin', async (c) => {
  const result = await sendDigestPreviewToAdmin();
  return c.json({ success: result.sent, ...result });
});

/**
 * Preview digest for a specific founder (for testing)
 * GET /api/weekly-digest/preview/:founderId
 */
app.get('/preview/:founderId', async (c) => {
  const founderId = parseInt(c.req.param('founderId'));

  const preview = await previewDigest(founderId);

  if (!preview) {
    return c.json({ error: 'No activity to show for this founder' }, 404);
  }

  // Return HTML preview
  const format = c.req.query('format');
  if (format === 'html') {
    return c.html(preview.html);
  }

  return c.json({
    subject: preview.subject,
    html: preview.html,
    text: preview.text,
  });
});

export default app;
