ALTER TABLE `founders` ADD `bonus_shots` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `founders` ADD `bonus_gym_granted` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `founders` ADD `bonus_meetings_granted` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `founders` ADD `bonus_investors_granted` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `founders` ADD `blitz_until` text;--> statement-breakpoint
ALTER TABLE `founders` ADD `blitz_target` integer;