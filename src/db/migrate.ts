import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { inferState } from '../services/us-states.js';

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

// intro request terms (migration 0033)
safeAddColumn('onboarding_workflows', 'intro_requests_per_week', 'integer DEFAULT 3');
safeAddColumn('onboarding_workflows', 'intro_requests_revisit_date', 'text');

// investor pause columns
safeAddColumn('investors', 'paused_until', 'text');
safeAddColumn('investors', 'pause_reason', 'text');
// investor email — used for Gmail draft To: field
safeAddColumn('investors', 'email', 'text');
// Free-form admin notes (non-categorical quirks)
safeAddColumn('investors', 'notes', 'text');
// 2-char US state code, used for the admin /investors state filter.
// Backfilled below from `city` using the us-states city→state map.
safeAddColumn('investors', 'state', 'text');
// One-time backfill: pull emails from instantly_leads where they're linked
try {
  sqlite.exec(`UPDATE investors SET email = (
    SELECT investor_email FROM instantly_leads
    WHERE instantly_leads.investor_id = investors.id
      AND instantly_leads.investor_email IS NOT NULL
      AND instantly_leads.investor_email != ''
    LIMIT 1
  ) WHERE email IS NULL OR email = ''`);
} catch (_) { /* ok if instantly_leads doesn't exist or no rows match */ }

// One-time backfill of investors.state from investors.city using the
// us-states map. Only fills rows where state IS NULL (or empty), so admin
// overrides are never clobbered. Cities not in the map stay NULL — admin
// fills those manually later.
try {
  const rows = sqlite.prepare<unknown[], { id: number; city: string }>(
    `SELECT id, city FROM investors WHERE (state IS NULL OR state = '') AND city IS NOT NULL AND city != ''`
  ).all() as Array<{ id: number; city: string }>;
  const upd = sqlite.prepare('UPDATE investors SET state = ? WHERE id = ?');
  let n = 0;
  for (const r of rows) {
    const inferred = inferState(r.city);
    if (inferred) { upd.run(inferred, r.id); n++; }
  }
  if (n > 0) console.log(`  Backfilled investors.state for ${n} rows from city`);
} catch (e: any) {
  if (!e.message?.includes('no such column')) throw e;
}
// intro request date tracking
safeAddColumn('intro_requests', 'date_passed', 'text');
// Auto-draft agent: track Gmail draft id created for a pending suggestion.
// Status stays pending_suggestion until user marks it sent.
safeAddColumn('intro_requests', 'gmail_draft_id', 'text');
safeAddColumn('intro_requests', 'gmail_draft_created_at', 'text');
// Follow-up agent (Phase 1) — track thread id + reply detection + bump count
safeAddColumn('intro_requests', 'gmail_thread_id', 'text');
safeAddColumn('intro_requests', 'reply_detected_at', 'text');
safeAddColumn('intro_requests', 'followup_count', 'integer NOT NULL DEFAULT 0');
safeAddColumn('intro_requests', 'last_followup_at', 'text');
// Reply classifier columns
safeAddColumn('intro_requests', 'reply_classification', 'text');
safeAddColumn('intro_requests', 'reply_classification_at', 'text');
safeAddColumn('intro_requests', 'reply_classification_confidence', 'text');
safeAddColumn('intro_requests', 'reply_body_snippet', 'text');
safeAddColumn('intro_requests', 'intro_handoff_draft_id', 'text');
safeAddColumn('intro_requests', 'intro_handoff_draft_created_at', 'text');
// Phase 2 — auto-send tracking
safeAddColumn('intro_requests', 'intro_handoff_sent_at', 'text');
safeAddColumn('intro_requests', 'intro_handoff_auto_sent', 'integer NOT NULL DEFAULT 0');
safeAddColumn('intro_requests', 'intro_handoff_message_id', 'text');
// blurb builder columns
safeAddColumn('founder_leads', 'source', "text DEFAULT 'onboarding_chat'");
safeAddColumn('founder_leads', 'signal_categories', 'text');

