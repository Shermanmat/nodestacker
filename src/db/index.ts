import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import * as schema from './schema.js';

const dbPath = process.env.DATABASE_PATH || 'nodestacker.db';

// Ensure directory exists
const dir = dirname(dbPath);
if (dir && dir !== '.' && !existsSync(dir)) {
  mkdirSync(dir, { recursive: true });
}

const sqlite = new Database(dbPath);
export const db = drizzle(sqlite, { schema });

export * from './schema.js';
