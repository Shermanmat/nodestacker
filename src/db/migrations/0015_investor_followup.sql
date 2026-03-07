-- Track investor follow-up bumps on intro requests
ALTER TABLE `intro_requests` ADD COLUMN `investor_bump_count` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `intro_requests` ADD COLUMN `last_investor_bump_at` text;
