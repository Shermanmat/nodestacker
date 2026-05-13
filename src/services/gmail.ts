import { google, gmail_v1 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Gmail OAuth + drafts service.
 *
 * Stores the refresh token on the Fly volume so it survives restarts.
 * On every call, refreshes the access token as needed via the OAuth2Client.
 *
 * Scope is gmail.compose only — drafts + send permission, no read access
 * to the inbox.
 */

const CREDENTIALS_FILE = path.join(
  process.env.DATA_DIR || (process.env.NODE_ENV === 'production' ? '/app/data' : '.'),
  'gmail-credentials.json'
);

const SCOPES = ['https://www.googleapis.com/auth/gmail.compose'];

interface StoredCredentials {
  refreshToken: string;
  email?: string;
  connectedAt: string;
}

function getRedirectUri(): string {
  const base = process.env.BASE_URL || 'http://localhost:3000';
  return `${base.replace(/\/$/, '')}/oauth/gmail/callback`;
}

function makeOAuth2Client(): OAuth2Client {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('Missing GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET env vars');
  }
  return new google.auth.OAuth2(clientId, clientSecret, getRedirectUri());
}

export function getAuthUrl(): string {
  const client = makeOAuth2Client();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // force refresh token even if user already granted before
    scope: SCOPES,
  });
}

export async function exchangeCodeForTokens(code: string): Promise<{ email?: string }> {
  const client = makeOAuth2Client();
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error('No refresh token returned. Disconnect first or revoke access at https://myaccount.google.com/permissions, then retry.');
  }

  // Best-effort: pull the connected user's email for display
  let email: string | undefined;
  try {
    client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const info = await oauth2.userinfo.get();
    email = info.data.email || undefined;
  } catch (_) { /* not fatal */ }

  await fs.mkdir(path.dirname(CREDENTIALS_FILE), { recursive: true });
  const stored: StoredCredentials = {
    refreshToken: tokens.refresh_token,
    email,
    connectedAt: new Date().toISOString(),
  };
  await fs.writeFile(CREDENTIALS_FILE, JSON.stringify(stored, null, 2), 'utf8');
  return { email };
}

async function loadStoredCredentials(): Promise<StoredCredentials | null> {
  try {
    const raw = await fs.readFile(CREDENTIALS_FILE, 'utf8');
    return JSON.parse(raw) as StoredCredentials;
  } catch (_) {
    return null;
  }
}

export async function getStatus(): Promise<{ connected: boolean; email?: string; connectedAt?: string }> {
  const stored = await loadStoredCredentials();
  if (!stored) return { connected: false };
  return { connected: true, email: stored.email, connectedAt: stored.connectedAt };
}

export async function disconnect(): Promise<void> {
  try {
    await fs.unlink(CREDENTIALS_FILE);
  } catch (_) { /* already gone is fine */ }
}

async function getAuthedClient(): Promise<OAuth2Client> {
  const stored = await loadStoredCredentials();
  if (!stored) throw new Error('Gmail not connected — visit /api/agent/gmail/connect first');
  const client = makeOAuth2Client();
  client.setCredentials({ refresh_token: stored.refreshToken });
  return client;
}

/**
 * Build a RFC-2822 MIME message, optionally with one PDF attachment.
 * Returns base64url-encoded for the Gmail API.
 */
