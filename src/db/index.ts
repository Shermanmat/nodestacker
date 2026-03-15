import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { eq, and } from 'drizzle-orm';
import * as schema from './schema.js';

const dbPath = process.env.DATABASE_PATH || 'nodestacker.db';

// Ensure directory exists
const dir = dirname(dbPath);
if (dir && dir !== '.' && !existsSync(dir)) {
  mkdirSync(dir, { recursive: true });
}

const sqlite = new Database(dbPath);
export const db = drizzle(sqlite, { schema });

/**
 * Ensure a founder has a relationship with Mat Sherman (default node).
 * Call this after creating a new founder.
 */
export async function ensureDefaultNodeRelationship(founderId: number) {
  const DEFAULT_NODE_NAME = 'Mat Sherman';
  const node = await db.query.nodes.findFirst({
    where: eq(schema.nodes.name, DEFAULT_NODE_NAME),
  });
  if (!node) return;

  const existing = await db.query.founderNodeRelationships.findFirst({
    where: and(
      eq(schema.founderNodeRelationships.founderId, founderId),
      eq(schema.founderNodeRelationships.nodeId, node.id),
    ),
  });
  if (existing) return;

  await db.insert(schema.founderNodeRelationships).values({
    founderId,
    nodeId: node.id,
    relationshipStrength: 'medium',
    howConnected: 'default',
    createdAt: new Date().toISOString(),
  });
}

export * from './schema.js';
