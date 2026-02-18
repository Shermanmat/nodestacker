CREATE TABLE `followup_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`intro_request_id` integer NOT NULL,
	`followup_type` text NOT NULL,
	`completed_by` text NOT NULL,
	`completed_at` text NOT NULL,
	`notes` text,
	`next_action` text,
	FOREIGN KEY (`intro_request_id`) REFERENCES `intro_requests`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `founder_node_relationships` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`founder_id` integer NOT NULL,
	`node_id` integer NOT NULL,
	`relationship_strength` text DEFAULT 'medium' NOT NULL,
	`how_connected` text,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	FOREIGN KEY (`founder_id`) REFERENCES `founders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `founders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`company_name` text NOT NULL,
	`company_stage` text NOT NULL,
	`round_status` text DEFAULT 'pre_round' NOT NULL,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `intro_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`founder_id` integer NOT NULL,
	`node_id` integer NOT NULL,
	`investor_id` integer NOT NULL,
	`status` text DEFAULT 'intro_request_sent' NOT NULL,
	`date_requested` text,
	`date_node_asked` text,
	`date_introduced` text,
	`first_meeting_date` text,
	`second_meeting_date` text,
	`next_followup_date` text,
	`last_followup_date` text,
	`followup_owner` text DEFAULT 'founder',
	`pass_reason` text,
	`notes` text,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	`updated_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	FOREIGN KEY (`founder_id`) REFERENCES `founders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`investor_id`) REFERENCES `investors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `investors` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`email` text,
	`firm` text,
	`role` text,
	`focus_areas` text,
	`check_size` text,
	`geography` text,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `node_investor_connections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`node_id` integer NOT NULL,
	`investor_id` integer NOT NULL,
	`connection_strength` text DEFAULT 'medium' NOT NULL,
	`added_by` text DEFAULT 'admin' NOT NULL,
	`validated` integer DEFAULT false NOT NULL,
	`last_intro_date` text,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`investor_id`) REFERENCES `investors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `nodes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`company` text,
	`role` text,
	`geography` text,
	`notes` text,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `founders_email_unique` ON `founders` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `investors_email_unique` ON `investors` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `nodes_email_unique` ON `nodes` (`email`);