// instantly_campaigns + instantly_leads tables (migration 0034)
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS \`instantly_campaigns\` (
    \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    \`instantly_campaign_id\` text NOT NULL,
    \`name\` text NOT NULL,
    \`status\` text NOT NULL DEFAULT 'draft',
    \`account_email\` text,
    \`leads_count\` integer NOT NULL DEFAULT 0,
    \`replied_count\` integer NOT NULL DEFAULT 0,
    \`positive_count\` integer NOT NULL DEFAULT 0,
    \`last_synced_at\` text,
    \`created_at\` text NOT NULL DEFAULT (CURRENT_TIMESTAMP)
  )`);
  sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS \`instantly_campaigns_instantly_campaign_id_unique\` ON \`instantly_campaigns\` (\`instantly_campaign_id\`)`);
  sqlite.exec(`CREATE TABLE IF NOT EXISTS \`instantly_leads\` (
    \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    \`instantly_campaign_id\` text NOT NULL,
    \`investor_name\` text NOT NULL,
    \`investor_firm\` text,
    \`investor_email\` text NOT NULL,
    \`lead_status\` text NOT NULL DEFAULT 'pending',
    \`reply_text\` text,
    \`investor_id\` integer REFERENCES \`investors\`(\`id\`),
    \`processed\` integer NOT NULL DEFAULT 0,
    \`processed_at\` text,
    \`created_at\` text NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    \`updated_at\` text NOT NULL DEFAULT (CURRENT_TIMESTAMP)
  )`);
  sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS \`instantly_leads_email_campaign_unique\` ON \`instantly_leads\` (\`investor_email\`, \`instantly_campaign_id\`)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS \`idx_instantly_leads_status\` ON \`instantly_leads\` (\`lead_status\`)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS \`idx_instantly_leads_campaign\` ON \`instantly_leads\` (\`instantly_campaign_id\`)`);
  console.log('  Ensured instantly_campaigns + instantly_leads tables exist');
} catch (e: any) {
  if (!e.message?.includes('already exists')) throw e;
}

// node VIP flag (migration 0035) — VIP nodes only get intro suggestions
// for founders who are doing well with the primary (Mat Sherman) network
safeAddColumn('nodes', 'vip', 'integer NOT NULL DEFAULT 1');

// Founder intro draft fields — blurb is the body of the intro email,
// deck/calendly links are appended to drafts when present.
safeAddColumn('founders', 'blurb', 'text');
safeAddColumn('founders', 'deck_url', 'text');
safeAddColumn('founders', 'deck_file', 'text');
safeAddColumn('founders', 'calendly_url', 'text');
// Soft preference flag: matching algo gives angels a score bonus when true.
safeAddColumn('founders', 'prefer_angels_only', 'integer DEFAULT 0');

// Founder-side CRM fields on intro_requests — kept separate from admin
// `notes` so the two surfaces don't fight over the same column.
safeAddColumn('intro_requests', 'founder_next_action_text', 'text');
safeAddColumn('intro_requests', 'founder_next_action_date', 'text');
safeAddColumn('intro_requests', 'founder_check_size', 'text');
safeAddColumn('intro_requests', 'founder_owned_notes', 'text');

// Founder CRM tables — private to each founder, no admin endpoint reads them.
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS \`founder_investor_records\` (
    \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    \`founder_id\` integer NOT NULL REFERENCES \`founders\`(\`id\`),
    \`name\` text NOT NULL,
    \`firm\` text,
    \`role\` text,
    \`email\` text,
    \`geography\` text,
    \`source\` text NOT NULL DEFAULT 'self_added',
    \`status\` text NOT NULL DEFAULT 'self_outreach',
    \`next_action_text\` text,
    \`next_action_date\` text,
    \`check_size\` text,
    \`notes\` text,
    \`created_at\` text NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    \`updated_at\` text NOT NULL DEFAULT (CURRENT_TIMESTAMP)
  )`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS \`idx_fir_founder\` ON \`founder_investor_records\` (\`founder_id\`)`);
  sqlite.exec(`CREATE TABLE IF NOT EXISTS \`investor_interactions\` (
    \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    \`founder_id\` integer NOT NULL REFERENCES \`founders\`(\`id\`),
    \`investor_id\` integer REFERENCES \`investors\`(\`id\`),
    \`founder_investor_record_id\` integer REFERENCES \`founder_investor_records\`(\`id\`),
    \`interaction_type\` text NOT NULL,
    \`occurred_at\` text NOT NULL,
    \`content\` text,
    \`created_by\` text NOT NULL DEFAULT 'founder',
    \`created_at\` text NOT NULL DEFAULT (CURRENT_TIMESTAMP)
  )`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS \`idx_ii_founder\` ON \`investor_interactions\` (\`founder_id\`)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS \`idx_ii_investor\` ON \`investor_interactions\` (\`investor_id\`)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS \`idx_ii_record\` ON \`investor_interactions\` (\`founder_investor_record_id\`)`);
  console.log('  Ensured founder_investor_records + investor_interactions tables exist');
} catch (e: any) {
  if (!e.message?.includes('already exists')) throw e;
}