function buildMimeMessage(opts: {
  from: string;
  to: string;
  cc?: string;
  subject: string;
  body: string;
  attachment?: { filename: string; mimeType: string; data: Buffer };
}): string {
  const boundary = `boundary_${Math.random().toString(36).slice(2)}`;
  const headers: string[] = [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
  ];
  if (opts.cc) headers.push(`Cc: ${opts.cc}`);
  headers.push(`Subject: ${opts.subject}`);
  headers.push('MIME-Version: 1.0');

  let body: string;
  if (opts.attachment) {
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    const parts: string[] = [
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: 7bit',
      '',
      opts.body,
      '',
      `--${boundary}`,
      `Content-Type: ${opts.attachment.mimeType}; name="${opts.attachment.filename}"`,
      `Content-Disposition: attachment; filename="${opts.attachment.filename}"`,
      'Content-Transfer-Encoding: base64',
      '',
      opts.attachment.data.toString('base64').replace(/(.{76})/g, '$1\n'),
      '',
      `--${boundary}--`,
    ];
    body = headers.join('\r\n') + '\r\n\r\n' + parts.join('\r\n');
  } else {
    headers.push('Content-Type: text/plain; charset="UTF-8"');
    body = headers.join('\r\n') + '\r\n\r\n' + opts.body;
  }

  return Buffer.from(body)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export interface DraftInput {
  to: string;
  cc?: string;
  subject: string;
  body: string;
  attachmentPath?: string; // absolute or relative path to PDF on disk
  attachmentName?: string; // filename to show in email (e.g. "Acme Deck.pdf")
}

export interface DraftResult {
  draftId: string;
  messageId?: string;
  gmailUrl: string; // direct link to the draft in Gmail web
}

/**
 * Build the intro email body + subject for a (founder, investor, node) triple.
 * Mirrors the client-side buildIntroDraft in admin.html.
 *
 * Exported here so both the manual draft endpoint and the auto-draft cron
 * produce the same email.
 */
export function buildIntroBody(args: {
  founder: { name: string; companyName: string; email: string | null; blurb: string | null; companyStage: string; deckUrl: string | null; calendlyUrl: string | null };
  investor: { name: string; firm: string | null; role: string | null };
  node: { name: string } | null;
}): { subject: string; body: string } {
  const { founder, investor, node } = args;
  const investorFirst = (investor.name || '').split(/\s+/)[0] || 'there';
  const founderFirst = (founder.name || '').split(/\s+/)[0] || '';
  const companyName = founder.companyName || '';
  const stage = founder.companyStage ? String(founder.companyStage).replace(/_/g, ' ') : '';
  const nodeFirst = (node?.name || 'Mat').split(/\s+/)[0];
  const blurb = (founder.blurb || '').trim();
  const deckUrl = (founder.deckUrl || '').trim();
  const calendlyUrl = (founder.calendlyUrl || '').trim();

  // Subject defaults to the company name (admin can edit in Gmail before sending).
  // Falls back to founder name only if companyName is unset.
  const subject = companyName || founder.name;

  const fillVars = (s: string) => s
    .replace(/\{\{investorFirst\}\}/g, investorFirst)
    .replace(/\{\{investorName\}\}/g, investor.name || '')
    .replace(/\{\{investorFirm\}\}/g, investor.firm || '')
    .replace(/\{\{founderFirst\}\}/g, founderFirst)
    .replace(/\{\{founderName\}\}/g, founder.name || '')
    .replace(/\{\{companyName\}\}/g, companyName);

  let body: string;
  if (blurb) {
    body = fillVars(blurb);
  } else {
    const lines: string[] = [];
    lines.push(`Hi ${investorFirst} —`);
    lines.push('');
    lines.push(`Want to intro you to ${founder.name}${companyName ? `, building ${companyName}` : ''}.`);
    if (stage) {
      lines.push('');
      lines.push(`They're raising a ${stage} round and I think they'd be a strong fit for your thesis.`);
    }
    if (deckUrl || calendlyUrl) {
      lines.push('');
      if (deckUrl) lines.push(`Deck: ${deckUrl}`);
      if (calendlyUrl) lines.push(`Book time: ${calendlyUrl}`);
    }
    lines.push('');
    lines.push(`${founderFirst || founder.name}, meet ${investorFirst}${investor.firm ? ` (${investor.role || 'investor'} at ${investor.firm})` : ''} — off to you both.`);
    lines.push('');
    lines.push(nodeFirst);
    body = lines.join('\n');
  }

  return { subject, body };
}

export async function createDraft(input: DraftInput): Promise<DraftResult> {
  const client = await getAuthedClient();
  const stored = await loadStoredCredentials();
  const from = stored?.email || 'me';

  let attachment: { filename: string; mimeType: string; data: Buffer } | undefined;
  if (input.attachmentPath) {
    const data = await fs.readFile(input.attachmentPath);
    attachment = {
      filename: input.attachmentName || path.basename(input.attachmentPath),
      mimeType: 'application/pdf',
      data,
    };
  }

  const raw = buildMimeMessage({
    from,
    to: input.to,
    cc: input.cc,
    subject: input.subject,
    body: input.body,
    attachment,
  });

  const gmail: gmail_v1.Gmail = google.gmail({ version: 'v1', auth: client });
  const res = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: { message: { raw } },
  });

  const draftId = res.data.id!;
  const messageId = res.data.message?.id || undefined;
  return {
    draftId,
    messageId,
    // Open the draft inside Gmail web — Superhuman will pick it up too.
    gmailUrl: `https://mail.google.com/mail/u/0/#drafts/${messageId || draftId}`,
  };
}
