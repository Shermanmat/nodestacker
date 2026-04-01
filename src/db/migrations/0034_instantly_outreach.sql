CREATE TABLE IF NOT EXISTS `instantly_campaigns` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `instantly_campaign_id` text NOT NULL,
  `name` text NOT NULL,
  `status` text NOT NULL DEFAULT 'draft',
  `account_email` text,
  `leads_count` integer NOT NULL DEFAULT 0,
  `replied_count` integer NOT NULL DEFAULT 0,
  `positive_count` integer NOT NULL DEFAULT 0,
  `last_synced_at` text,
  `created_at` text NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `instantly_campaigns_instantly_campaign_id_unique` ON `instantly_campaigns` (`instantly_campaign_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `instantly_leads` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `instantly_campaign_id` text NOT NULL,
  `investor_name` text NOT NULL,
  `investor_firm` text,
  `investor_email` text NOT NULL,
  `lead_status` text NOT NULL DEFAULT 'pending',
  `reply_text` text,
  `investor_id` integer REFERENCES `investors`(`id`),
  `processed` integer NOT NULL DEFAULT 0,
  `processed_at` text,
  `created_at` text NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  `updated_at` text NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `instantly_leads_email_campaign_unique` ON `instantly_leads` (`investor_email`, `instantly_campaign_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_instantly_leads_status` ON `instantly_leads` (`lead_status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_instantly_leads_campaign` ON `instantly_leads` (`instantly_campaign_id`);
