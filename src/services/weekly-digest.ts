import { db, founders, introRequests, investors } from '../db/index.js';
import { eq, and, gte, desc } from 'drizzle-orm';
import { sendEmail } from './email.js';

interface WeeklyActivity {
  newRequests: number;
  introsMade: number;
  meetingsScheduled: number;
  passes: number;
  investments: number;
  introUpdates: Array<{
    investorName: string;
    investorFirm: string | null;
    status: string;
    meetingDate?: string | null;
    passReason?: string | null;
  }>;
  needsAttention: Array<{
    investorName: string;
    investorFirm: string | null;
    reason: string;
    daysOverdue?: number;
  }>;
  allTimeStats: {
    totalRequests: number;
    introduced: number;
    invested: number;
    acceptRate: number;
    globalAcceptRate: number;
  };
}

/**
 * Get the start of the current week (Monday 00:00 UTC)
 */
function getWeekStart(): Date {
  const now = new Date();
  const dayOfWeek = now.getUTCDay();
  const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() - daysFromMonday);
  monday.setUTCHours(0, 0, 0, 0);
  return monday;
}

/**
 * Format date as "Mon DD"
 */
function formatShortDate(date: Date): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[date.getMonth()]} ${date.getDate()}`;
}

/**
 * Format status for display
 */
function formatStatus(status: string): string {
  const statusMap: Record<string, string> = {
    'intro_request_sent': 'Request Sent',
    'introduced': 'Introduced',
    'passed': 'Passed',
    'ignored': 'No Response',
    'first_meeting_complete': 'First Meeting Done',
    'second_meeting_complete': 'Second Meeting Done',
    'follow_up_questions': 'Follow-up Questions',
    'circle_back_round_opens': 'Circle Back Later',
    'invested': 'Invested',
  };
  return statusMap[status] || status;
}

/**
 * Get weekly activity for a founder
 */
async function getFounderWeeklyActivity(founderId: number): Promise<WeeklyActivity | null> {
  const weekStart = getWeekStart();
  const weekStartStr = weekStart.toISOString();
  const today = new Date().toISOString().split('T')[0];

  // Get all intro requests for this founder
  const allIntros = await db.query.introRequests.findMany({
    where: eq(introRequests.founderId, founderId),
    with: {
      investor: true,
    },
  });

  // Filter for activity this week (created or updated this week)
  const weeklyIntros = allIntros.filter(intro => {
    const updatedAt = intro.updatedAt || intro.createdAt;
    return updatedAt >= weekStartStr;
  });

  // If no activity this week, return null
  if (weeklyIntros.length === 0) {
    return null;
  }

  // Count activity types
  let newRequests = 0;
  let introsMade = 0;
  let meetingsScheduled = 0;
  let passes = 0;
  let investments = 0;
  const introUpdates: WeeklyActivity['introUpdates'] = [];

  for (const intro of weeklyIntros) {
    // Check if created this week
    if (intro.createdAt >= weekStartStr) {
      newRequests++;
    }

    // Check status-based activity
    if (intro.status === 'introduced' && intro.dateIntroduced && intro.dateIntroduced >= weekStartStr.split('T')[0]) {
      introsMade++;
    }
    if (intro.status === 'first_meeting_complete' || intro.status === 'second_meeting_complete') {
      meetingsScheduled++;
    }
    if (intro.status === 'passed') {
      passes++;
    }
    if (intro.status === 'invested') {
      investments++;
    }

    // Add to updates list
    introUpdates.push({
      investorName: intro.investor?.name || 'Unknown',
      investorFirm: intro.investor?.firm || null,
      status: intro.status,
      meetingDate: intro.firstMeetingDate || intro.secondMeetingDate,
      passReason: intro.passReason,
    });
  }

  // Find items needing attention (overdue follow-ups owned by founder)
  const needsAttention: WeeklyActivity['needsAttention'] = [];
  for (const intro of allIntros) {
    // Overdue follow-ups
    if (intro.nextFollowupDate && intro.nextFollowupDate < today && intro.followupOwner === 'founder') {
      const dueDate = new Date(intro.nextFollowupDate);
      const now = new Date();
      const daysOverdue = Math.floor((now.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24));
      needsAttention.push({
        investorName: intro.investor?.name || 'Unknown',
        investorFirm: intro.investor?.firm || null,
        reason: 'Follow-up overdue',
        daysOverdue,
      });
    }
  }

  // Calculate all-time stats
  const totalRequests = allIntros.length;
  const introduced = allIntros.filter(i =>
    ['introduced', 'first_meeting_complete', 'second_meeting_complete', 'circle_back_round_opens', 'invested'].includes(i.status)
  ).length;
  const invested = allIntros.filter(i => i.status === 'invested').length;
  const decided = allIntros.filter(i =>
    !['intro_request_sent', 'follow_up_questions'].includes(i.status)
  ).length;
  const acceptRate = decided > 0 ? Math.round((introduced / decided) * 100) : 0;

  // Global accept rate (all founders)
  const allRequests = await db.select().from(introRequests);
  const globalIntroduced = allRequests.filter(i =>
    ['introduced', 'first_meeting_complete', 'second_meeting_complete', 'circle_back_round_opens', 'invested'].includes(i.status)
  ).length;
  const globalDecided = allRequests.filter(i =>
    !['intro_request_sent', 'follow_up_questions'].includes(i.status)
  ).length;
  const globalAcceptRate = globalDecided > 0 ? Math.round((globalIntroduced / globalDecided) * 100) : 0;

  return {
    newRequests,
    introsMade,
    meetingsScheduled,
    passes,
    investments,
    introUpdates,
    needsAttention,
    allTimeStats: {
      totalRequests,
      introduced,
      invested,
      acceptRate,
      globalAcceptRate,
    },
  };
}

/**
 * Generate the email HTML for a founder's weekly digest
 */
function generateDigestEmail(founderName: string, activity: WeeklyActivity, portalUrl: string): { subject: string; html: string; text: string } {
  const weekStart = getWeekStart();
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);

  const firstName = founderName.split(' ')[0];
  const subject = `Your MatCap Weekly Update`;

  // Build intro updates section
  let introUpdatesHtml = '';
  let introUpdatesText = '';
  if (activity.introUpdates.length > 0) {
    introUpdatesHtml = activity.introUpdates.map(intro => {
      let detail = '';
      if (intro.meetingDate) {
        detail = `<br><span style="color: #666; font-size: 13px;">Meeting on ${intro.meetingDate}</span>`;
      } else if (intro.status === 'invested') {
        detail = `<br><span style="color: #22c55e; font-size: 13px;">Congratulations!</span>`;
      }
      return `<li style="margin-bottom: 8px;"><strong>${intro.investorName}</strong>${intro.investorFirm ? ` @ ${intro.investorFirm}` : ''} &rarr; ${formatStatus(intro.status)}${detail}</li>`;
    }).join('\n');

    introUpdatesText = activity.introUpdates.map(intro => {
      let detail = '';
      if (intro.meetingDate) {
        detail = `\n  Meeting on ${intro.meetingDate}`;
      } else if (intro.status === 'invested') {
        detail = `\n  Congratulations!`;
      }
      return `- ${intro.investorName}${intro.investorFirm ? ` @ ${intro.investorFirm}` : ''} -> ${formatStatus(intro.status)}${detail}`;
    }).join('\n');
  }

  // Build needs attention section
  let needsAttentionHtml = '';
  let needsAttentionText = '';
  if (activity.needsAttention.length > 0) {
    needsAttentionHtml = `
      <h3 style="color: #dc2626; margin-top: 24px;">Needs Your Attention</h3>
      <ul style="list-style: none; padding: 0;">
        ${activity.needsAttention.map(item =>
          `<li style="margin-bottom: 8px;">- <strong>${item.investorName}</strong>${item.investorFirm ? ` @ ${item.investorFirm}` : ''} - ${item.reason}${item.daysOverdue ? ` (${item.daysOverdue} days overdue)` : ''}</li>`
        ).join('\n')}
      </ul>
    `;
    needsAttentionText = `\n\nNEEDS YOUR ATTENTION\n${activity.needsAttention.map(item =>
      `- ${item.investorName}${item.investorFirm ? ` @ ${item.investorFirm}` : ''} - ${item.reason}${item.daysOverdue ? ` (${item.daysOverdue} days overdue)` : ''}`
    ).join('\n')}`;
  }

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h2 style="color: #1f2937;">Hi ${firstName},</h2>

  <p>Here's your MatCap activity for the week of ${formatShortDate(weekStart)} - ${formatShortDate(weekEnd)}:</p>

  <div style="background: #f3f4f6; border-radius: 8px; padding: 16px; margin: 20px 0;">
    <h3 style="margin-top: 0; color: #374151;">This Week's Activity</h3>
    <table style="width: 100%; border-collapse: collapse;">
      <tr>
        <td style="padding: 4px 0;">New Intro Requests:</td>
        <td style="padding: 4px 0; text-align: right; font-weight: bold;">${activity.newRequests}</td>
      </tr>
      <tr>
        <td style="padding: 4px 0;">Intros Made:</td>
        <td style="padding: 4px 0; text-align: right; font-weight: bold;">${activity.introsMade}</td>
      </tr>
      <tr>
        <td style="padding: 4px 0;">Meetings Scheduled:</td>
        <td style="padding: 4px 0; text-align: right; font-weight: bold;">${activity.meetingsScheduled}</td>
      </tr>
      <tr>
        <td style="padding: 4px 0;">Passes:</td>
        <td style="padding: 4px 0; text-align: right; font-weight: bold;">${activity.passes}</td>
      </tr>
      ${activity.investments > 0 ? `
      <tr>
        <td style="padding: 4px 0; color: #22c55e;">Investments:</td>
        <td style="padding: 4px 0; text-align: right; font-weight: bold; color: #22c55e;">${activity.investments}</td>
      </tr>
      ` : ''}
    </table>
  </div>

  ${introUpdatesHtml ? `
  <h3 style="color: #374151;">Intro Updates</h3>
  <ul style="list-style: none; padding: 0;">
    ${introUpdatesHtml}
  </ul>
  ` : ''}

  ${needsAttentionHtml}

  <div style="background: #eff6ff; border-radius: 8px; padding: 16px; margin: 20px 0;">
    <h3 style="margin-top: 0; color: #1e40af;">All-Time Stats</h3>
    <p style="margin: 0;">
      Total Requests: <strong>${activity.allTimeStats.totalRequests}</strong> |
      Introduced: <strong>${activity.allTimeStats.introduced}</strong> |
      Invested: <strong>${activity.allTimeStats.invested}</strong><br>
      Your Accept Rate: <strong>${activity.allTimeStats.acceptRate}%</strong>
      (Network avg: ${activity.allTimeStats.globalAcceptRate}%)
    </p>
  </div>

  <p style="margin-top: 24px;">
    <a href="${portalUrl}" style="display: inline-block; background: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 500;">View Your Dashboard</a>
  </p>

  <p style="color: #6b7280; margin-top: 32px;">
    Best,<br>
    Mat
  </p>

  <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 32px 0;">
  <p style="color: #9ca3af; font-size: 12px;">
    MatCap | You're receiving this because you're a MatCap portfolio founder.
  </p>
</body>
</html>
  `;

  const text = `Hi ${firstName},

Here's your MatCap activity for the week of ${formatShortDate(weekStart)} - ${formatShortDate(weekEnd)}:

THIS WEEK'S ACTIVITY
- New Intro Requests: ${activity.newRequests}
- Intros Made: ${activity.introsMade}
- Meetings Scheduled: ${activity.meetingsScheduled}
- Passes: ${activity.passes}
${activity.investments > 0 ? `- Investments: ${activity.investments}` : ''}

${introUpdatesText ? `INTRO UPDATES\n${introUpdatesText}` : ''}
${needsAttentionText}

ALL-TIME STATS
Total Requests: ${activity.allTimeStats.totalRequests} | Introduced: ${activity.allTimeStats.introduced} | Invested: ${activity.allTimeStats.invested}
Your Accept Rate: ${activity.allTimeStats.acceptRate}% (Network avg: ${activity.allTimeStats.globalAcceptRate}%)

View your dashboard: ${portalUrl}

Best,
Mat

---
MatCap | You're receiving this because you're a MatCap portfolio founder.
`;

  return { subject, html, text };
}

