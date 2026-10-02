PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_application_routes` (
	`application_id` text PRIMARY KEY NOT NULL,
	`target_id` text NOT NULL,
	`revision` integer NOT NULL,
	`changed_by` text NOT NULL,
	`reason` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_id`) REFERENCES `routing_targets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_application_routes`("application_id", "target_id", "revision", "changed_by", "reason", "created_at", "updated_at") SELECT "application_id", "target_id", "revision", "changed_by", "reason", "created_at", "updated_at" FROM `application_routes`;--> statement-breakpoint
DROP TABLE `application_routes`;--> statement-breakpoint
ALTER TABLE `__new_application_routes` RENAME TO `application_routes`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_routing_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`previous_target_id` text,
	`target_id` text NOT NULL,
	`previous_revision` integer NOT NULL,
	`revision` integer NOT NULL,
	`changed_by` text NOT NULL,
	`reason` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`previous_target_id`) REFERENCES `routing_targets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_id`) REFERENCES `routing_targets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_routing_changes`("id", "application_id", "previous_target_id", "target_id", "previous_revision", "revision", "changed_by", "reason", "created_at") SELECT "id", "application_id", "previous_target_id", "target_id", "previous_revision", "revision", "changed_by", "reason", "created_at" FROM `routing_changes`;--> statement-breakpoint
DROP TABLE `routing_changes`;--> statement-breakpoint
ALTER TABLE `__new_routing_changes` RENAME TO `routing_changes`;--> statement-breakpoint
ALTER TABLE `routing_target_health` ADD `consecutive_failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `routing_target_health` ADD `consecutive_successes` integer DEFAULT 0 NOT NULL;