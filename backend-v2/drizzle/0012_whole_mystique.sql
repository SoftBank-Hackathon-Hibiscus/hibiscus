ALTER TABLE `policy_results` ADD `policy_path` text;--> statement-breakpoint
ALTER TABLE `policy_results` ADD `policy_hash` text;--> statement-breakpoint
ALTER TABLE `policy_results` ADD `skipped` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `applications` DROP COLUMN `policy_path`;