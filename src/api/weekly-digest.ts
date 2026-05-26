import { Hono } from 'hono';
import { desc } from 'drizzle-orm';
import { sendWeeklyDigests, previewDigest, sendDigestPreviewToAdmin } from '../services/weekly-digest.js';
import { db, cronRuns } from '../db/index.js';

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

  // Optional apology / context note prepended to every founder's email.
  // Used after a missed scheduled send so the off-cycle delivery doesn't
  // feel unexplained.
  const body = await c.req.json().catch(() => ({} as any));
  const apology: string | undefined = (body?.apology || '').trim() || undefined;

  let preludeHtml: string | undefined;
  let preludeText: string | undefined;
  if (apology) {
    const safeApology = apology
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>');
    preludeHtml = `<div style="border-left:3px solid #00C2E0;padding:10px 14px;background:#f0fbfd;margin:0 0 22px 0;color:#333;font-size:14px;line-height:1.55;border-radius:2px"><strong>Quick note:</strong> ${safeApology}</div>`;
    preludeText = `Quick note: ${apology}\n\n`;
  }

  console.log('[WEEKLY-DIGEST] Starting weekly digest send...', apology ? '(with apology note)' : '');
  const result = await sendWeeklyDigests({ preludeHtml, preludeText });

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

// Recent cron runs — last 50 across all jobs. Admin-only.
app.get('/cron-runs', async (c) => {
  const rows = await db.select().from(cronRuns).orderBy(desc(cronRuns.startedAt)).limit(50);
  return c.json({ rows });
});

export default app;
