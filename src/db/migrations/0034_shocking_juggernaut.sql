CREATE TABLE `mock_call_analyses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`founder_id` integer,
	`public_company_id` integer,
	`founder_name` text,
	`company_name` text,
	`transcript` text NOT NULL,
	`overall_score` integer,
	`summary` text,
	`scorecard` text,
	`blind_spots` text,
	`coaching` text,
	`model` text,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	FOREIGN KEY (`founder_id`) REFERENCES `founders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`public_company_id`) REFERENCES `public_companies`(`id`) ON UPDATE no action ON DELETE no action
);
