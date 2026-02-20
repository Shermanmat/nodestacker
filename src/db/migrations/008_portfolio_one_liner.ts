import type { Database } from 'better-sqlite3';

export function up(db: Database) {
  db.exec(`
    ALTER TABLE portfolio_companies ADD COLUMN one_liner TEXT;
  `);
}

export function down(db: Database) {
  // SQLite doesn't support DROP COLUMN easily, so we'd need to recreate the table
  // For simplicity, we'll leave this as a no-op
}
