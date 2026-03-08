ALTER TABLE `investor_categories` ADD COLUMN `parent_id` integer REFERENCES `investor_categories`(`id`);
