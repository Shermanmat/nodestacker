/**
 * Onboarding Email Service
 * Handles all email notifications for the founder onboarding workflow
 */

import * as postmark from 'postmark';

// Initialize Postmark client
const postmarkClient = process.env.POSTMARK_API_KEY
  ? new postmark.ServerClient(process.env.POSTMARK_API_KEY)
  : null;

const FROM_EMAIL = process.env.POSTMARK_FROM_EMAIL || 'mat@matsherman.com';
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

interface EmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

interface FounderInfo {
  name: string;
  email: string;
  companyName: string;
}

interface WorkflowInfo {
  equityPercent: string;
  sharePrice: string;
  shareCount: number;
  totalAmount: string;
  grantDate: string;
}

/**
 * Send an email via Postmark
 */
async function sendEmail(
  to: string,
  subject: string,
  htmlBody: string,
  textBody: string
): Promise<EmailResult> {
  if (!postmarkClient) {
    console.log(`📧 Email (no Postmark configured):\n  To: ${to}\n  Subject: ${subject}`);
    return { success: true, messageId: 'dev-mode' };
  }

  try {
    const result = await postmarkClient.sendEmail({
      From: FROM_EMAIL,
      To: to,
      Subject: subject,
      HtmlBody: htmlBody,
      TextBody: textBody,
    });
    console.log(`✅ Email sent to ${to}: ${subject}`);
    return { success: true, messageId: result.MessageID };
  } catch (err: any) {
    console.error(`❌ Failed to send email to ${to}:`, err);
    return { success: false, error: err.message };
  }
}

/**
 * Common email wrapper with styling
 */