// People captures — universal lead-magnet capture table. Public POST endpoint
// at /api/people-captures writes here. De-duped on (email, source).
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS \`people_captures\` (
    \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    \`email\` text NOT NULL,
    \`name\` text,
    \`city\` text,
    \`source\` text NOT NULL,
    \`metadata\` text,
    \`captured_at\` text NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    \`auto_emailed_at\` text
  )`);
  sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS \`people_captures_email_source_unique\` ON \`people_captures\` (\`email\`, \`source\`)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS \`idx_people_captures_email\` ON \`people_captures\` (\`email\`)`);
  console.log('  Ensured people_captures table exists');
} catch (e: any) {
  if (!e.message?.includes('already exists')) throw e;
}

// People tags — admin segmentation tags by email.
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS \`people_tags\` (
    \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    \`email\` text NOT NULL,
    \`tag\` text NOT NULL,
    \`created_at\` text NOT NULL DEFAULT (CURRENT_TIMESTAMP)
  )`);
  sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS \`people_tags_email_tag_unique\` ON \`people_tags\` (\`email\`, \`tag\`)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS \`idx_people_tags_email\` ON \`people_tags\` (\`email\`)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS \`idx_people_tags_tag\` ON \`people_tags\` (\`tag\`)`);
  console.log('  Ensured people_tags table exists');
} catch (e: any) {
  if (!e.message?.includes('already exists')) throw e;
}

// Trials — 2-week no-equity audition stage (start → offer/pass → accept/decline)
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS \`trials\` (
    \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    \`founder_id\` integer NOT NULL REFERENCES \`founders\`(\`id\`),
    \`status\` text NOT NULL DEFAULT 'active',
    \`start_date\` text NOT NULL,
    \`end_date\` text NOT NULL,
    \`intro_target_min\` integer NOT NULL DEFAULT 5,
    \`intro_target_max\` integer NOT NULL DEFAULT 15,
    \`offer_equity_percent\` text NOT NULL DEFAULT '1',
    \`decision\` text,
    \`decision_at\` text,
    \`decision_notes\` text,
    \`founder_response\` text,
    \`founder_responded_at\` text,
    \`access_revokes_at\` text,
    \`score_founder_activity\` integer,
    \`score_comms_quality\` integer,
    \`score_mindset\` integer,
    \`score_investor_sentiment\` integer,
    \`score_follow_through\` integer,
    \`created_at\` text NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    \`updated_at\` text NOT NULL DEFAULT (CURRENT_TIMESTAMP)
  )`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS \`idx_trials_founder\` ON \`trials\` (\`founder_id\`)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS \`idx_trials_status\` ON \`trials\` (\`status\`)`);
  console.log('  Ensured trials table exists');
} catch (e: any) {
  if (!e.message?.includes('already exists')) throw e;
}

// People overrides — admin-edited values that layer on top of merged source data.
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS \`people_overrides\` (
    \`email\` text PRIMARY KEY NOT NULL,
    \`name\` text,
    \`city\` text,
    \`company\` text,
    \`notes\` text,
    \`updated_at\` text NOT NULL DEFAULT (CURRENT_TIMESTAMP)
  )`);
  console.log('  Ensured people_overrides table exists');
} catch (e: any) {
  if (!e.message?.includes('already exists')) throw e;
}

// Mat Sherman's network (id=2) is not VIP — always available for intros
try {
  sqlite.exec(`UPDATE nodes SET vip = 0 WHERE id = 2`);
} catch (_) { /* no-op if nodes table doesn't exist yet */ }

// Soft-delete column for founder-private records (archive via portal/MCP).
safeAddColumn('founder_investor_records', 'archived_at', 'text');
// Warm-intro connector on founder CRM records (who connected them).
safeAddColumn('founder_investor_records', 'warm_intro_connector', 'text');

