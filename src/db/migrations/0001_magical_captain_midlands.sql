CREATE TABLE `investor_research` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`investor_id` integer NOT NULL,
	`bio` text,
	`investment_thesis` text,
	`portfolio_companies` text,
	`founder_preferences` text,
	`recent_activity` text,
	`source_urls` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`error_message` text,
	`researched_at` text,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	FOREIGN KEY (`investor_id`) REFERENCES `investors`(`id`) ON UPDATE no action ON DELETE no action
);
