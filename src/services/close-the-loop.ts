/**
 * Close-the-loop nudges — email founders to report how an intro went while it's
 * still sitting in 'introduced' (intro made, outcome unknown).
 *
 * Cadence: one nudge at 10 days, a second at 20 days, then stop. Driven by
 * introRequests.closeLoopNudgeCount (0 → 10-day, 1 → 20-day, ≥2 → done). Each
 * founder gets ONE digest listing all their open-loop intros, each with a
 * deep-link that logs them in and opens that intro's outcome reporter.
 *
 * Nothing here promises intros — it only asks the founder to close the loop on
 * ones we already made.
 */
import { and, eq, lt, inArray } from 'drizzle-orm';
import crypto from 'crypto';
import { db, introRequests, founders, founderMagicTokens } from '../db/index.js';
import { sendEmail } from './email.js';

const NUDGE_1_DAYS = 10;   // first nudge this many days after the intro was made
const NUDGE_2_DAYS = 20;   // second (and final) nudge
const MAX_NUDGES = 2;
// Don't nudge intros older than this. Past ~6 weeks a still-'introduced' intro is
// stale, not awaiting a fresh outcome — a reminder just creates noise. This also
// keeps the historical backlog (intros that predate the outcome reporter) from
// blasting out the moment the cron is enabled.
const NUDGE_MAX_AGE_DAYS = 45;
// Never list more than this many intros in one founder's email. A founder with a
// bigger backlog gets the most recent few now and the rest on following days as
// these advance — nobody gets a "27 intros waiting" email.
const PER_FOUNDER_CAP = 6;
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;  // deep-link login token lifetime

function daysBetween(fromIso: string, to: Date): number {
  const from = new Date(fromIso);
  if (isNaN(from.getTime())) return -1;
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}

/** The date an intro was made — dateIntroduced when present, else the last update. */
function introducedAt(ir: any): string | null {
  return ir.dateIntroduced || (ir.updatedAt ? ir.updatedAt.split('T')[0] : null) || ir.createdAt || null;
}

type OpenLoop = {
  introId: number;
  investorName: string;
  firm: string | null;
  daysAgo: number;
  nextCount: number;   // what closeLoopNudgeCount becomes after this send (1 or 2)
};

/**
 * Find every open-loop intro that is DUE for a nudge right now, grouped by founder.
 * Due = status 'introduced', nudged fewer than MAX_NUDGES times, and old enough
 * for the next step in the cadence.
 */
export async function findDueNudges(now = new Date()): Promise<Map<number, OpenLoop[]>> {
  const candidates = await db.query.introRequests.findMany({
    where: and(
      eq(introRequests.status, 'introduced'),
      lt(introRequests.closeLoopNudgeCount, MAX_NUDGES),
    ),
    with: { investor: true },
  });

  const byFounder = new Map<number, OpenLoop[]>();
  for (const ir of candidates) {
    const madeOn = introducedAt(ir);
    if (!madeOn) continue;
    const age = daysBetween(madeOn, now);
    if (age > NUDGE_MAX_AGE_DAYS) continue;   // too stale to nudge — skip
    const count = ir.closeLoopNudgeCount ?? 0;

    // count 0 → due at 10 days; count 1 → due at 20 days.
    const threshold = count === 0 ? NUDGE_1_DAYS : NUDGE_2_DAYS;
    if (age < threshold) continue;

    const row: OpenLoop = {
      introId: ir.id,
      investorName: ir.investor?.name || 'an investor',
      firm: ir.investor?.firm ?? null,
      daysAgo: age,
      nextCount: count + 1,
    };
    const list = byFounder.get(ir.founderId) || [];
    list.push(row);
    byFounder.set(ir.founderId, list);
  }

  // Cap each founder to the most recent PER_FOUNDER_CAP intros (smallest daysAgo).
  // The rest stay eligible and surface on later runs as these advance.
  for (const [founderId, list] of byFounder) {
    if (list.length > PER_FOUNDER_CAP) {
      list.sort((a, b) => a.daysAgo - b.daysAgo);
      byFounder.set(founderId, list.slice(0, PER_FOUNDER_CAP));
    }
  }
  return byFounder;
}

