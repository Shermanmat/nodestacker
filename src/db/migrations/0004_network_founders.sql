-- Network Founders table (podcast guests who are founders)
CREATE TABLE IF NOT EXISTS `network_founders` (
  `id` integer PRIMARY KEY AUTOINCREMENT,
  `name` text NOT NULL,
  `company_name` text NOT NULL,
  `email` text,
  `linkedin_url` text,
  `episode_title` text NOT NULL,
  `episode_url` text,
  `episode_date` text,
  `created_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_network_founders_name` ON `network_founders` (`name`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_network_founders_company` ON `network_founders` (`company_name`);
--> statement-breakpoint
-- Network Founder Research table (AI research results)
CREATE TABLE IF NOT EXISTS `network_founder_research` (
  `id` integer PRIMARY KEY AUTOINCREMENT,
  `network_founder_id` integer NOT NULL REFERENCES `network_founders`(`id`),
  `company_description` text,
  `industry` text,
  `company_stage` text,
  `employee_count` text,
  `target_customers` text,
  `recent_news` text,
  `source_urls` text,
  `status` text NOT NULL DEFAULT 'pending',
  `error_message` text,
  `researched_at` text,
  `created_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_network_founder_research_founder` ON `network_founder_research` (`network_founder_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_network_founder_research_status` ON `network_founder_research` (`status`);
--> statement-breakpoint
-- Network Intro Requests table (portfolio founder requests)
CREATE TABLE IF NOT EXISTS `network_intro_requests` (
  `id` integer PRIMARY KEY AUTOINCREMENT,
  `portfolio_company_id` integer NOT NULL REFERENCES `portfolio_companies`(`id`),
  `request_text` text NOT NULL,
  `status` text NOT NULL DEFAULT 'pending',
  `created_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_network_intro_requests_portfolio` ON `network_intro_requests` (`portfolio_company_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_network_intro_requests_status` ON `network_intro_requests` (`status`);
--> statement-breakpoint
-- Network Matches table (AI-suggested matches)
CREATE TABLE IF NOT EXISTS `network_matches` (
  `id` integer PRIMARY KEY AUTOINCREMENT,
  `intro_request_id` integer NOT NULL REFERENCES `network_intro_requests`(`id`),
  `network_founder_id` integer NOT NULL REFERENCES `network_founders`(`id`),
  `match_score` integer NOT NULL,
  `match_reasoning` text,
  `status` text NOT NULL DEFAULT 'suggested',
  `notes` text,
  `created_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_network_matches_request` ON `network_matches` (`intro_request_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_network_matches_founder` ON `network_matches` (`network_founder_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_network_matches_status` ON `network_matches` (`status`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_network_matches_unique` ON `network_matches` (`intro_request_id`, `network_founder_id`);
