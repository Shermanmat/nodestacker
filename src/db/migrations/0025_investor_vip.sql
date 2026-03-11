-- Add VIP flag to investors table.
-- VIP investors are only matched with founders who have a strong intro acceptance rate.
ALTER TABLE `investors` ADD COLUMN `vip` integer NOT NULL DEFAULT 0;