// MCP access tokens — founder-scoped tokens for connecting an AI client.
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS \`mcp_tokens\` (
    \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    \`founder_id\` integer NOT NULL REFERENCES \`founders\`(\`id\`),
    \`token_hash\` text NOT NULL,
    \`token_prefix\` text NOT NULL,
    \`name\` text,
    \`created_at\` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`expires_at\` text,
    \`revoked_at\` text,
    \`last_used_at\` text
  )`);
  sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS \`mcp_tokens_token_hash_unique\` ON \`mcp_tokens\` (\`token_hash\`)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS \`idx_mcp_tokens_founder\` ON \`mcp_tokens\` (\`founder_id\`)`);
  console.log('  Ensured mcp_tokens table exists');
} catch (e: any) {
  if (!e.message?.includes('already exists')) throw e;
}

// Agent actions ledger — accountability log + approval gate for the AI worker.
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS \`agent_actions\` (
    \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    \`agent\` text NOT NULL,
    \`action_type\` text NOT NULL,
    \`summary\` text NOT NULL,
    \`reasoning\` text,
    \`entity_type\` text,
    \`entity_id\` integer,
    \`payload\` text,
    \`status\` text NOT NULL DEFAULT 'logged',
    \`dry_run\` integer NOT NULL DEFAULT 0,
    \`result\` text,
    \`decided_by\` text,
    \`created_at\` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`decided_at\` text,
    \`executed_at\` text
  )`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS \`idx_agent_actions_status\` ON \`agent_actions\` (\`status\`)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS \`idx_agent_actions_created\` ON \`agent_actions\` (\`created_at\`)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS \`idx_agent_actions_agent\` ON \`agent_actions\` (\`agent\`)`);
  console.log('  Ensured agent_actions table exists');
} catch (e: any) {
  if (!e.message?.includes('already exists')) throw e;
}

// Drop dormant podcast-network tables (created in 0004, never used in any
// route or UI; verified empty on prod before drop).
try {
  sqlite.exec('DROP TABLE IF EXISTS \`network_matches\`');
  sqlite.exec('DROP TABLE IF EXISTS \`network_intro_requests\`');
  sqlite.exec('DROP TABLE IF EXISTS \`network_founder_research\`');
  sqlite.exec('DROP TABLE IF EXISTS \`network_founders\`');
} catch (_) { /* no-op */ }

// Cron run log — one row per scheduled job invocation.
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS \`cron_runs\` (
    \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    \`name\` text NOT NULL,
    \`started_at\` text NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    \`finished_at\` text,
    \`status\` text NOT NULL DEFAULT 'running',
    \`result\` text,
    \`error\` text
  )`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS \`idx_cron_runs_name_started\` ON \`cron_runs\` (\`name\`, \`started_at\`)`);
  console.log('  Ensured cron_runs table exists');
} catch (e: any) {
  if (!e.message?.includes('already exists')) throw e;
}

// agent_settings — single-row table (id=1) holding kill switches + thresholds.
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS \`agent_settings\` (
    \`id\` integer PRIMARY KEY,
    \`auto_send_handoff\` integer NOT NULL DEFAULT 0,
    \`auto_send_handoff_min_confidence\` text NOT NULL DEFAULT '0.9',
    \`auto_send_handoff_max_reply_chars\` integer NOT NULL DEFAULT 400,
    \`updated_at\` text NOT NULL DEFAULT (CURRENT_TIMESTAMP)
  )`);
  // Seed the singleton row if missing (defaults: auto-send OFF).
  sqlite.exec(`INSERT OR IGNORE INTO \`agent_settings\` (id) VALUES (1)`);
  console.log('  Ensured agent_settings table exists');
} catch (e: any) {
  if (!e.message?.includes('already exists')) throw e;
}
// Auto-reply-to-pass kill switch (agent_settings).
safeAddColumn('agent_settings', 'auto_reply_to_pass', 'integer NOT NULL DEFAULT 0');
safeAddColumn('agent_settings', 'auto_send_followups', 'integer NOT NULL DEFAULT 0');