function wrapEmail(content: string): string {
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      ${content}
      <p style="margin-top: 30px;">Best,<br>Mat</p>
      <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 30px 0;" />
      <p style="color: #666; font-size: 12px;">
        MatCapital Founder Portal<br>
        <a href="${BASE_URL}/founder" style="color: #2563eb;">Access your portal</a>
      </p>
    </div>
  `;
}

/**
 * Button component for emails
 */
function emailButton(text: string, url: string): string {
  return `
    <p style="margin: 30px 0;">
      <a href="${url}" style="background-color: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
        ${text}
      </a>
    </p>
  `;
}

// ============== FOUNDER EMAILS ==============

interface OfferDetails {
  vestingMonths: number;
  vestingCliffMonths: number;
  introRequestsPerWeek?: number;
  introRequestsRevisitDate?: string;
  notes?: string;
}

/**
 * Format vesting schedule for display
 */
function formatVestingSchedule(vestingMonths: number, vestingCliffMonths: number): string {
  const parts: string[] = [];

  if (vestingMonths === 0) {
    parts.push('no vesting');
  } else {
    const years = vestingMonths / 12;
    parts.push(`${years}-year vesting`);
  }

  if (vestingCliffMonths > 0) {
    parts.push(`${vestingCliffMonths}-month cliff`);
  } else {
    parts.push('no cliff');
  }

  return parts.join(', ');
}

/**
 * Email: MatCap wants to work with you
 */
export async function sendOfferEmail(founder: FounderInfo, equityPercent: string, offer: OfferDetails): Promise<EmailResult> {
  const subject = `Your Offer To Join The MatCap Network`;
  const portalUrl = `${BASE_URL}/founder`;
  const vestingText = formatVestingSchedule(offer.vestingMonths, offer.vestingCliffMonths);
  const firstName = founder.name.split(' ')[0];

  const introPerWeek = offer.introRequestsPerWeek || 3;
  const revisitDate = offer.introRequestsRevisitDate
    ? new Date(offer.introRequestsRevisitDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    : null;

  const introRequestHtml = `
    <p style="margin-top: 16px;"><strong>How intro requests work</strong></p>
    <p>MatCap runs on intro requests. We send intro requests on your behalf to investors in our network — these come from people the investors already trust. Your intro request accept rate tells us how well the network is responding to your company.</p>
    <p>We're starting you at <strong>${introPerWeek} intro request${introPerWeek !== 1 ? 's' : ''} per week</strong>. Our goal is to increase that number over time, but we let investor behavior dictate the pace — we're pinned to what investors think about the companies we bring them.</p>
    ${revisitDate ? `<p>We'll revisit your intro request volume on <strong>${revisitDate}</strong> to see how things are going and adjust accordingly.</p>` : ''}
  `;

  const introRequestText = `
How intro requests work:
MatCap runs on intro requests. We send intro requests on your behalf to investors in our network — these come from people the investors already trust. Your intro request accept rate tells us how well the network is responding to your company.

We're starting you at ${introPerWeek} intro request${introPerWeek !== 1 ? 's' : ''} per week. Our goal is to increase that number over time, but we let investor behavior dictate the pace.
${revisitDate ? `\nWe'll revisit your intro request volume on ${revisitDate} to see how things are going and adjust accordingly.\n` : ''}`;

  const htmlBody = wrapEmail(`
    <h2>Hi ${firstName},</h2>
    <p>We'd like to offer you a spot in the MatCap portfolio. This includes access to our investor network, events, and office hours.</p>
    <p><strong>Terms:</strong></p>
    <ul>
      <li><strong>${equityPercent}% equity</strong></li>
      <li><strong>${vestingText}</strong></li>
    </ul>
    ${introRequestHtml}
    ${offer.notes ? `<p>${offer.notes}</p>` : ''}
    ${emailButton('Review Offer', portalUrl)}
  `);

  const textBody = `Hi ${firstName},

We'd like to offer you a spot in the MatCap portfolio. This includes access to our investor network, events, and office hours.

Terms:
- ${equityPercent}% equity
- ${vestingText}
${introRequestText}
${offer.notes ? `${offer.notes}\n` : ''}
Review the offer here: ${portalUrl}

Best,
The MatCap Team`;

  return sendEmail(founder.email, subject, htmlBody, textBody);
}

/**
 * Email: Complete your company details (entity info)
 */
export async function sendEntityInfoRequestEmail(founder: FounderInfo): Promise<EmailResult> {
  const subject = `Next step: Company details needed`;
  const portalUrl = `${BASE_URL}/founder`;

  const htmlBody = wrapEmail(`
    <h2>Hi ${founder.name},</h2>
    <p>Great - you've accepted the offer!</p>
    <p>To prepare the advisory agreement, I need a few details about your company:</p>
    <ul>
      <li>Legal entity name (e.g., "Acme Inc.")</li>
      <li>Entity type (LLC, C-Corp, etc.)</li>
      <li>State of incorporation</li>
      <li>Total authorized shares</li>
    </ul>
    <p>You can also set your share price (defaults to $0.0001 if you don't change it).</p>
    ${emailButton('Enter Company Details', portalUrl)}
  `);

  const textBody = `Hi ${founder.name},

Great - you've accepted the offer!

To prepare the advisory agreement, I need a few details about your company:
- Legal entity name
- Entity type (LLC, C-Corp, etc.)
- State of incorporation
- Total authorized shares

Enter details here: ${portalUrl}

Best,
Mat`;

  return sendEmail(founder.email, subject, htmlBody, textBody);
}

/**
 * Email: Sign your advisory agreement
 */
export async function sendAdvisoryAgreementReadyEmail(founder: FounderInfo): Promise<EmailResult> {
  const subject = `Advisory agreement ready for signature`;

  const htmlBody = wrapEmail(`
    <h2>Hi ${founder.name},</h2>
    <p>The advisory agreement is ready! I've already signed it.</p>
    <p>You should receive an email from Dropbox Sign with the document. Please review and sign when you have a moment.</p>
    <p>Once signed, I'll send you next steps for the equity issuance.</p>
  `);

  const textBody = `Hi ${founder.name},

The advisory agreement is ready! I've already signed it.

You should receive an email from Dropbox Sign with the document. Please review and sign when you have a moment.

Best,
Mat`;

  return sendEmail(founder.email, subject, htmlBody, textBody);
}

/**
 * Email: Stock agreement ready to sign
 */
export async function sendEquityAgreementRequestEmail(
  founder: FounderInfo,
  workflow: WorkflowInfo
): Promise<EmailResult> {
  const subject = `Next Step - Sign Stock Agreement`;

  const htmlBody = wrapEmail(`
    <h2>Hi ${founder.name},</h2>
    <p>Our advisory agreement is signed! Now let's formalize the equity.</p>
    <p>I've sent you a Stock Award & Purchase Agreement for:</p>
    <ul>
      <li><strong>${workflow.shareCount.toLocaleString()} shares</strong> of common stock</li>
      <li>At <strong>$${workflow.sharePrice}</strong> per share (<strong>$${workflow.totalAmount}</strong> total)</li>
    </ul>
    <p>Look out for an email from <strong>Dropbox Sign</strong> in your inbox to review and sign the document.</p>
  `);

  const textBody = `Hi ${founder.name},

Our advisory agreement is signed! Now let's formalize the equity.

I've sent you a Stock Award & Purchase Agreement for:
- ${workflow.shareCount.toLocaleString()} shares of common stock
- At $${workflow.sharePrice} per share ($${workflow.totalAmount} total)

Look out for an email from Dropbox Sign in your inbox to review and sign the document.

Best,
Mat`;

  return sendEmail(founder.email, subject, htmlBody, textBody);
}

/**
 * Email: Send wire info so Mat can purchase shares
 */
export async function sendWireInfoRequestEmail(
  founder: FounderInfo,
  details: { shareCount: number; totalAmount: string; sharePrice: string }
): Promise<EmailResult> {
  const subject = `Next Step - Send Wire Info for Share Purchase`;
  const portalUrl = `${BASE_URL}/founder`;
  const firstName = founder.name.split(' ')[0];

  const htmlBody = wrapEmail(`
    <h2>Hi ${firstName},</h2>
    <p>The stock agreement is fully signed! Now I need to purchase the shares.</p>
    <p>Please send me your company's wire/payment information so I can send <strong>$${details.totalAmount}</strong> for <strong>${details.shareCount.toLocaleString()} shares</strong> at $${details.sharePrice}/share.</p>
    <p>You can upload a wire instruction document (PDF from your bank) or provide the details through the portal:</p>
    ${emailButton('Upload Wire Info', portalUrl)}
    <p>Typical wire info includes:</p>
    <ul>
      <li>Bank name & address</li>
      <li>Account name</li>
      <li>Account number</li>
      <li>Routing number (ABA/ACH)</li>
      <li>Any reference/memo to include</li>
    </ul>
  `);

  const textBody = `Hi ${firstName},

The stock agreement is fully signed! Now I need to purchase the shares.

Please send me your company's wire/payment information so I can send $${details.totalAmount} for ${details.shareCount.toLocaleString()} shares at $${details.sharePrice}/share.

Upload wire info here: ${portalUrl}

Best,
Mat`;

  return sendEmail(founder.email, subject, htmlBody, textBody);
}

/**
 * Email: Shares purchased, 83(b) being filed
 */
export async function sendSharesPurchasedEmail(
  founder: FounderInfo,
  workflow: WorkflowInfo
): Promise<EmailResult> {
  const subject = `Shares purchased - 83(b) election being filed`;

  const htmlBody = wrapEmail(`
    <h2>Hi ${founder.name},</h2>
    <p>I've purchased my shares in ${founder.companyName}:</p>
    <ul>
      <li>${workflow.shareCount.toLocaleString()} shares at $${workflow.sharePrice}/share</li>
      <li>Total: $${workflow.totalAmount}</li>
    </ul>
    <p>I'm filing my 83(b) election with the IRS (required within 30 days of the grant). I'll send you a copy once it's mailed.</p>
    <p><strong>Next step:</strong> I'll reach out when it's time for you to issue the stock certificate.</p>
  `);

  const textBody = `Hi ${founder.name},

I've purchased my shares in ${founder.companyName}:
- ${workflow.shareCount.toLocaleString()} shares at $${workflow.sharePrice}/share
- Total: $${workflow.totalAmount}

I'm filing my 83(b) election with the IRS (required within 30 days of the grant). I'll send you a copy once it's mailed.

Next step: I'll reach out when it's time for you to issue the stock certificate.

Best,
Mat`;

  return sendEmail(founder.email, subject, htmlBody, textBody);
}

/**
 * Email: Issue stock certificate
 */
export async function sendCertificateRequestEmail(founder: FounderInfo, workflow: WorkflowInfo): Promise<EmailResult> {
  const subject = `Final Step - Issue Stock Certificate`;
  const portalUrl = `${BASE_URL}/founder`;

  const htmlBody = wrapEmail(`
    <h2>Hi ${founder.name},</h2>
    <p>I've signed the equity agreement and purchased the shares. I've also filed my 83(b) election with the IRS.</p>
    <p><strong>Last step:</strong> Please issue the stock certificate.</p>
    <h3>In Carta:</h3>
    <ol>
      <li>Go to Securities → Issue Certificate</li>
      <li>Select the shareholder (MatCapital)</li>
      <li>Generate and download the certificate</li>
    </ol>
    <h3>In Pulley:</h3>
    <ol>
      <li>Go to Cap Table → Certificates</li>
      <li>Create new certificate for the existing grant</li>
      <li>Download the PDF</li>
    </ol>
    ${emailButton('Upload Certificate', portalUrl)}
  `);

  const textBody = `Hi ${founder.name},

I've signed the equity agreement and purchased the shares. I've also filed my 83(b) election with the IRS.

Last step: Please issue the stock certificate.

In Carta:
1. Go to Securities → Issue Certificate
2. Select the shareholder (MatCapital)
3. Generate and download the certificate

In Pulley:
1. Go to Cap Table → Certificates
2. Create new certificate for the existing grant
3. Download the PDF

Upload here: ${portalUrl}

Best,
Mat`;

  return sendEmail(founder.email, subject, htmlBody, textBody);
}

/**
 * Email: Reminder for pending action
 */
export async function sendReminderEmail(
  founder: FounderInfo,
  action: string,
  daysSince: number
): Promise<EmailResult> {
  const subject = `Reminder: ${action}`;
  const portalUrl = `${BASE_URL}/founder`;

  const htmlBody = wrapEmail(`
    <h2>Hi ${founder.name},</h2>
    <p>Just a friendly reminder - we're waiting on: <strong>${action}</strong></p>
    <p>It's been ${daysSince} days since the last step. Let me know if you have any questions or need help!</p>
    ${emailButton('Go to Portal', portalUrl)}
  `);

  const textBody = `Hi ${founder.name},

Just a friendly reminder - we're waiting on: ${action}

It's been ${daysSince} days since the last step. Let me know if you have any questions!

Portal: ${portalUrl}

Best,
Mat`;

  return sendEmail(founder.email, subject, htmlBody, textBody);
}

/**
 * Email: Equity commitment confirmation (pre-incorporation partner path)
 */
export async function sendEquityCommitmentConfirmationEmail(
  founder: FounderInfo,
  partner: string
): Promise<EmailResult> {
  const subject = `Equity commitment confirmed`;
  const firstName = founder.name.split(' ')[0];

  const partnerLinks: Record<string, string> = {
    'stripe_atlas': 'https://stripe.com/atlas',
    'clerky': 'https://www.clerky.com',
    'goodwin': 'https://www.goodwinlaw.com',
  };

  const partnerNames: Record<string, string> = {
    'stripe_atlas': 'Stripe Atlas',
    'clerky': 'Clerky',
    'goodwin': 'Goodwin',
  };

  const partnerName = partnerNames[partner] || partner;
  const partnerLink = partnerLinks[partner] || '';

  const htmlBody = wrapEmail(`
    <h2>Hi ${firstName},</h2>
    <p>Thanks for signing the pre-incorporation equity commitment. Here's a summary:</p>
    <ul>
      <li>You've committed to issuing equity to MatCapital upon incorporation</li>
      <li>Your incorporation partner: <strong>${partnerName}</strong></li>
    </ul>
    ${partnerLink ? `<p>Get started with ${partnerName}: <a href="${partnerLink}" style="color: #2563eb;">${partnerLink}</a></p>` : ''}
    <p>Once you're incorporated, come back to your portal and click "I'm now incorporated" to continue with the equity paperwork.</p>
    ${emailButton('Go to Portal', `${BASE_URL}/founder`)}
  `);

  const textBody = `Hi ${firstName},

Thanks for signing the pre-incorporation equity commitment. Here's a summary:
- You've committed to issuing equity to MatCapital upon incorporation
- Your incorporation partner: ${partnerName}
${partnerLink ? `\nGet started with ${partnerName}: ${partnerLink}\n` : ''}
Once you're incorporated, come back to your portal and click "I'm now incorporated" to continue.

Portal: ${BASE_URL}/founder

Best,
Mat`;

  return sendEmail(founder.email, subject, htmlBody, textBody);
}

/**
 * Email: Light engagement confirmation (side project path)
 */
export async function sendLightEngagementConfirmationEmail(founder: FounderInfo): Promise<EmailResult> {
  const subject = `Welcome to the MatCap network`;
  const firstName = founder.name.split(' ')[0];

  const htmlBody = wrapEmail(`
    <h2>Hi ${firstName},</h2>
    <p>No rush on incorporation - we're glad to have you in the network!</p>
    <p>Here's what this means:</p>
    <ul>
      <li>You'll have access to MatCap events and office hours</li>
      <li>We'll check in quarterly to see how things are going</li>
      <li>When you're ready to incorporate, just let us know through the portal and we'll get the equity paperwork started</li>
    </ul>
    ${emailButton('Go to Portal', `${BASE_URL}/founder`)}
  `);

  const textBody = `Hi ${firstName},

No rush on incorporation - we're glad to have you in the network!

Here's what this means:
- You'll have access to MatCap events and office hours
- We'll check in quarterly to see how things are going
- When you're ready to incorporate, just let us know through the portal

Portal: ${BASE_URL}/founder

Best,
Mat`;

  return sendEmail(founder.email, subject, htmlBody, textBody);
}

/**
 * Email: Incorporation nudge (sent every ~3 months to light_engagement founders)
 */
export async function sendIncorporationNudgeEmail(founder: FounderInfo): Promise<EmailResult> {
  const subject = `Checking in - ready to incorporate?`;
  const firstName = founder.name.split(' ')[0];

  const htmlBody = wrapEmail(`
    <h2>Hi ${firstName},</h2>
    <p>Just checking in! How is ${founder.companyName} going?</p>
    <p>If you've incorporated or are planning to soon, let us know through the portal and we'll get the equity paperwork started.</p>
    <p>No rush - just wanted to touch base!</p>
    ${emailButton('Update Status', `${BASE_URL}/founder`)}
  `);

  const textBody = `Hi ${firstName},

Just checking in! How is ${founder.companyName} going?

If you've incorporated or are planning to soon, let us know through the portal and we'll get the equity paperwork started.

No rush - just wanted to touch base!

Portal: ${BASE_URL}/founder

Best,
Mat`;

  return sendEmail(founder.email, subject, htmlBody, textBody);
}

// ============== ADMIN EMAILS ==============

/**
 * Email to admin: Entity info received - ready to generate agreement
 */
export async function notifyAdminEntityInfoReceived(
  adminEmail: string,
  founder: FounderInfo,
  entityInfo: { entityName: string; entityType: string; authorizedShares: number }
): Promise<EmailResult> {
  const subject = `[MatCap] ${founder.companyName} submitted company details - generate agreement`;

  const htmlBody = wrapEmail(`
    <h2>Company Details Received</h2>
    <p><strong>${founder.name}</strong> (${founder.companyName}) has submitted their company details:</p>
    <ul>
      <li><strong>Entity:</strong> ${entityInfo.entityName}</li>
      <li><strong>Type:</strong> ${entityInfo.entityType.toUpperCase()}</li>
      <li><strong>Authorized Shares:</strong> ${entityInfo.authorizedShares.toLocaleString()}</li>
    </ul>
    <p><strong>Next step:</strong> Generate and send the advisory agreement.</p>
    ${emailButton('Generate Agreement', `${BASE_URL}/?tab=onboarding`)}
  `);

  const textBody = `Company Details Received

${founder.name} (${founder.companyName}) has submitted their company details:
- Entity: ${entityInfo.entityName}
- Type: ${entityInfo.entityType.toUpperCase()}
- Authorized Shares: ${entityInfo.authorizedShares.toLocaleString()}

Next step: Generate and send the advisory agreement.

View in admin: ${BASE_URL}/?tab=onboarding`;

  return sendEmail(adminEmail, subject, htmlBody, textBody);
}

/**
 * Email to admin: Advisory agreement complete
 */
export async function notifyAdminAdvisoryComplete(
  adminEmail: string,
  founder: FounderInfo
): Promise<EmailResult> {
  const subject = `[MatCap] ${founder.companyName} advisory agreement signed`;

  const htmlBody = wrapEmail(`
    <h2>Advisory Agreement Complete</h2>
    <p><strong>${founder.name}</strong> (${founder.companyName}) has signed the advisory agreement.</p>
    <p>Next step: Wait for founder to upload equity purchase agreement, then sign it.</p>
    ${emailButton('View in Admin', `${BASE_URL}/#/onboarding`)}
  `);

  const textBody = `Advisory Agreement Complete

${founder.name} (${founder.companyName}) has signed the advisory agreement.

Next step: Wait for founder to upload equity purchase agreement, then sign it.

View in admin: ${BASE_URL}/#/onboarding`;

  return sendEmail(adminEmail, subject, htmlBody, textBody);
}

/**
 * Email to admin: Equity agreement uploaded
 */
export async function notifyAdminEquityAgreementUploaded(
  adminEmail: string,
  founder: FounderInfo
): Promise<EmailResult> {
  const subject = `[MatCap] ${founder.companyName} uploaded equity agreement - sign it`;

  const htmlBody = wrapEmail(`
    <h2>Equity Agreement Ready to Sign</h2>
    <p><strong>${founder.name}</strong> (${founder.companyName}) has uploaded their equity purchase agreement.</p>
    <p>Please review and sign it.</p>
    ${emailButton('Review & Sign', `${BASE_URL}/#/onboarding`)}
  `);

  const textBody = `Equity Agreement Ready to Sign

${founder.name} (${founder.companyName}) has uploaded their equity purchase agreement.

Please review and sign it: ${BASE_URL}/#/onboarding`;

  return sendEmail(adminEmail, subject, htmlBody, textBody);
}

/**
 * Email to admin: Wire info received - ready to purchase shares
 */
export async function notifyAdminWireInfoReceived(
  adminEmail: string,
  founder: FounderInfo
): Promise<EmailResult> {
  const subject = `[MatCap] ${founder.companyName} sent wire info - purchase shares`;

  const htmlBody = wrapEmail(`
    <h2>Wire Info Received</h2>
    <p><strong>${founder.name}</strong> (${founder.companyName}) has uploaded their wire/payment information.</p>
    <p>You can now purchase the shares and mark it complete in the admin dashboard.</p>
    ${emailButton('View in Admin', `${BASE_URL}/?tab=onboarding`)}
  `);

  const textBody = `Wire Info Received

${founder.name} (${founder.companyName}) has uploaded their wire/payment information.

Purchase shares and mark complete: ${BASE_URL}/?tab=onboarding`;

  return sendEmail(adminEmail, subject, htmlBody, textBody);
}

/**
 * Email to admin: Certificate uploaded
 */
export async function notifyAdminCertificateUploaded(
  adminEmail: string,
  founder: FounderInfo
): Promise<EmailResult> {
  const subject = `[MatCap] ${founder.companyName} certificate uploaded - verify`;

  const htmlBody = wrapEmail(`
    <h2>Certificate Ready for Verification</h2>
    <p><strong>${founder.name}</strong> (${founder.companyName}) has uploaded the stock certificate.</p>
    <p>Please verify and complete the onboarding.</p>
    ${emailButton('Verify Certificate', `${BASE_URL}/#/onboarding`)}
  `);

  const textBody = `Certificate Ready for Verification

${founder.name} (${founder.companyName}) has uploaded the stock certificate.

Please verify: ${BASE_URL}/#/onboarding`;

  return sendEmail(adminEmail, subject, htmlBody, textBody);
}

// ============== VOICE INTERVIEW EMAILS ==============

/**
 * Email: Voice interview invitation to founder
 */
export async function sendVoiceInterviewEmail(
  email: string,
  firstName: string,
  companyName: string,
  interviewUrl: string
): Promise<EmailResult> {
  const subject = `We'd love to learn more about ${companyName}`;

  const htmlBody = wrapEmail(`
    <h2>Hi ${firstName},</h2>
    <p>Thanks for applying to MatCap! We've been looking into ${companyName} and have a few tailored questions for you.</p>
    <p>Instead of scheduling a call, we'd love for you to <strong>record short audio answers</strong> — just a few minutes of your time, whenever works best.</p>
    ${emailButton('Record Your Answers', interviewUrl)}
    <p style="color: #666; font-size: 14px;">This link expires in <strong>48 hours</strong>. You can pause and come back to it anytime before then.</p>
  `);

  const textBody = `Hi ${firstName},

Thanks for applying to MatCap! We've been looking into ${companyName} and have a few tailored questions for you.

Instead of scheduling a call, we'd love for you to record short audio answers — just a few minutes of your time, whenever works best.

Record your answers here: ${interviewUrl}

This link expires in 48 hours. You can pause and come back to it anytime before then.

Best,
Mat`;

  return sendEmail(email, subject, htmlBody, textBody);
}

/**
 * Email to admin: Voice interview completed
 */
export async function notifyAdminInterviewCompleted(
  adminEmail: string,
  founderName: string,
  companyName: string
): Promise<EmailResult> {
  const subject = `[MatCap] ${founderName} completed voice interview for ${companyName}`;

  const htmlBody = wrapEmail(`
    <h2>Voice Interview Completed</h2>
    <p><strong>${founderName}</strong> (${companyName}) has completed their voice interview.</p>
    <p>Listen to their answers in the admin dashboard.</p>
    ${emailButton('Review Interview', `${BASE_URL}/admin`)}
  `);

  const textBody = `Voice Interview Completed

${founderName} (${companyName}) has completed their voice interview.

Listen to their answers: ${BASE_URL}/admin`;

  return sendEmail(adminEmail, subject, htmlBody, textBody);
}

/**
 * Check if email service is configured
 */
export function isConfigured(): boolean {
  return !!process.env.POSTMARK_API_KEY;
}
