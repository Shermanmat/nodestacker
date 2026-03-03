-- Add vesting schedule fields to onboarding_workflows
ALTER TABLE `onboarding_workflows` ADD COLUMN `vesting_months` integer DEFAULT 48;
ALTER TABLE `onboarding_workflows` ADD COLUMN `vesting_cliff_months` integer DEFAULT 0;
ALTER TABLE `onboarding_workflows` ADD COLUMN `vesting_start_date` text;
