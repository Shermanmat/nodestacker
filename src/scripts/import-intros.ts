import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq, and } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { parse } from 'csv-parse/sync';
import { readFileSync } from 'fs';

const sqlite = new Database('nodestacker.db');
const db = drizzle(sqlite, { schema });

// Status mapping
const statusMap: Record<string, string> = {
  'Intro Request Sent': 'intro_request_sent',
  'Passed': 'passed',
  'Introduced': 'introduced',
  'Had me intro their partner': 'introduced',
  'Invested': 'invested',
  'Asking a partner/advisor': 'follow_up_questions',
  'Follow Up Questions': 'follow_up_questions',
  'Ignored': 'ignored',
  '': 'intro_request_sent',
};

// Parse date like "4/3/2025 5:30pm"
function parseDate(dateStr: string): string {
  if (!dateStr) return new Date().toISOString().split('T')[0];
  const match = dateStr.match(/(\d+)\/(\d+)\/(\d+)/);
  if (match) {
    const [, month, day, year] = match;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }
  return new Date().toISOString().split('T')[0];
}

// Clean name (remove extra spaces)
function cleanName(name: string): string {
  return name.replace(/\s+/g, ' ').trim();
}

// Track outcomes per node-investor pair for strength calculation
const outcomeTracker = new Map<string, { introduced: number; invested: number; total: number }>();

async function findOrCreateFounder(name: string): Promise<number> {
  name = cleanName(name);
  const existing = await db.query.founders.findFirst({
    where: eq(schema.founders.name, name),
  });
  if (existing) return existing.id;

  const now = new Date().toISOString();
  const result = await db.insert(schema.founders).values({
    name,
    email: `${name.toLowerCase().replace(/\s+/g, '.')}@placeholder.com`,
    companyName: 'TBD',
    companyStage: 'seed',
    roundStatus: 'pre_round',
    createdAt: now,
  }).returning();
  console.log(`  Created founder: ${name}`);
  return result[0].id;
}

async function findOrCreateNode(name: string): Promise<number> {
  name = cleanName(name);
  if (!name) return 2; // Default to Mat Sherman (ID 2)

  const existing = await db.query.nodes.findFirst({
    where: eq(schema.nodes.name, name),
  });
  if (existing) return existing.id;

  const now = new Date().toISOString();
  const result = await db.insert(schema.nodes).values({
    name,
    email: `${name.toLowerCase().replace(/\s+/g, '.')}@placeholder.com`,
    createdAt: now,
  }).returning();
  console.log(`  Created node: ${name}`);
  return result[0].id;
}

async function findOrCreateInvestor(name: string, firm: string): Promise<number> {
  name = cleanName(name);
  firm = cleanName(firm);

  // Try exact match first
  const exact = await db.query.investors.findFirst({
    where: and(
      eq(schema.investors.name, name),
      eq(schema.investors.firm, firm)
    ),
  });
  if (exact) return exact.id;

  // Try name only
  const byName = await db.query.investors.findFirst({
    where: eq(schema.investors.name, name),
  });
  if (byName) return byName.id;

  // Create new investor
  const now = new Date().toISOString();
  const result = await db.insert(schema.investors).values({
    name,
    firm,
    createdAt: now,
  }).returning();
  console.log(`  Created investor: ${name} @ ${firm}`);
  return result[0].id;
}

async function ensureFounderNodeRelationship(founderId: number, nodeId: number): Promise<void> {
  const existing = await db.query.founderNodeRelationships.findFirst({
    where: and(
      eq(schema.founderNodeRelationships.founderId, founderId),
      eq(schema.founderNodeRelationships.nodeId, nodeId)
    ),
  });
  if (!existing) {
    const now = new Date().toISOString();
    await db.insert(schema.founderNodeRelationships).values({
      founderId,
      nodeId,
      relationshipStrength: 'medium',
      createdAt: now,
    });
  }
}

async function ensureNodeInvestorConnection(nodeId: number, investorId: number): Promise<void> {
  const existing = await db.query.nodeInvestorConnections.findFirst({
    where: and(
      eq(schema.nodeInvestorConnections.nodeId, nodeId),
      eq(schema.nodeInvestorConnections.investorId, investorId)
    ),
  });
  if (!existing) {
    const now = new Date().toISOString();
    await db.insert(schema.nodeInvestorConnections).values({
      nodeId,
      investorId,
      connectionStrength: 'medium',
      addedBy: 'platform',
      validated: true,
      createdAt: now,
    });
  }
}

