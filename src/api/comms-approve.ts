/**
 * One-click approve for founder comms change-requests (blurb + deck).
 *
 * Clicked from the notification email the admin receives — the unguessable
 * token IS the auth, so there's no login and no admin UI. Approving swaps the
 * founder's staged edit into what we send: a deck request promotes the proposed
 * PDF to founders.deckFile; a blurb request writes the proposed text to
 * founders.blurb (the exact text used in intros).
 *
 * Mounted at /comms/approve (NOT under the session-guarded portal router).
 */

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, commsChangeRequests, founders } from '../db/index.js';

const app = new Hono();

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>` +
    `<body style="font-family:-apple-system,sans-serif;background:#f5f5f5;margin:0"><div style="max-width:480px;margin:64px auto;background:#fff;border-radius:14px;padding:36px;text-align:center;box-shadow:0 8px 30px rgba(0,0,0,0.08)">` +
    `<h2 style="margin:0 0 10px">${title}</h2><p style="color:#555;line-height:1.5;margin:0">${body}</p></div></body></html>`;
}

app.get('/:token', async (c) => {
  const token = c.req.param('token');
  const reqRow = await db.query.commsChangeRequests.findFirst({ where: eq(commsChangeRequests.approveToken, token) });
  if (!reqRow) return c.html(page('Link not found', 'This approval link is invalid or has been superseded.'), 404);
  if (reqRow.status !== 'pending') return c.html(page('Already handled', `This request was already <b>${reqRow.status}</b>.`));

  const founder = await db.query.founders.findFirst({ where: eq(founders.id, reqRow.founderId) });
  const now = new Date().toISOString();
  let message: string;

  if (reqRow.kind === 'deck' && reqRow.proposedDeckFile) {
    // Promote the staged proposed deck to the live deck.
    const fs = await import('fs/promises');
    const path = await import('path');
    const decksDir = (process.env.DATA_DIR || (process.env.NODE_ENV === 'production' ? '/app/data' : '.')) + '/decks';
    if (founder?.deckFile && founder.deckFile !== reqRow.proposedDeckFile) {
      try { await fs.unlink(path.join(decksDir, founder.deckFile)); } catch { /* ok if already gone */ }
    }
    await db.update(founders).set({ deckFile: reqRow.proposedDeckFile }).where(eq(founders.id, reqRow.founderId));
    message = `<b>${founder?.name || 'The founder'}'s</b> new deck is now live and will attach to future intros.`;
  } else if (reqRow.kind === 'blurb' && reqRow.proposedBlurb) {
    // Promote the proposed blurb to the live blurb — this is exactly what we
    // send out in intros, so approving makes the founder's edit go live.
    await db.update(founders).set({ blurb: reqRow.proposedBlurb }).where(eq(founders.id, reqRow.founderId));
    message = `<b>${founder?.name || 'The founder'}'s</b> new blurb is now live and will be used in future intros.`;
  } else {
    message = `Marked <b>${founder?.name || 'the founder'}'s</b> request as handled.`;
  }

  await db.update(commsChangeRequests).set({ status: 'approved', resolvedAt: now }).where(eq(commsChangeRequests.id, reqRow.id));
  return c.html(page('Approved ✓', message));
});

export default app;
