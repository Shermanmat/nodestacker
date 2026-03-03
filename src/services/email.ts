/**
 * Shared email service using Postmark
 */

import * as postmark from 'postmark';

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
  const { to, subject, html, text } = params;

  if (!postmarkClient) {
    console.log(`[EMAIL] No Postmark configured - would send:\n  To: ${to}\n  Subject: ${subject}`);
    return { success: true, messageId: 'dev-mode' };
  }

  try {
    const response = await postmarkClient.sendEmail({
      From: FROM_EMAIL,
      To: to,
      Subject: subject,
      HtmlBody: html,
      TextBody: text,
      MessageStream: 'outbound',
    });

    console.log(`[EMAIL] Sent to ${to}: ${subject}`);
    return { success: true, messageId: response.MessageID };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[EMAIL] Failed to send to ${to}:`, errorMsg);
    return { success: false, error: errorMsg };
  }
}