async function main() {
  console.log('Starting import from CSV...\n');

  // Read and parse CSV
  const csvPath = '/Users/matsherman/Downloads/intro-import.csv';
  const csvContent = readFileSync(csvPath, 'utf-8');

  const records = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
    relax_column_count: true,
  });

  console.log(`Found ${records.length} records to import\n`);

  let imported = 0;
  let skipped = 0;

  for (const record of records) {
    const founderName = record['Founder']?.trim();
    const investorName = record['Investor']?.trim();
    const firmName = record['Firm']?.trim();
    const statusRaw = record['Intro Status']?.trim();
    const passReason = record['Pass Reason']?.trim();
    const dateStr = record['Created']?.trim();
    const nodeName = record['Node']?.trim();

    // Skip rows with multiple investors (comma-separated) - handle separately
    if (investorName?.includes(',') || !founderName || !investorName) {
      // Handle multi-investor rows
      if (investorName?.includes(',')) {
        const investors = investorName.split(',');
        const firms = firmName?.split(',') || [];
        const nodes = nodeName?.split(',') || [];

        for (let i = 0; i < investors.length; i++) {
          const inv = investors[i]?.trim();
          const firm = firms[i]?.trim() || firms[0]?.trim() || 'Unknown';
          const node = nodes[i]?.trim() || nodes[0]?.trim() || 'Mat Sherman';

          if (!inv) continue;

          try {
            const status = statusMap[statusRaw] || 'intro_request_sent';
            const dateRequested = parseDate(dateStr);

            const founderId = await findOrCreateFounder(founderName);
            const investorId = await findOrCreateInvestor(inv, firm);
            const nodeId = await findOrCreateNode(node);

            await ensureFounderNodeRelationship(founderId, nodeId);
            await ensureNodeInvestorConnection(nodeId, investorId);

            // Track outcomes
            const key = `${nodeId}-${investorId}`;
            if (!outcomeTracker.has(key)) {
              outcomeTracker.set(key, { introduced: 0, invested: 0, total: 0 });
            }
            const tracker = outcomeTracker.get(key)!;
            tracker.total++;
            if (status === 'introduced' || status === 'invested' || status === 'follow_up_questions') {
              tracker.introduced++;
            }
            if (status === 'invested') {
              tracker.invested++;
            }

            const now = new Date().toISOString();
            await db.insert(schema.introRequests).values({
              founderId,
              nodeId,
              investorId,
              status,
              dateRequested,
              passReason: passReason || null,
              createdAt: now,
              updatedAt: now,
            });

            imported++;
          } catch (err) {
            console.log(`  Error processing multi: ${founderName} -> ${inv}: ${err}`);
            skipped++;
          }
        }
        continue;
      }

      skipped++;
      continue;
    }

    const status = statusMap[statusRaw] || 'intro_request_sent';
    const dateRequested = parseDate(dateStr);

    try {
      const founderId = await findOrCreateFounder(founderName);
      const investorId = await findOrCreateInvestor(investorName, firmName || 'Unknown');
      const nodeId = await findOrCreateNode(nodeName || 'Mat Sherman');

      await ensureFounderNodeRelationship(founderId, nodeId);
      await ensureNodeInvestorConnection(nodeId, investorId);

      // Track outcomes for strength calculation
      const key = `${nodeId}-${investorId}`;
      if (!outcomeTracker.has(key)) {
        outcomeTracker.set(key, { introduced: 0, invested: 0, total: 0 });
      }
      const tracker = outcomeTracker.get(key)!;
      tracker.total++;
      if (status === 'introduced' || status === 'invested' || status === 'follow_up_questions') {
        tracker.introduced++;
      }
      if (status === 'invested') {
        tracker.invested++;
      }

      // Create intro request
      const now = new Date().toISOString();
      await db.insert(schema.introRequests).values({
        founderId,
        nodeId,
        investorId,
        status,
        dateRequested,
        passReason: passReason || null,
        createdAt: now,
        updatedAt: now,
      });

      imported++;
      if (imported % 100 === 0) {
        console.log(`  Imported ${imported} records...`);
      }
    } catch (err) {
      console.log(`  Error processing: ${founderName} -> ${investorName}: ${err}`);
      skipped++;
    }
  }

  // Update node-investor connection strengths based on outcomes
  console.log('\nUpdating relationship strengths...');
  for (const [key, tracker] of outcomeTracker) {
    const [nodeId, investorId] = key.split('-').map(Number);
    let strength = 'weak';

    if (tracker.invested > 0 || tracker.introduced >= 3) {
      strength = 'strong';
    } else if (tracker.introduced >= 1 || tracker.total >= 2) {
      strength = 'medium';
    }

    await db.update(schema.nodeInvestorConnections)
      .set({ connectionStrength: strength })
      .where(and(
        eq(schema.nodeInvestorConnections.nodeId, nodeId),
        eq(schema.nodeInvestorConnections.investorId, investorId)
      ));
  }

  console.log(`\n✅ Import complete!`);
  console.log(`   Imported: ${imported}`);
  console.log(`   Skipped: ${skipped}`);
  console.log(`   Relationship strengths updated: ${outcomeTracker.size}`);

  sqlite.close();
}

main().catch(console.error);