/** Mint a single-use, 7-day deep-link login token for a founder. */
async function mintDeepLinkToken(founderId: number, now: Date): Promise<string> {
  const token = crypto.randomBytes(32).toString('hex');
  await db.insert(founderMagicTokens).values({
    token,
    founderId,
    expiresAt: new Date(now.getTime() + TOKEN_TTL_MS).toISOString(),
    createdAt: now.toISOString(),
  });
  return token;
}

function esc(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildEmail(founderName: string, loops: OpenLoop[], baseUrl: string, token: string) {
  const n = loops.length;
  const subject = n === 1
    ? `How did your ${loops[0].investorName} intro go?`
    : `${n} intros waiting on your update`;

  const link = (introId: number) =>
    `${baseUrl}/founder?token=${token}&intro=${introId}`;

  const firstName = (founderName || '').split(' ')[0] || 'there';

  const rows = loops.map(l => {
    const who = l.firm ? `${esc(l.investorName)} · ${esc(l.firm)}` : esc(l.investorName);
    return `
      <tr>
        <td style="padding:14px 0;border-bottom:1px solid #eee;">
          <div style="font-weight:600;color:#0A0A0F;font-size:15px;">${who}</div>
          <div style="color:#777;font-size:13px;margin-top:2px;">Introduced ${l.daysAgo} days ago</div>
        </td>
        <td style="padding:14px 0;border-bottom:1px solid #eee;text-align:right;vertical-align:middle;">
          <a href="${link(l.introId)}" style="display:inline-block;background:#00C2E0;color:#04262C;font-weight:600;font-size:14px;text-decoration:none;padding:9px 18px;border-radius:8px;">Report outcome &rarr;</a>
        </td>
      </tr>`;
  }).join('');

  const intro = n === 1
    ? `We made your intro to <strong>${esc(loops[0].investorName)}</strong> ${loops[0].daysAgo} days ago. How did it go?`
    : `We've made a few intros for you that we haven't heard back on. A quick update on each keeps your momentum accurate — and meeting reports earn you bonus intro requests.`;

  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:32px 20px;">
    <div style="background:#fff;border-radius:14px;padding:32px 28px;">
      <p style="font-size:12px;letter-spacing:3px;text-transform:uppercase;color:#00C2E0;font-weight:600;margin:0 0 16px;">MatCap</p>
      <h1 style="font-size:22px;line-height:1.3;color:#0A0A0F;margin:0 0 14px;">Close the loop</h1>
      <p style="color:#444;font-size:15px;line-height:1.6;margin:0 0 20px;">Hi ${esc(firstName)} — ${intro}</p>
      <table style="width:100%;border-collapse:collapse;">${rows}</table>
      <p style="color:#777;font-size:13px;line-height:1.6;margin:22px 0 0;">Marking a meeting complete counts toward your bonus intro requests. Passed is just as useful to us as a yes — it keeps your accept rate honest so we pace you right.</p>
    </div>
    <p style="text-align:center;color:#999;font-size:12px;margin:20px 0 0;">MatCap · You're receiving this because you're a MatCap portfolio founder.<br>Reply to this email to reach Mat directly.</p>
  </div>
</body></html>`;

  const textLines = loops.map(l =>
    `• ${l.investorName}${l.firm ? ' · ' + l.firm : ''} — introduced ${l.daysAgo} days ago\n  Report: ${link(l.introId)}`
  ).join('\n\n');
  const text = `Hi ${firstName},\n\n${n === 1
    ? `We made your intro to ${loops[0].investorName} ${loops[0].daysAgo} days ago. How did it go?`
    : `You have ${n} intros we haven't heard back on. A quick update on each keeps your momentum accurate:`}\n\n${textLines}\n\nMarking a meeting complete counts toward your bonus intro requests. Passed is just as useful as a yes.\n\n— MatCap`;

  return { subject, html, text };
}

/**
 * Run the nudge pass. In dryRun mode nothing is emailed and no counters move —
 * it just returns what WOULD go out (used for the admin preview and tests).
 */
export async function runCloseTheLoop(opts: { dryRun?: boolean; now?: Date } = {}): Promise<{
  founders: number;
  intros: number;
  sent: number;
  errors: string[];
  preview: Array<{ founder: string; email: string; intros: number; subject: string }>;
}> {
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun ?? false;
  const baseUrl = process.env.BASE_URL || 'https://matcap.vc';

  const byFounder = await findDueNudges(now);
  const founderIds = [...byFounder.keys()];
  const errors: string[] = [];
  const preview: Array<{ founder: string; email: string; intros: number; subject: string }> = [];

  if (founderIds.length === 0) {
    return { founders: 0, intros: 0, sent: 0, errors, preview };
  }

  const founderRows = await db.query.founders.findMany({
    where: inArray(founders.id, founderIds),
  });
  const founderMap = new Map(founderRows.map(f => [f.id, f]));

  let sent = 0;
  let introCount = 0;

  for (const [founderId, loops] of byFounder) {
    const founder = founderMap.get(founderId);
    // Skip off-boarded/hidden founders and anyone without an email on file.
    if (!founder || founder.hidden || !founder.email) continue;

    introCount += loops.length;

    try {
      // Preview build uses a placeholder token so we don't mint tokens for a dry run.
      const token = dryRun ? 'PREVIEW' : await mintDeepLinkToken(founderId, now);
      const { subject, html, text } = buildEmail(founder.name, loops, baseUrl, token);

      preview.push({ founder: founder.name, email: founder.email, intros: loops.length, subject });

      if (!dryRun) {
        await sendEmail({
          to: founder.email,
          subject,
          html,
          text,
          messageStream: 'broadcast',
          headers: {
            'List-Unsubscribe': `<mailto:${process.env.POSTMARK_FROM_EMAIL || 'mat@matsherman.com'}?subject=Unsubscribe%20close-the-loop>`,
          },
        });
        // Advance each intro's nudge counter only after a successful send.
        for (const l of loops) {
          await db.update(introRequests)
            .set({ closeLoopNudgeCount: l.nextCount, closeLoopNudgeLastAt: now.toISOString() })
            .where(eq(introRequests.id, l.introId));
        }
        sent++;
        console.log(`[CLOSE-LOOP] Nudged ${founder.name} (${founder.email}) on ${loops.length} intro(s)`);
      }
    } catch (err) {
      const msg = `Failed for ${founder.name}: ${err instanceof Error ? err.message : 'unknown'}`;
      errors.push(msg);
      console.error(`[CLOSE-LOOP] ${msg}`);
    }
  }

  return { founders: dryRun ? preview.length : sent, intros: introCount, sent, errors, preview };
}

/**
 * Send ONE real-looking nudge email to the admin so they can eyeball how it
 * renders before enabling the cron. Uses the first founder with due nudges; if
 * none are due, sends a synthetic example. Never touches nudge counters and never
 * emails a founder. The deep links use a throwaway token that isn't minted, so
 * they won't actually log anyone in — this is a visual preview only.
 */
export async function sendCloseLoopSampleToAdmin(): Promise<{ sentTo: string; basedOn: string }> {
  const adminEmail = process.env.ADMIN_EMAIL || 'mat@matsherman.com';
  const baseUrl = process.env.BASE_URL || 'https://matcap.vc';

  const due = await findDueNudges();
  let founderName = 'Sample Founder';
  let loops: OpenLoop[];

  const firstFounderId = [...due.keys()][0];
  if (firstFounderId !== undefined) {
    loops = due.get(firstFounderId)!;
    const f = await db.query.founders.findFirst({ where: eq(founders.id, firstFounderId) });
    founderName = f?.name || founderName;
  } else {
    // Nothing is actually due — show a representative two-intro example.
    loops = [
      { introId: 0, investorName: 'Jane Partner', firm: 'Acme Capital', daysAgo: 10, nextCount: 1 },
      { introId: 0, investorName: 'Sam Angel', firm: null, daysAgo: 21, nextCount: 2 },
    ];
  }

  const { subject, html, text } = buildEmail(founderName, loops, baseUrl, 'PREVIEW-TOKEN');
  await sendEmail({ to: adminEmail, subject: `[PREVIEW] ${subject}`, html, text });
  return { sentTo: adminEmail, basedOn: firstFounderId !== undefined ? founderName : 'synthetic example' };
}
