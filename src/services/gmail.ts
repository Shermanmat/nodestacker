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
 * Scope is gmail.modify — drafts, send, and read access (needed for the
 * follow-up agent to check threads for investor replies). Re-auth required
 * after the scope upgrade.
 */

const CREDENTIALS_FILE = path.join(
  process.env.DATA_DIR || (process.env.NODE_ENV === 'production' ? '/app/data' : '.'),
  'gmail-credentials.json'
);

const SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];

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
 * STAGE 1 — the "ask". Mat → investor only, carrying the founder's blurb (the
 * forwardable pitch), asking if they'd like to meet. This is the FIRST email,
 * sent before any connection is made. Used by the auto-draft cron + the manual
 * "create draft" flow. The investor accepting is what later flips the intro to
 * 'introduced', which triggers buildIntroBody (the stage-2 connection email).
 */
export function buildAskEmail(args: {
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

  const subject = companyName || founder.name;

  const fillVars = (s: string) => s
    .replace(/\{\{investorFirst\}\}/g, investorFirst)
    .replace(/\{\{investorName\}\}/g, investorFirst)
    .replace(/\{\{investorFirm\}\}/g, investor.firm || '')
    .replace(/\{\{founderFirst\}\}/g, founderFirst)
    .replace(/\{\{founderFull\}\}/g, founder.name || '')
    .replace(/\{\{founderName\}\}/g, founderFirst)
    .replace(/\{\{companyName\}\}/g, companyName);

  let body: string;
  if (blurb) {
    // The blurb is the founder's complete forwardable pitch — use it verbatim.
    body = fillVars(blurb);
  } else {
    // Fallback ask when the founder has no blurb yet.
    const lines: string[] = [];
    lines.push(`Hi ${investorFirst} —`);
    lines.push('');
    lines.push(`Wanted to see if you'd be open to meeting ${founder.name}${companyName ? `, founder of ${companyName}` : ''}.`);
    if (stage) lines.push(`They're raising a ${stage} round.`);
    lines.push('');
    lines.push('Want me to make the intro?');
    lines.push('');
    lines.push(nodeFirst);
    body = lines.join('\n');
  }
  return { subject, body };
}

/**
 * STAGE 2 — the connection. The "Hi All, wanted to make the intro here…"
 * double opt-in email connecting founder + investor. Only sent AFTER the
 * investor accepts (intro flips to 'introduced'). Never the blurb; no deck.
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

  // Intro-style subject: "Investor Full <> Founder Full" (admin can edit in
  // Gmail before sending).
  const subject = `${investor.name || 'Investor'} <> ${founder.name}`;

  // {{investorName}} and {{founderName}} default to first name only — that's
  // what reads naturally in an intro email ("Hi Sarah"). Use {{investorFull}}
  // / {{founderFull}} when you actually want the full name.
  const fillVars = (s: string) => s
    .replace(/\{\{investorFirst\}\}/g, investorFirst)
    .replace(/\{\{investorFull\}\}/g, investor.name || '')
    .replace(/\{\{investorName\}\}/g, investorFirst)
    .replace(/\{\{investorFirm\}\}/g, investor.firm || '')
    .replace(/\{\{founderFirst\}\}/g, founderFirst)
    .replace(/\{\{founderFull\}\}/g, founder.name || '')
    .replace(/\{\{founderName\}\}/g, founderFirst)
    .replace(/\{\{companyName\}\}/g, companyName);

  // Always the standard double-opt-in intro format — never the founder blurb.
  const invRole = investor.role || 'investor';
  const invDesc = investor.firm ? `${invRole} at ${investor.firm}` : invRole;
  const lines: string[] = [];
  lines.push('Hi All,');
  lines.push('');
  lines.push('Wanted to make the intro here:');
  lines.push('');
  lines.push(`${founder.name} - Cofounder/CEO${companyName ? ` of ${companyName}` : ''}`);
  lines.push(`${investor.name} - ${invDesc} who wanted to learn more`);
  lines.push('');
  lines.push("I'll let you all take it from here.");
  lines.push('');
  lines.push(`- ${node?.name || 'Mat Sherman'}`);
  const body = lines.join('\n');

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

// Apply a label to a thread and remove it from the inbox ("archive, but
// findable"). Finds the label by name, creating it if it doesn't exist. Needs
// the gmail.modify scope (which we have).
export async function labelAndArchiveThread(threadId: string, labelName: string): Promise<void> {
  const client = await getAuthedClient();
  const gmail: gmail_v1.Gmail = google.gmail({ version: 'v1', auth: client });

  const list = await gmail.users.labels.list({ userId: 'me' });
  let label = list.data.labels?.find((l) => l.name === labelName);
  if (!label) {
    const created = await gmail.users.labels.create({
      userId: 'me',
      requestBody: { name: labelName, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
    });
    label = created.data;
  }

  await gmail.users.threads.modify({
    userId: 'me',
    id: threadId,
    requestBody: { addLabelIds: label.id ? [label.id] : [], removeLabelIds: ['INBOX'] },
  });
}

// Send the email directly (skipping drafts). gmail.compose scope is sufficient
// for messages.send per Google's OAuth docs. Returns the sent message's id +
// thread id for future reference (e.g. follow-up agent linking).
export async function sendGmail(input: DraftInput): Promise<{ messageId: string; threadId: string }> {
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
  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw },
  });

  return {
    messageId: res.data.id || '',
    threadId: res.data.threadId || '',
  };
}

// Inspect a Gmail thread for a reply *from a specific sender* (the investor).
// Earlier behavior counted any non-self message as a reply, which produced
// false positives whenever the node forwarded/replied inside the thread to
// pass the intro along — the node is not the investor, so that shouldn't
// pause the follow-up cycle.
//
// Pass `investorEmail` to scope the check. If omitted, falls back to the old
// "any non-self message" behavior for backwards compatibility (no callers
// should rely on that going forward).
export async function checkThreadReplies(
  threadId: string,
  investorEmail?: string,
): Promise<{
  hasReply: boolean;
  lastReplyAt?: string;
  messageCount: number;
}> {
  const client = await getAuthedClient();
  const stored = await loadStoredCredentials();
  // OAuth scope is gmail.modify, which doesn't cover userinfo.get() — so
  // `stored.email` is typically undefined and `myEmail` was the empty string.
  // That made every From: header non-empty pass the `from === myEmail` check
  // and counted our own outbound intro as a reply (root cause of the false
  // positives). Fall back to ADMIN_EMAIL so we can still recognize our own
  // sends even without re-running OAuth.
  const myEmail = (stored?.email || process.env.ADMIN_EMAIL || '').toLowerCase();
  const targetEmail = (investorEmail || '').trim().toLowerCase();
  const gmail: gmail_v1.Gmail = google.gmail({ version: 'v1', auth: client });
  const res = await gmail.users.threads.get({
    userId: 'me',
    id: threadId,
    format: 'metadata',
    metadataHeaders: ['From', 'Date'],
  });
  const messages = res.data.messages || [];
  let lastReplyMs = 0;
  let hasReply = false;
  for (const msg of messages) {
    const headers = msg.payload?.headers || [];
    const fromHeader = headers.find(h => h.name?.toLowerCase() === 'from')?.value || '';
    // Extract bare email from "Name <foo@bar.com>" style headers
    const emailMatch = fromHeader.match(/<([^>]+)>/);
    const from = (emailMatch ? emailMatch[1] : fromHeader).trim().toLowerCase();
    if (!from || from === myEmail) continue;
    // If we know the investor's email, require a match — otherwise messages
    // from the node (who forwarded the intro) would count as the investor
    // replying.
    if (targetEmail && from !== targetEmail) continue;
    hasReply = true;
    const dateHeader = headers.find(h => h.name?.toLowerCase() === 'date')?.value;
    const t = dateHeader ? new Date(dateHeader).getTime() : (msg.internalDate ? parseInt(msg.internalDate) : 0);
    if (!isNaN(t) && t > lastReplyMs) lastReplyMs = t;
  }
  return {
    hasReply,
    lastReplyAt: lastReplyMs > 0 ? new Date(lastReplyMs).toISOString() : undefined,
    messageCount: messages.length,
  };
}

// Reply to an existing thread. Uses the same MIME build as sendGmail but adds
// In-Reply-To + References + threadId so Gmail threads it correctly. No
// attachment — follow-ups are short bumps.
export async function sendThreadReply(input: {
  threadId: string;
  to: string;
  cc?: string;
  subject: string;
  body: string;
  inReplyTo?: string; // Message-ID of the message we're replying to
  references?: string;
  asDraft?: boolean;
}): Promise<{ messageId: string; threadId: string; draftId?: string }> {
  const client = await getAuthedClient();
  const stored = await loadStoredCredentials();
  const from = stored?.email || 'me';
  const gmail: gmail_v1.Gmail = google.gmail({ version: 'v1', auth: client });

  // CRITICAL for cross-client threading: Gmail's `threadId` only threads the
  // message in OUR mailbox. For the recipient's client to thread it under the
  // original conversation, the message MUST carry RFC In-Reply-To/References
  // headers pointing at the prior message's Message-ID, and a matching subject.
  // Auto-derive all three from the thread when the caller didn't supply them —
  // otherwise replies land as brand-new email chains on the investor's side.
  let inReplyTo = input.inReplyTo;
  let references = input.references;
  let subject = input.subject;
  try {
    const thread = await gmail.users.threads.get({
      userId: 'me', id: input.threadId, format: 'metadata',
      metadataHeaders: ['Message-ID', 'References', 'Subject'],
    });
    const msgs = thread.data.messages || [];
    const last = msgs[msgs.length - 1];
    const hdr = (name: string) =>
      last?.payload?.headers?.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || '';
    const lastMsgId = hdr('message-id');
    const lastRefs = hdr('references');
    const lastSubject = hdr('subject');
    if (!inReplyTo && lastMsgId) inReplyTo = lastMsgId;
    if (!references && lastMsgId) references = (lastRefs ? lastRefs + ' ' : '') + lastMsgId;
    if (lastSubject) subject = /^re:/i.test(lastSubject.trim()) ? lastSubject : `Re: ${lastSubject}`;
  } catch (e) {
    // Fall back to caller-supplied values; the message still threads on our side.
    console.error('[gmail] could not derive thread reply headers:', e);
  }

  // Build MIME with In-Reply-To headers
  const rawLines: string[] = [];
  rawLines.push(`From: ${from}`);
  rawLines.push(`To: ${input.to}`);
  if (input.cc) rawLines.push(`Cc: ${input.cc}`);
  rawLines.push(`Subject: ${subject}`);
  if (inReplyTo) rawLines.push(`In-Reply-To: ${inReplyTo}`);
  if (references) rawLines.push(`References: ${references}`);
  rawLines.push('MIME-Version: 1.0');
  rawLines.push('Content-Type: text/plain; charset="UTF-8"');
  rawLines.push('Content-Transfer-Encoding: 7bit');
  rawLines.push('');
  rawLines.push(input.body);
  const raw = Buffer.from(rawLines.join('\r\n')).toString('base64url');

  if (input.asDraft) {
    const res = await gmail.users.drafts.create({
      userId: 'me',
      requestBody: { message: { raw, threadId: input.threadId } },
    });
    return {
      draftId: res.data.id || '',
      messageId: res.data.message?.id || '',
      threadId: res.data.message?.threadId || input.threadId,
    };
  }
  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw, threadId: input.threadId },
  });
  return {
    messageId: res.data.id || '',
    threadId: res.data.threadId || input.threadId,
  };
}

// Fetch the most recent message body in `threadId` from `fromEmail`. Used by
// the reply classifier to grab the investor's actual reply text (not just the
// "did anyone reply" flag).
export async function getLatestMessageFromSender(
  threadId: string,
  fromEmail: string,
): Promise<{ body: string; receivedAt: string | null; messageId: string } | null> {
  const client = await getAuthedClient();
  const target = (fromEmail || '').trim().toLowerCase();
  if (!target) return null;
  const gmail: gmail_v1.Gmail = google.gmail({ version: 'v1', auth: client });
  const thread = await gmail.users.threads.get({
    userId: 'me',
    id: threadId,
    format: 'full',
  });
  const messages = thread.data.messages || [];
  // Walk newest-first.
  const sorted = [...messages].sort((a, b) => {
    const at = a.internalDate ? parseInt(a.internalDate) : 0;
    const bt = b.internalDate ? parseInt(b.internalDate) : 0;
    return bt - at;
  });
  for (const msg of sorted) {
    const headers = msg.payload?.headers || [];
    const fromHeader = headers.find(h => h.name?.toLowerCase() === 'from')?.value || '';
    const emailMatch = fromHeader.match(/<([^>]+)>/);
    const from = (emailMatch ? emailMatch[1] : fromHeader).trim().toLowerCase();
    if (from !== target) continue;
    const dateHeader = headers.find(h => h.name?.toLowerCase() === 'date')?.value;
    const receivedAt = dateHeader ? new Date(dateHeader).toISOString() : null;
    const body = extractPlainTextBody(msg.payload) || msg.snippet || '';
    return { body, receivedAt, messageId: msg.id || '' };
  }
  return null;
}

// Pull the text/plain part out of a Gmail message payload. Falls back through
// nested multipart and HTML-stripped content if plain isn't available.
function extractPlainTextBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return '';
  const decode = (b: string | undefined | null) => {
    if (!b) return '';
    try {
      return Buffer.from(b.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    } catch { return ''; }
  };
  // 1. Direct text/plain
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return decode(payload.body.data);
  }
  // 2. Search parts
  const parts = payload.parts || [];
  for (const p of parts) {
    if (p.mimeType === 'text/plain' && p.body?.data) return decode(p.body.data);
  }
  // 3. Recurse into multipart
  for (const p of parts) {
    const inner = extractPlainTextBody(p);
    if (inner) return inner;
  }
  // 4. Fallback: text/html stripped of tags
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    const html = decode(payload.body.data);
    return html.replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  for (const p of parts) {
    if (p.mimeType === 'text/html' && p.body?.data) {
      const html = decode(p.body.data);
      return html.replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }
  }
  return '';
}
