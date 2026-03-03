-- Admin sessions table (persistent sessions for admin login)
CREATE TABLE IF NOT EXISTS `admin_sessions` (
  `id` text PRIMARY KEY,
  `email` text NOT NULL,
  `expires_at` text NOT NULL,
  `created_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_admin_sessions_email` ON `admin_sessions` (`email`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_admin_sessions_expires` ON `admin_sessions` (`expires_at`);
