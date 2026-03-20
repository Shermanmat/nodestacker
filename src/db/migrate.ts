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

// Safely add columns that may already exist (from partial migration runs)
const safeAddColumn = (table: string, column: string, type: string, extra = '') => {
  try {
    sqlite.exec(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${type} ${extra}`);
    console.log(`  Added column ${table}.${column}`);
  } catch (e: any) {
    if (e.message?.includes('duplicate column')) {
      // Column already exists, skip
    } else {
      throw e;
    }
  }
};

console.log('Ensuring schema columns exist...');
// public_users columns (migrations 0026, 0027)
safeAddColumn('public_users', 'role', 'text');
safeAddColumn('public_users', 'role_other', 'text');
safeAddColumn('public_users', 'status', "text NOT NULL DEFAULT 'pending'");
safeAddColumn('public_users', 'node_contacts', 'text');
// onboarding_workflows columns (migration 0028)
safeAddColumn('onboarding_workflows', 'founder_title', 'text');
safeAddColumn('onboarding_workflows', 'equity_founder_signed_at', 'text');
safeAddColumn('onboarding_workflows', 'equity_admin_signed_at', 'text');
safeAddColumn('onboarding_workflows', 'wire_info_url', 'text');
// public_companies columns (migration 0029)
safeAddColumn('public_companies', 'application_status', 'text');
safeAddColumn('public_companies', 'applied_at', 'text');
// onboarding_workflows incorporation columns (migration 0030)
safeAddColumn('onboarding_workflows', 'incorporated', 'integer');
safeAddColumn('onboarding_workflows', 'incorporation_partner', 'text');
safeAddColumn('onboarding_workflows', 'approved_for_law_firm', 'integer DEFAULT false');
safeAddColumn('onboarding_workflows', 'equity_commitment_signed_at', 'text');
safeAddColumn('onboarding_workflows', 'last_incorporation_nudge_at', 'text');
// onboarding_workflows entity verification columns (migration 0031)
safeAddColumn('onboarding_workflows', 'ein', 'text');
safeAddColumn('onboarding_workflows', 'articles_of_incorporation_url', 'text');

// voice_interviews + voice_interview_answers tables (migration 0032)
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS \`voice_interviews\` (
    \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    \`public_company_id\` integer NOT NULL REFERENCES \`public_companies\`(\`id\`),
    \`token\` text NOT NULL,
    \`status\` text NOT NULL DEFAULT 'researching',
    \`research\` text,
    \`questions\` text,
    \`sent_at\` text,
    \`completed_at\` text,
    \`expires_at\` text,
    \`created_at\` text NOT NULL DEFAULT (CURRENT_TIMESTAMP)
  )`);
  sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS \`voice_interviews_token_unique\` ON \`voice_interviews\` (\`token\`)`);
  sqlite.exec(`CREATE TABLE IF NOT EXISTS \`voice_interview_answers\` (
    \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    \`interview_id\` integer NOT NULL REFERENCES \`voice_interviews\`(\`id\`),
    \`question_index\` integer NOT NULL,
    \`audio_url\` text NOT NULL,
    \`duration_seconds\` integer,
    \`created_at\` text NOT NULL DEFAULT (CURRENT_TIMESTAMP)
  )`);
  console.log('  Ensured voice_interviews tables exist');
} catch (e: any) {
  if (!e.message?.includes('already exists')) throw e;
}

// investor pause columns
safeAddColumn('investors', 'paused_until', 'text');
safeAddColumn('investors', 'pause_reason', 'text');
// intro request date tracking
safeAddColumn('intro_requests', 'date_passed', 'text');
// blurb builder columns
safeAddColumn('founder_leads', 'source', "text DEFAULT 'onboarding_chat'");
safeAddColumn('founder_leads', 'signal_categories', 'text');

console.log(`Running migrations from ${migrationsFolder}...`);
migrate(db, { migrationsFolder });
console.log('Migrations complete!');

sqlite.close();
