import type { Database } from 'better-sqlite3';

export function up(db: Database) {
  db.exec(`
    ALTER TABLE founder_leads ADD COLUMN source TEXT DEFAULT 'onboarding_chat';
  `);
  db.exec(`
    ALTER TABLE founder_leads ADD COLUMN signal_categories TEXT;
  `);
}

export function down(db: Database) {
  // SQLite doesn't support DROP COLUMN easily
}
