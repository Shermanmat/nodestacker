/**
 * Shared email service using Postmark
 */

import * as postmark from 'postmark';
import { readFile } from 'node:fs/promises';

// Initialize Postmark client
const postmarkClient = process.env.POSTMARK_API_KEY
  ? new postmark.ServerClient(process.env.POSTMARK_API_KEY)
  : null;

const FROM_EMAIL = process.env.POSTMARK_FROM_EMAIL || 'mat@matsherman.com';

interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
  text: string;
  // Postmark message stream. Defaults to 'outbound' (transactional). Bulk/blast
  // mail should pass 'broadcast' so it sends on the broadcast stream — keeps its
  // reputation isolated from transactional (login/magic-link) email.
  messageStream?: string;
  // Extra SMTP headers, e.g. { 'List-Unsubscribe': '<mailto:...>' }.
  headers?: Record<string, string>;
  // File attachments. Each is read from disk, base64-encoded, and attached.
  attachments?: Array<{ path: string; name: string; contentType?: string }>;
}

interface EmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

/**
 * Send an email via Postmark
 */
export async function sendEmail(params: SendEmailParams): Promise<EmailResult> {
  const { to, subject, html, text, messageStream, headers, attachments } = params;

  if (!postmarkClient) {
    console.log(`[EMAIL] No Postmark configured - would send:\n  To: ${to}\n  Subject: ${subject}\n  Stream: ${messageStream || 'outbound'}`);
    return { success: true, messageId: 'dev-mode' };
  }

  // Read + base64-encode any attachments. A missing/unreadable file is skipped
  // (logged) rather than failing the whole send.
  let pmAttachments: Array<{ Name: string; Content: string; ContentType: string; ContentID: string | null }> | undefined;
  if (attachments && attachments.length) {
    pmAttachments = [];
    for (const a of attachments) {
      try {
        const buf = await readFile(a.path);
        pmAttachments.push({
          Name: a.name,
          Content: buf.toString('base64'),
          ContentType: a.contentType || 'application/octet-stream',
          ContentID: null,
        });
      } catch (err) {
        console.error(`[EMAIL] Could not attach ${a.path}:`, err instanceof Error ? err.message : err);
      }
    }
    if (pmAttachments.length === 0) pmAttachments = undefined;
  }

  try {
    const response = await postmarkClient.sendEmail({
      From: FROM_EMAIL,
      To: to,
      Subject: subject,
      HtmlBody: html,
      TextBody: text,
      MessageStream: messageStream || 'outbound',
      Attachments: pmAttachments,
      Headers: headers
        ? Object.entries(headers).map(([Name, Value]) => ({ Name, Value }))
        : undefined,
    });

    console.log(`[EMAIL] Sent to ${to}: ${subject}`);
    return { success: true, messageId: response.MessageID };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[EMAIL] Failed to send to ${to}:`, errorMsg);
    return { success: false, error: errorMsg };
  }
}
