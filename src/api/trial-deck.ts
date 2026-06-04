import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, founders } from '../db/index.js';
import { sendEmail } from './../services/email.js';

const app = new Hono();

// Public deck upload from the /trial page. No founder auth there — the founder
// is identified by the email they enter. PDF stored on the Fly volume (served
// at /decks/<filename>); if a founder with that email exists, it's attached to
// their record so intro drafts can pick it up. Either way the admin is emailed.
app.post('/', async (c) => {
  const body = await c.req.parseBody();
  const file = body['deck'] as File | undefined;
  const email = ((body['email'] as string) || '').trim().toLowerCase();
  const name = ((body['name'] as string) || '').trim();

  if (!email || !email.includes('@')) return c.json({ error: 'A valid email is required' }, 400);
  if (!file) return c.json({ error: 'No file provided (form field "deck")' }, 400);

  const MAX_BYTES = 30 * 1024 * 1024; // 30 MB
  if (file.size > MAX_BYTES) {
    return c.json({ error: `File too large (max ${MAX_BYTES / 1024 / 1024} MB)` }, 413);
  }
  const mime = (file as any).type || '';
  if (!mime.includes('pdf') && !file.name.toLowerCase().endsWith('.pdf')) {
    return c.json({ error: 'Only PDF files are supported' }, 400);
  }

  const fs = await import('fs/promises');
  const path = await import('path');
  const crypto = await import('crypto');

  const decksDir = path.join(process.env.DATA_DIR || (process.env.NODE_ENV === 'production' ? '/app/data' : '.'), 'decks');
  await fs.mkdir(decksDir, { recursive: true });

  const token = crypto.randomBytes(16).toString('hex');
  const filename = `${token}.pdf`;
  const buffer = Buffer.from(await file.arrayBuffer());
  await fs.writeFile(path.join(decksDir, filename), buffer);

  // Attach to an existing founder record if the email matches one.
  const founder = await db.query.founders.findFirst({ where: eq(founders.email, email) });
  if (founder) {
    await db.update(founders).set({ deckFile: filename }).where(eq(founders.id, founder.id));
  }

  const baseUrl = process.env.BASE_URL || 'https://nodestacker.fly.dev';
  const link = `${baseUrl}/decks/${filename}`;
  await sendEmail({
    to: process.env.ADMIN_EMAIL || 'mat@matsherman.com',
    subject: `Trial deck uploaded — ${name || email}`,
    html: `<p>A trial founder uploaded a deck.</p>
      <p><strong>Email:</strong> ${email}${name ? `<br><strong>Name:</strong> ${name}` : ''}</p>
      <p><strong>Deck:</strong> <a href="${link}">${link}</a></p>
      <p>${founder ? `Attached to founder #${founder.id} (${founder.companyName || founder.name}).` : 'No matching founder record — not yet attached.'}</p>`,
    text: `Trial deck uploaded.\nEmail: ${email}\n${name ? `Name: ${name}\n` : ''}Deck: ${link}\n${founder ? `Attached to founder #${founder.id}.` : 'No matching founder record.'}`,
  });

  return c.json({ success: true, attached: !!founder });
});

export default app;
