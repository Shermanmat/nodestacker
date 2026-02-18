/**
 * Daily Digest Script
 * Run this via cron: 0 8 * * * npx tsx src/scripts/send-digests.ts
 *
 * For now, outputs to console. To enable email:
 * 1. npm install resend
 * 2. Set RESEND_API_KEY environment variable
 * 3. Uncomment email sending code below
 */

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq, and, lt, isNull, inArray, or } from 'drizzle-orm';
import * as schema from '../db/schema.js';

const sqlite = new Database('nodestacker.db');
const db = drizzle(sqlite, { schema });

const today = new Date().toISOString().split('T')[0];
const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

interface DigestItem {
  type: 'overdue' | 'due_today' | 'pending_node' | 'update_node';
  intro: any;
}

async function getFounderDigest(founderId: number): Promise<DigestItem[]> {
  const items: DigestItem[] = [];

  // Overdue follow-ups
  const overdue = await db.query.introRequests.findMany({
    where: and(
      eq(schema.introRequests.founderId, founderId),
      eq(schema.introRequests.followupOwner, 'founder'),
      lt(schema.introRequests.nextFollowupDate, today),
      inArray(schema.introRequests.status, [
        'intro_request_sent', 'introduced', 'first_meeting_complete',
        'second_meeting_complete', 'follow_up_questions', 'circle_back_round_opens',
      ])
    ),
    with: { node: true, investor: true },
  });
  overdue.forEach(intro => items.push({ type: 'overdue', intro }));

  // Due today
  const dueToday = await db.query.introRequests.findMany({
    where: and(
      eq(schema.introRequests.founderId, founderId),
      eq(schema.introRequests.followupOwner, 'founder'),
      eq(schema.introRequests.nextFollowupDate, today)
    ),
    with: { node: true, investor: true },
  });
  dueToday.forEach(intro => items.push({ type: 'due_today', intro }));

  // Pending node response (3+ days)
  const pendingNode = await db.query.introRequests.findMany({
    where: and(
      eq(schema.introRequests.founderId, founderId),
      eq(schema.introRequests.status, 'intro_request_sent'),
      isNull(schema.introRequests.dateNodeAsked),
      lt(schema.introRequests.dateRequested, threeDaysAgo)
    ),
    with: { node: true, investor: true },
  });
  pendingNode.forEach(intro => items.push({ type: 'pending_node', intro }));

  // Nodes needing update
  const needsUpdate = await db.query.introRequests.findMany({
    where: and(
      eq(schema.introRequests.founderId, founderId),
      inArray(schema.introRequests.status, ['first_meeting_complete', 'second_meeting_complete', 'invested'])
    ),
    with: { node: true, investor: true, followupLogs: true },
  });
  needsUpdate
    .filter(req => !req.followupLogs.some(log => log.followupType === 'node_update'))
    .forEach(intro => items.push({ type: 'update_node', intro }));

  return items;
}

function formatDigestEmail(founder: any, items: DigestItem[]): string {
  if (items.length === 0) return '';

  let email = `Hi ${founder.name.split(' ')[0]},\n\n`;
  email += `Here's your daily NodeStacker digest:\n\n`;

  const overdue = items.filter(i => i.type === 'overdue');
  const dueToday = items.filter(i => i.type === 'due_today');
  const pendingNode = items.filter(i => i.type === 'pending_node');
  const updateNode = items.filter(i => i.type === 'update_node');

  if (overdue.length > 0) {
    email += `🔴 OVERDUE FOLLOW-UPS (${overdue.length})\n`;
    overdue.forEach(({ intro }) => {
      email += `  • ${intro.investor.name} @ ${intro.investor.firm} (via ${intro.node.name}) - was due ${intro.nextFollowupDate}\n`;
    });
    email += '\n';
  }

  if (dueToday.length > 0) {
    email += `🟡 DUE TODAY (${dueToday.length})\n`;
    dueToday.forEach(({ intro }) => {
      email += `  • ${intro.investor.name} @ ${intro.investor.firm} (via ${intro.node.name})\n`;
    });
    email += '\n';
  }

  if (pendingNode.length > 0) {
    email += `⏳ WAITING ON NODE RESPONSE (${pendingNode.length})\n`;
    pendingNode.forEach(({ intro }) => {
      email += `  • Follow up with ${intro.node.name} about intro to ${intro.investor.name}\n`;
    });
    email += '\n';
  }

  if (updateNode.length > 0) {
    email += `📣 UPDATE YOUR NODES (${updateNode.length})\n`;
    updateNode.forEach(({ intro }) => {
      email += `  • Let ${intro.node.name} know how it went with ${intro.investor.name}\n`;
    });
    email += '\n';
  }

  email += `\n--\nNodeStacker\n`;
  return email;
}

async function main() {
  console.log(`\n📬 NodeStacker Daily Digest - ${today}\n${'='.repeat(50)}\n`);

  // Get all founders
  const allFounders = await db.query.founders.findMany();

  let digestsSent = 0;

  for (const founder of allFounders) {
    const items = await getFounderDigest(founder.id);

    if (items.length > 0) {
      const emailBody = formatDigestEmail(founder, items);

      console.log(`\n📧 Digest for ${founder.name} (${founder.email})`);
      console.log('-'.repeat(40));
      console.log(emailBody);

      // TODO: Uncomment to send actual emails
      // const { Resend } = await import('resend');
      // const resend = new Resend(process.env.RESEND_API_KEY);
      // await resend.emails.send({
      //   from: 'NodeStacker <digest@nodestacker.com>',
      //   to: founder.email,
      //   subject: `NodeStacker: ${items.length} items need attention`,
      //   text: emailBody,
      // });

      digestsSent++;
    }
  }

  // Admin digest
  const escalated = await db.query.introRequests.findMany({
    where: and(
      eq(schema.introRequests.status, 'intro_request_sent'),
      isNull(schema.introRequests.dateNodeAsked),
      lt(schema.introRequests.dateRequested, fiveDaysAgo)
    ),
    with: { founder: true, node: true, investor: true },
  });

  if (escalated.length > 0) {
    console.log(`\n🚨 ADMIN ESCALATIONS (${escalated.length})`);
    console.log('-'.repeat(40));
    escalated.forEach(intro => {
      console.log(`  • ${intro.founder.name} → ${intro.node.name} → ${intro.investor.name} (requested ${intro.dateRequested})`);
    });
  }

  console.log(`\n✅ Done. Sent ${digestsSent} founder digests.\n`);

  sqlite.close();
}

main().catch(console.error);
