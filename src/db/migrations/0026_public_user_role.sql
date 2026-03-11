-- Add role fields to public_users table
ALTER TABLE `public_users` ADD COLUMN `role` text;
ALTER TABLE `public_users` ADD COLUMN `role_other` text;
