import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { createHash } from 'crypto';

const db = new Database('nodestacker.db');

// 1. Mark 0015 as already applied (columns exist but weren't tracked)
const sql0015 = readFileSync('./src/db/migrations/0015_investor_followup.sql', 'utf-8');
const hash0015 = createHash('sha256').update(sql0015).digest('hex');

const existing = db.prepare('SELECT * FROM __drizzle_migrations WHERE hash = ?').get(hash0015);
if (!existing) {
  db.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)').run(hash0015, 1773100000000);
  console.log('Marked 0015 as applied');
} else {
  console.log('0015 already tracked');
}

// 2. Apply 0016 migration manually
const sql0016 = readFileSync('./src/db/migrations/0016_categories.sql', 'utf-8');
const hash0016 = createHash('sha256').update(sql0016).digest('hex');

const existing0016 = db.prepare('SELECT * FROM __drizzle_migrations WHERE hash = ?').get(hash0016);
if (!existing0016) {
  const statements = sql0016.split('--> statement-breakpoint');
  for (const stmt of statements) {
    const lines = stmt.split('\n');
    const cleanLines = lines.filter(l => {
      const trimmed = l.trim();
      return trimmed.length > 0 && !trimmed.startsWith('--');
    });
    const cleanStmt = cleanLines.join('\n').trim();
    if (cleanStmt) {
      console.log('Executing:', cleanStmt.substring(0, 80) + '...');
      db.prepare(cleanStmt).run();
    }
  }

  db.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)').run(hash0016, 1773200000000);
  console.log('Applied and tracked 0016');
} else {
  console.log('0016 already applied');
}

// Verify
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%categor%'").all();
console.log('Category tables:', tables);

const founderCols = db.prepare("PRAGMA table_info('founders')").all() as { name: string }[];
const cadenceCols = founderCols.filter(c => c.name.includes('cadence') || c.name.includes('intro_target'));
console.log('New founder columns:', cadenceCols.map(c => c.name));

db.close();
console.log('Done!');
