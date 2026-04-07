CREATE TABLE IF NOT EXISTS `brands` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `name` text NOT NULL,
  `contact_name` text,
  `contact_email` text,
  `status` text NOT NULL DEFAULT 'lead',
  `notes` text,
  `created_at` text NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  `updated_at` text NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
