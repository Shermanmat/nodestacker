import { Hono } from 'hono';
import { db, portfolioCompanies } from '../db/index.js';
import { sendEmail } from '../services/email.js';
import { z } from 'zod';

const app = new Hono();

const sendSchema = z.object({
  subject: z.string().min(1).max(200),
  body: z.string().min(1),
  // When true, send a single rendered preview to testEmail instead of the
  // whole portfolio. Lets the admin see exactly what founders will receive.
  test: z.boolean().optional(),
  testEmail: z.string().email().optional(),
});

interface Recipient {
  founderId: number;
  name: string;
  email: string;
  companyName: string;
}

// Load every portfolio founder that has an email, deduped by address.
async function loadRecipients(): Promise<Recipient[]> {
  const companies = await db.query.portfolioCompanies.findMany({
    with: { founder: true },
  });
  const seen = new Set<string>();
  const recipients: Recipient[] = [];
  for (const co of companies) {
    const f = co.founder;
    const email = (f?.email || '').trim().toLowerCase();
    if (!f || !email || !email.includes('@')) continue;
    if (seen.has(email)) continue;
    seen.add(email);
    recipients.push({
      founderId: f.id,
      name: f.name,
      email,
      companyName: f.companyName || '',
    });
  }
  return recipients;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Fill {{firstName}} / {{name}} / {{companyName}} from the recipient.
function fillVars(s: string, r: { name: string; companyName: string }): string {
  const firstName = (r.name || '').split(/\s+/)[0] || 'there';
  return s
    .replace(/\{\{firstName\}\}/g, firstName)
    .replace(/\{\{name\}\}/g, r.name || firstName)
    .replace(/\{\{companyName\}\}/g, r.companyName || 'your company');
}

// Plain-text body → simple HTML: escape, autolink bare URLs, newlines to <br>.
function toHtml(text: string): string {
  const escaped = escapeHtml(text);
  const linked = escaped.replace(
    /(https?:\/\/[^\s<]+)/g,
    (url) => `<a href="${url}">${url}</a>`,
  );
  return linked.replace(/\n/g, '<br>\n');
}

// Address recipients can reply to in order to opt out. Powers both the
// List-Unsubscribe header (helps Gmail/Outlook deliverability on bulk mail)
// and the visible footer line required for compliant broadcast sending.
const UNSUB_EMAIL = process.env.POSTMARK_FROM_EMAIL || 'mat@matsherman.com';
const UNSUB_HEADER = { 'List-Unsubscribe': `<mailto:${UNSUB_EMAIL}?subject=Unsubscribe>` };
const FOOTER_TEXT = `\n\n—\nYou're receiving this as a MatCap portfolio founder. Reply "unsubscribe" to opt out.`;
const FOOTER_HTML = `<br><br>—<br><span style="color:#888;font-size:12px">You're receiving this as a MatCap portfolio founder. Reply "unsubscribe" to opt out.</span>`;

// Preview the recipient list (count + names) for the compose screen.
app.get('/recipients', async (c) => {
  const recipients = await loadRecipients();
  return c.json({ count: recipients.length, recipients });
});

// Send the broadcast. Sequential send keeps per-recipient error tracking simple;
// the portfolio is small enough that throughput isn't a concern.
app.post('/send', async (c) => {
  const raw = await c.req.json().catch(() => ({}));
  const parsed = sendSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues }, 400);
  }
  const { subject, body, test } = parsed.data;

  const recipients = await loadRecipients();

  // Test mode: render with the first real founder's context (or a sample if the
  // portfolio is empty) and send only to the admin / supplied address.
  if (test) {
    const admin = (c as any).get('admin') as { email?: string } | undefined;
    const to = parsed.data.testEmail || admin?.email || 'mat@matsherman.com';
    const sample = recipients[0] || { name: 'Sample Founder', companyName: 'Sample Co' };
    const renderedSubject = fillVars(subject, sample);
    const renderedBody = fillVars(body, sample);
    const result = await sendEmail({
      to,
      subject: `[TEST] ${renderedSubject}`,
      html: toHtml(renderedBody) + FOOTER_HTML,
      text: renderedBody + FOOTER_TEXT,
      messageStream: 'broadcast',
      headers: UNSUB_HEADER,
    });
    return c.json({ test: true, sentTo: to, success: result.success, error: result.error });
  }

  if (recipients.length === 0) {
    return c.json({ error: 'No portfolio founders with an email address' }, 400);
  }

  let sent = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const r of recipients) {
    const result = await sendEmail({
      to: r.email,
      subject: fillVars(subject, r),
      html: toHtml(fillVars(body, r)) + FOOTER_HTML,
      text: fillVars(body, r) + FOOTER_TEXT,
      messageStream: 'broadcast',
      headers: UNSUB_HEADER,
    });
    if (result.success) {
      sent++;
    } else {
      failed++;
      errors.push(`${r.name} (${r.email}): ${result.error || 'unknown error'}`);
    }
  }

  return c.json({ total: recipients.length, sent, failed, errors });
});

export default app;
