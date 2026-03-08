-- Category system for investor/founder matching
CREATE TABLE `investor_categories` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `name` text NOT NULL,
  `color` text DEFAULT 'gray',
  `created_at` text NOT NULL DEFAULT 'CURRENT_TIMESTAMP',
  CONSTRAINT `investor_categories_name_unique` UNIQUE(`name`)
);
--> statement-breakpoint
CREATE TABLE `investor_category_assignments` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `investor_id` integer NOT NULL REFERENCES `investors`(`id`),
  `category_id` integer NOT NULL REFERENCES `investor_categories`(`id`) ON DELETE CASCADE,
  CONSTRAINT `investor_category_assignments_unique` UNIQUE(`investor_id`, `category_id`)
);
--> statement-breakpoint
CREATE TABLE `founder_category_assignments` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `founder_id` integer NOT NULL REFERENCES `founders`(`id`),
  `category_id` integer NOT NULL REFERENCES `investor_categories`(`id`) ON DELETE CASCADE,
  CONSTRAINT `founder_category_assignments_unique` UNIQUE(`founder_id`, `category_id`)
);
--> statement-breakpoint
-- Founder cadence tracking columns
ALTER TABLE `founders` ADD COLUMN `intro_target_per_week` integer DEFAULT 2;
--> statement-breakpoint
ALTER TABLE `founders` ADD COLUMN `intro_cadence_active` integer DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `founders` ADD COLUMN `cadence_start_date` text;
