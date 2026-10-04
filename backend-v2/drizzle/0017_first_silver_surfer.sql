CREATE TABLE `agent_ssh_events` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`kind` text NOT NULL,
	`code` text,
	`message` text NOT NULL,
	`port` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_ssh_events_agent_time_idx` ON `agent_ssh_events` (`agent_id`,`created_at`);