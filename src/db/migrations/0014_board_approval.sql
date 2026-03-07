-- Board members table for tracking board consent approvals
CREATE TABLE IF NOT EXISTS `board_members` (
  `id` integer PRIMARY KEY AUTOINCREMENT,
  `workflow_id` integer NOT NULL REFERENCES `onboarding_workflows`(`id`) ON DELETE CASCADE,
  `name` text NOT NULL,
  `email` text NOT NULL,
  `title` text,
  `is_founder` integer NOT NULL DEFAULT 0,
  `approved_at` text,
  `approval_ip` text,
  `created_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_board_members_workflow` ON `board_members` (`workflow_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_board_members_email` ON `board_members` (`email`);
--> statement-breakpoint

-- Add board approval tracking fields to onboarding_workflows
ALTER TABLE `onboarding_workflows` ADD COLUMN `board_approval_requested_at` text;
--> statement-breakpoint
ALTER TABLE `onboarding_workflows` ADD COLUMN `board_approved_at` text;
