/**
 * Event-driven founder emails tied to a specific intro.
 *
 * These fire off real events (an intro going out), not a schedule, so they stay
 * relevant and don't add to the weekly digest's cadence. The intro-sent email
 * doubles as light coaching: it shows the founder exactly how to reply to the
 * connector's intro (move them to BCC, propose times) and points them back into
 * their CRM to log the meeting once it's set.
 */

import { sendEmail } from './email.js';

const ACCENT = '#00C2E0';

function firstName(full: string): string {
  return (full || '').trim().split(/\s+/)[0] || full;
}

interface IntroSentParams {
  founderName: string;
  founderEmail: string;
  investorName: string;
  investorFirm: string;
  nodeName: string;
  /** True when this is the founder's very first intro — show fuller coaching. */
  isFirstIntro: boolean;
}

/**
 * Email the founder the moment an intro goes out. Frames it as a win, coaches
 * the reply, and gives a single CTA back into the CRM to log the meeting.
 */
export async function sendIntroSentEmail(params: IntroSentParams) {
  const { founderName, founderEmail, investorName, investorFirm, nodeName, isFirstIntro } = params;

  if (!founderEmail) {
    console.log(`[INTRO-EMAIL] No email for founder ${founderName} — skipping intro-sent email`);
    return;
  }

  const baseUrl = process.env.BASE_URL || 'https://matcap.vc';
  const portalUrl = `${baseUrl}/founder.html`;

  const investorFirst = firstName(investorName);
  const nodeFirst = firstName(nodeName);
  const founderFirst = firstName(founderName);

  const subject = `You're connected with ${investorName}${investorFirm ? ` (${investorFirm})` : ''}`;

  // The reply template the founder should send back on the intro thread.
  const replyTemplate =
    `Thanks ${nodeFirst}, moving you to BCC 🙏\n\n` +
    `Hi ${investorFirst}, great to connect! Here are three times that work on my end:\n` +
    `  • [Option A]\n  • [Option B]\n  • [Option C]\n` +
    `(all PST — happy to flex to your zone). Anything work for you there? Looking forward to it!`;

  const replyTemplateHtml = replyTemplate
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/\n/g, '<br>');

  const firstIntroNote = isFirstIntro
    ? `<p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:#444">
         Since this is your first intro through MatCap, here's the move that works best:
         <strong>reply on the thread, move ${nodeFirst} to BCC, and propose a few specific times.</strong>
         It keeps things warm and makes it effortless for ${investorFirst} to say yes.
       </p>`
    : `<p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:#444">
         Quick reminder on the move that converts best: reply on the thread, move ${nodeFirst} to BCC, and propose a few specific times.
       </p>`;

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f7fa;margin:0;padding:32px 16px;color:#1a1a1a">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:32px 28px">
    <p style="margin:0 0 18px;font-size:15px;line-height:1.5">Hi ${founderFirst},</p>
    <p style="margin:0 0 18px;font-size:15px;line-height:1.6">
      <strong>The intro to ${investorName}${investorFirm ? ` at ${investorFirm}` : ''} just went out.</strong>
      The ball's in your court now — nice work getting here.
    </p>
    ${firstIntroNote}
    <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#555;text-transform:uppercase;letter-spacing:.03em">Reply you can paste & tweak</p>
    <div style="background:#f7fafc;border-left:3px solid ${ACCENT};border-radius:6px;padding:14px 16px;margin:0 0 22px;font-size:14px;line-height:1.6;color:#222">
      ${replyTemplateHtml}
    </div>
    <p style="margin:0 0 22px;font-size:15px;line-height:1.6;color:#444">
      Once you've got a time on the calendar, drop the date in your CRM so we can help you push the conversation forward.
    </p>
    <p style="margin:0 0 18px;font-size:14px;line-height:1.5">
      <a href="${portalUrl}" style="display:inline-block;background:${ACCENT};color:#fff;padding:11px 22px;text-decoration:none;border-radius:6px;font-weight:600">Log this meeting in your CRM →</a>
    </p>
    <p style="margin:24px 0 0;font-size:15px;line-height:1.5">— Mat</p>
    <hr style="border:none;border-top:1px solid #eee;margin:28px 0 16px">
    <p style="margin:0;font-size:11px;color:#999">MatCap · You're receiving this because you're a MatCap portfolio founder.</p>
  </div>
</body>
</html>
`.trim();

  const text = `
Hi ${founderFirst},

The intro to ${investorName}${investorFirm ? ` at ${investorFirm}` : ''} just went out. The ball's in your court now — nice work getting here.

${isFirstIntro
  ? `Since this is your first intro through MatCap, here's the move that works best: reply on the thread, move ${nodeFirst} to BCC, and propose a few specific times. It keeps things warm and makes it effortless for ${investorFirst} to say yes.`
  : `Quick reminder on the move that converts best: reply on the thread, move ${nodeFirst} to BCC, and propose a few specific times.`}

REPLY YOU CAN PASTE & TWEAK
${replyTemplate}

Once you've got a time on the calendar, drop the date in your CRM so we can help you push the conversation forward.

Log this meeting in your CRM: ${portalUrl}

— Mat

---
MatCap · You're receiving this because you're a MatCap portfolio founder.
`.trim();

  await sendEmail({ to: founderEmail, subject, html, text });
}
