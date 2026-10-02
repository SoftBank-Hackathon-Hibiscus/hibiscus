ALTER TABLE `agents` ADD `ssh_enrollment_token_hash` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `ssh_enrollment_expires_at` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `ssh_enrollment_used_at` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `ssh_public_key` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `ssh_key_fingerprint` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `ssh_enrolled_at` text;--> statement-breakpoint
CREATE UNIQUE INDEX `agents_ssh_enrollment_token_hash_unique` ON `agents` (`ssh_enrollment_token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `agents_ssh_key_fingerprint_unique` ON `agents` (`ssh_key_fingerprint`);