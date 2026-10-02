ALTER TABLE `applications` ADD `public_host` text;--> statement-breakpoint
CREATE UNIQUE INDEX `applications_public_host_unique` ON `applications` (`public_host`);