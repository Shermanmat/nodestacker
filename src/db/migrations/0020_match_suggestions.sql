-- Investor category exclusions (sectors they do NOT want)
CREATE TABLE `investor_category_exclusions` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `investor_id` integer NOT NULL REFERENCES `investors`(`id`),
  `category_id` integer NOT NULL REFERENCES `investor_categories`(`id`) ON DELETE CASCADE,
  CONSTRAINT `investor_category_exclusions_unique` UNIQUE(`investor_id`, `category_id`)
);
--> statement-breakpoint
-- Persona hotness tiers (configurable ranking)
CREATE TABLE `persona_hotness_tiers` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `persona` text NOT NULL,
  `tier` integer NOT NULL,
  `label` text,
  `updated_at` text NOT NULL DEFAULT 'CURRENT_TIMESTAMP',
  CONSTRAINT `persona_hotness_tiers_persona_unique` UNIQUE(`persona`)
);
--> statement-breakpoint
-- Match suggestions for admin review
CREATE TABLE `match_suggestions` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `founder_id` integer NOT NULL REFERENCES `founders`(`id`),
  `node_id` integer NOT NULL REFERENCES `nodes`(`id`),
  `investor_id` integer NOT NULL REFERENCES `investors`(`id`),
  `founder_heat_score` integer NOT NULL,
  `investor_reliability_score` integer NOT NULL,
  `match_score` integer NOT NULL,
  `match_reasoning` text,
  `status` text NOT NULL DEFAULT 'pending',
  `reviewed_at` text,
  `rejection_reason` text,
  `intro_request_id` integer REFERENCES `intro_requests`(`id`),
  `batch_id` text,
  `created_at` text NOT NULL DEFAULT 'CURRENT_TIMESTAMP'
);
--> statement-breakpoint
-- Seed default persona hotness tiers
INSERT INTO `persona_hotness_tiers` (`persona`, `tier`, `label`, `updated_at`) VALUES
  ('high_slope_builder', 7, 'Tier 1 - Hottest', CURRENT_TIMESTAMP),
  ('experienced_operator', 6, 'Tier 2', CURRENT_TIMESTAMP),
  ('large_company_spinout', 5, 'Tier 3', CURRENT_TIMESTAMP),
  ('business_oriented_coder', 4, 'Tier 4', CURRENT_TIMESTAMP),
  ('startup_insider_first_time', 3, 'Tier 5', CURRENT_TIMESTAMP),
  ('domain_expert', 2, 'Tier 6', CURRENT_TIMESTAMP),
  ('scrappy_bootstrapped', 1, 'Tier 7 - Coldest', CURRENT_TIMESTAMP);
--> statement-breakpoint
-- Seed "Generalist" as a sector category
INSERT OR IGNORE INTO `investor_categories` (`name`, `type`, `color`, `created_at`) VALUES
  ('Generalist', 'sector', 'gray', CURRENT_TIMESTAMP);
