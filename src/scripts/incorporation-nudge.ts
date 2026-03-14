/**
 * Incorporation Nudge Script
 * Sends quarterly nudge emails to founders in light_engagement status.
 * Run via cron: 0 9 1 * * npx tsx src/scripts/incorporation-nudge.ts
 */

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq, and, or, isNull } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import * as onboardingEmails from '../services/onboarding-emails.js';

const sqlite = new Database('nodestacker.db');
const db = drizzle(sqlite, { schema });

const NUDGE_INTERVAL_DAYS = 90;

async function run() {
  const cutoffDate = new Date(Date.now() - NUDGE_INTERVAL_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // Find light_engagement workflows where last nudge was 90+ days ago (or never)
  const workflows = await db.query.onboardingWorkflows.findMany({
    where: eq(schema.onboardingWorkflows.status, schema.OnboardingStatus.LIGHT_ENGAGEMENT),
    with: {
      portfolioCompany: {
        with: {
          founder: true,
        },
      },
    },
  });

  const eligible = workflows.filter(w => {
    if (!w.lastIncorporationNudgeAt) return true;
    return w.lastIncorporationNudgeAt < cutoffDate;
  });

  console.log(`Found ${eligible.length} light_engagement workflows eligible for nudge`);

  for (const workflow of eligible) {
    const founder = workflow.portfolioCompany.founder;
    console.log(`  Nudging ${founder.name} (${founder.companyName})`);

    try {
      await onboardingEmails.sendIncorporationNudgeEmail({
        name: founder.name,
        email: founder.email,
        companyName: founder.companyName,
      });

      const now = new Date().toISOString();
      await db.update(schema.onboardingWorkflows)
        .set({ lastIncorporationNudgeAt: now, updatedAt: now })
        .where(eq(schema.onboardingWorkflows.id, workflow.id));

      await db.insert(schema.onboardingEvents).values({
        workflowId: workflow.id,
        eventType: schema.OnboardingEventType.INCORPORATION_NUDGE_SENT,
        actor: schema.OnboardingActor.SYSTEM,
        createdAt: now,
      });

      console.log(`    Nudge sent successfully`);
    } catch (err) {
      console.error(`    Failed to send nudge:`, err);
    }
  }

  console.log('Done!');
  sqlite.close();
}

run().catch(console.error);
