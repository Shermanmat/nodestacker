/**
 * Send the stage-1 intro ask (founder blurb → investor) through the MatCap app
 * itself (Postmark), not as a Gmail draft. This is the send that fires when an
 * admin approves a pending suggestion in the dashboard — all comms run through
 * the app, nothing is staged in a personal inbox.
 */

import { eq } from 'drizzle-orm';
import { db, introRequests, founders, investors, nodes } from '../db/index.js';
import { buildAskEmail } from './gmail.js';
import { sendEmail } from './email.js';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export interface IntroAskResult {
  sent: boolean;
  reason?: string;
  to?: string;
  subject?: string;
}

/**
 * Build + send the stage-1 ask for one intro request. Returns {sent:false,reason}
 * when it can't send (missing investor email / records) rather than throwing, so
 * the caller can surface a clean message to the admin.
 */
export async function sendIntroAsk(introRequestId: number): Promise<IntroAskResult> {
  const intro = await db.query.introRequests.findFirst({ where: eq(introRequests.id, introRequestId) });
  if (!intro) return { sent: false, reason: 'Intro request not found' };

  const founder = await db.query.founders.findFirst({ where: eq(founders.id, intro.founderId) });
  const investor = await db.query.investors.findFirst({ where: eq(investors.id, intro.investorId) });
  const node = intro.nodeId ? await db.query.nodes.findFirst({ where: eq(nodes.id, intro.nodeId) }) : null;

  if (!founder) return { sent: false, reason: 'Founder not found' };
  if (!investor) return { sent: false, reason: 'Investor not found' };
  if (!investor.email) return { sent: false, reason: `${investor.name} has no email on file — add one before sending.` };

  const { subject, body } = buildAskEmail({
    founder: {
      name: founder.name,
      companyName: founder.companyName,
      email: founder.email,
      blurb: founder.blurb,
      companyStage: founder.companyStage,
      deckUrl: founder.deckUrl,
      calendlyUrl: founder.calendlyUrl,
    },
    investor: { name: investor.name, firm: investor.firm, role: investor.role },
    node: node ? { name: node.name } : null,
  });

  // Plain-text blurb → simple HTML (preserve line breaks).
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a">${escapeHtml(body).replace(/\n/g, '<br>')}</div>`;

  // Stage 1 carries the founder's deck if one's uploaded.
  const attachments: Array<{ path: string; name: string; contentType?: string }> = [];
  if (founder.deckFile) {
    const dataDir = process.env.DATA_DIR || (process.env.NODE_ENV === 'production' ? '/app/data' : '.');
    attachments.push({
      path: `${dataDir}/decks/${founder.deckFile}`,
      name: `${founder.companyName || founder.name} Deck.pdf`,
      contentType: 'application/pdf',
    });
  }

  const result = await sendEmail({
    to: investor.email,
    subject,
    html,
    text: body,
    attachments: attachments.length ? attachments : undefined,
  });

  if (!result.success) return { sent: false, reason: result.error || 'Send failed', to: investor.email };
  return { sent: true, to: investor.email, subject };
}
