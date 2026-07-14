/**
 * Drop-off reminder for the formation-documents upload step.
 *
 * When a founder answers "yes, I'm incorporated" they land on the doc-upload
 * step while already in the portal, so we do NOT email them right away. This
 * sweep emails the "upload your formation documents" nudge only if they've sat
 * in `docs_pending` for >10 minutes without uploading. Sent once (guarded by
 * docs_reminder_sent_at).
 */

import { and, eq, lt, isNull } from 'drizzle-orm';
import { db, onboardingWorkflows, portfolioCompanies, founders, OnboardingStatus } from '../db/index.js';
import * as onboardingEmails from './onboarding-emails.js';

const REMINDER_DELAY_MS = 10 * 60 * 1000; // 10 minutes

export async function runDocsReminders(): Promise<{ sent: number }> {
  const cutoff = new Date(Date.now() - REMINDER_DELAY_MS).toISOString();

  const stuck = await db.query.onboardingWorkflows.findMany({
    where: and(
      eq(onboardingWorkflows.status, OnboardingStatus.DOCS_PENDING),
      isNull(onboardingWorkflows.docsReminderSentAt),
      lt(onboardingWorkflows.updatedAt, cutoff),
    ),
  });

  let sent = 0;
  for (const wf of stuck) {
    const pc = await db.query.portfolioCompanies.findFirst({
      where: eq(portfolioCompanies.id, wf.portfolioCompanyId),
    });
    if (!pc) continue;
    const founder = await db.query.founders.findFirst({ where: eq(founders.id, pc.founderId) });
    if (!founder?.email) continue;

    await onboardingEmails.sendEntityInfoRequestEmail({
      name: founder.name,
      email: founder.email,
      companyName: founder.companyName,
    });
    // Mark sent so it never fires twice, even before the next status change.
    await db.update(onboardingWorkflows)
      .set({ docsReminderSentAt: new Date().toISOString() })
      .where(eq(onboardingWorkflows.id, wf.id));
    sent++;
  }

  return { sent };
}
