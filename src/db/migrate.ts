import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const dbPath = process.env.DATABASE_PATH || 'nodestacker.db';

// Ensure directory exists
const dir = dirname(dbPath);
if (dir && dir !== '.' && !existsSync(dir)) {
  mkdirSync(dir, { recursive: true });
}

const sqlite = new Database(dbPath);
const db = drizzle(sqlite);

// Determine migrations folder based on environment
const migrationsFolder = process.env.NODE_ENV === 'production'
  ? './dist/db/migrations'
  : './src/db/migrations';

console.log(`Running migrations from ${migrationsFolder}...`);
migrate(db, { migrationsFolder });
console.log('Migrations complete!');

sqlite.close();
