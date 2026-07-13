ALTER TABLE `founders` ADD `calibrated_at` text;--> statement-breakpoint
-- Grandfather every existing founder as already-calibrated so the calibration
-- burst only applies to founders who sign up after this migration. New founders
-- are created with calibrated_at NULL and go through calibration.
UPDATE `founders` SET `calibrated_at` = CURRENT_TIMESTAMP WHERE `calibrated_at` IS NULL;