/**
 * Send weekly digest to all founders with activity
 */
export async function sendWeeklyDigests(): Promise<{ sent: number; skipped: number; errors: string[] }> {
  const allFounders = await db.query.founders.findMany({
    where: eq(founders.hidden, false),
  });

  let sent = 0;
  let skipped = 0;
  const errors: string[] = [];

  const baseUrl = process.env.BASE_URL || 'https://nodestacker.fly.dev';

  for (const founder of allFounders) {
    try {
      const activity = await getFounderWeeklyActivity(founder.id);

      if (!activity) {
        skipped++;
        console.log(`[WEEKLY-DIGEST] Skipping ${founder.name} - no activity this week`);
        continue;
      }

      const portalUrl = `${baseUrl}/founder.html`;
      const { subject, html, text } = generateDigestEmail(founder.name, activity, portalUrl);

      await sendEmail({
        to: founder.email,
        subject,
        html,
        text,
      });

      sent++;
      console.log(`[WEEKLY-DIGEST] Sent digest to ${founder.name} (${founder.email})`);
    } catch (err) {
      const errorMsg = `Failed to send to ${founder.name}: ${err instanceof Error ? err.message : 'Unknown error'}`;
      errors.push(errorMsg);
      console.error(`[WEEKLY-DIGEST] ${errorMsg}`);
    }
  }

  console.log(`[WEEKLY-DIGEST] Complete: ${sent} sent, ${skipped} skipped, ${errors.length} errors`);
  return { sent, skipped, errors };
}

/**
 * Preview digest for a specific founder (for testing)
 */
export async function previewDigest(founderId: number): Promise<{ html: string; text: string; subject: string } | null> {
  const founder = await db.query.founders.findFirst({
    where: eq(founders.id, founderId),
  });

  if (!founder) {
    return null;
  }

  const activity = await getFounderWeeklyActivity(founderId);
  if (!activity) {
    return null;
  }

  const baseUrl = process.env.BASE_URL || 'https://nodestacker.fly.dev';
  const portalUrl = `${baseUrl}/founder.html`;

  return generateDigestEmail(founder.name, activity, portalUrl);
}
