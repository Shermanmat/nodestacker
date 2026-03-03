-- Inbound intro logs table for BCC email logging
CREATE TABLE IF NOT EXISTS `inbound_intro_logs` (
  `id` integer PRIMARY KEY AUTOINCREMENT,
  `from_email` text NOT NULL,
  `to_emails` text NOT NULL,
  `cc_emails` text,
  `subject` text,
  `body_preview` text,
  `detected_founder_id` integer REFERENCES `founders`(`id`) ON DELETE SET NULL,
  `detected_investor_id` integer REFERENCES `investors`(`id`) ON DELETE SET NULL,
  `status` text NOT NULL DEFAULT 'pending',
  `created_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `processed_at` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_inbound_intro_logs_status` ON `inbound_intro_logs` (`status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_inbound_intro_logs_founder` ON `inbound_intro_logs` (`detected_founder_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_inbound_intro_logs_investor` ON `inbound_intro_logs` (`detected_investor_id`);
