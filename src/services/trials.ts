import { eq } from 'drizzle-orm';
import { db, trials } from '../db/index.js';
import { sendEmail } from './email.js';

// Email the admin a nudge for every active trial that has reached its end date
// with no offer/pass decision yet. Best-effort; runs daily via cron.
export async function sendTrialDecisionNudges() {
  const active = await db.query.trials.findMany({
    where: eq(trials.status, 'active'),
    with: { founder: true },
  });
  const now = Date.now();
  const due = active.filter((t) => new Date(t.endDate).getTime() <= now);
  if (due.length === 0) return { due: 0 };

  const baseUrl = process.env.BASE_URL || 'https://nodestacker.fly.dev';
  const rows = due
    .map((t) => `<li><strong>${t.founder?.companyName || t.founder?.name}</strong> — trial ended ${t.endDate.split('T')[0]}</li>`)
    .join('');
  const adminTo = process.env.ADMIN_EMAIL || 'mat@matsherman.com';

  await sendEmail({
    to: adminTo,
    subject: `${due.length} trial${due.length === 1 ? '' : 's'} awaiting your offer/pass decision`,
    html: `<p>These trials have hit day 14 with no decision:</p><ul>${rows}</ul><p><a href="${baseUrl}/admin">Open the Trials tab →</a></p>`,
    text: `${due.length} trial(s) awaiting decision:\n${due.map((t) => `- ${t.founder?.companyName || t.founder?.name} (ended ${t.endDate.split('T')[0]})`).join('\n')}\n\n${baseUrl}/admin`,
  });

  return { due: due.length };
}