// Shadow AI application scorer fields + admin decision reason.
safeAddColumn('public_companies', 'ai_score', 'integer');
safeAddColumn('public_companies', 'ai_recommendation', 'text');
safeAddColumn('public_companies', 'ai_reasoning', 'text');
safeAddColumn('public_companies', 'ai_scored_at', 'text');
safeAddColumn('public_companies', 'decision_reason', 'text');

// Founder portal sessions — persisted so logins survive restarts/deploys.
sqlite.exec(`CREATE TABLE IF NOT EXISTS \`founder_sessions\` (
  \`id\` text PRIMARY KEY NOT NULL,
  \`founder_id\` integer NOT NULL,
  \`expires_at\` text NOT NULL,
  \`created_at\` text NOT NULL DEFAULT CURRENT_TIMESTAMP
)`);
console.log('  Ensured founder_sessions table exists');

// Meeting transcripts (Granola ingest) — matched + scored per founder.
sqlite.exec(`CREATE TABLE IF NOT EXISTS \`meeting_transcripts\` (
  \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`founder_id\` integer NOT NULL,
  \`source\` text NOT NULL DEFAULT 'granola',
  \`meeting_title\` text,
  \`transcript\` text NOT NULL,
  \`share_link\` text,
  \`matched_pipeline_id\` text,
  \`matched_investor_name\` text,
  \`match_status\` text NOT NULL DEFAULT 'pending',
  \`match_confidence\` text,
  \`meeting_type\` text,
  \`outcome\` text,
  \`summary\` text,
  \`next_step_text\` text,
  \`next_step_date\` text,
  \`score_comms_quality\` integer,
  \`score_investor_sentiment\` integer,
  \`score_follow_through\` integer,
  \`score_json\` text,
  \`status\` text NOT NULL DEFAULT 'received',
  \`applied_at\` text,
  \`error_message\` text,
  \`created_at\` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  \`processed_at\` text
)`);
console.log('  Ensured meeting_transcripts table exists');

// Founder change-requests for production investor materials (blurb + deck).
sqlite.exec(`CREATE TABLE IF NOT EXISTS \`comms_change_requests\` (
  \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`founder_id\` integer NOT NULL,
  \`kind\` text NOT NULL,
  \`note\` text,
  \`proposed_deck_file\` text,
  \`approve_token\` text,
  \`status\` text NOT NULL DEFAULT 'pending',
  \`created_at\` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  \`resolved_at\` text
)`);
safeAddColumn('comms_change_requests', 'approve_token', 'text');
console.log('  Ensured comms_change_requests table exists');

// Structured reject taxonomy on match_suggestions + one-time backfill from the
// legacy free-text rejection_reason (only fills nulls).
safeAddColumn('match_suggestions', 'rejection_category', 'text');
try {
  const reasonMap = [
    ['%already met%', 'already_met'], ['%already intro%', 'already_met'],
    ['%vip%', 'vip'],
    ['%wrong sector%', 'wrong_sector'], ['%sector%', 'wrong_sector'],
    ['%wrong stage%', 'wrong_stage'], ['%stage%', 'wrong_stage'],
    ['%pre-revenue%', 'too_early'], ['%pre revenue%', 'too_early'], ['%too early%', 'too_early'],
    ['%dropout%', 'thesis_mismatch'], ['%degree%', 'thesis_mismatch'], ['%technical%', 'thesis_mismatch'], ['%immigrant%', 'thesis_mismatch'], ['%thesis%', 'thesis_mismatch'],
    ['%geo%', 'wrong_geo'],
    ['%not a fit%', 'not_a_fit'], ['%not fit%', 'not_a_fit'],
  ];
  for (const [pat, cat] of reasonMap) {
    sqlite.prepare("UPDATE match_suggestions SET rejection_category=? WHERE rejection_category IS NULL AND status='rejected' AND lower(rejection_reason) LIKE ?").run(cat, pat);
  }
  // Any remaining reviewed reject with a reason but no category → 'other'.
  sqlite.prepare("UPDATE match_suggestions SET rejection_category='other' WHERE rejection_category IS NULL AND status='rejected' AND rejection_reason IS NOT NULL AND rejection_reason != ''").run();
  console.log('  Backfilled match_suggestions.rejection_category');
} catch (e: any) { if (!e.message?.includes('no such column')) throw e; }

console.log(`Running migrations from ${migrationsFolder}...`);
migrate(db, { migrationsFolder });
console.log('Migrations complete!');

sqlite.close();
