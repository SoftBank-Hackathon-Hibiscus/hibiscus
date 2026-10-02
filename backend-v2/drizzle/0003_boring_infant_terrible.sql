CREATE TABLE `agent_heartbeats` (
	`agent_id` text PRIMARY KEY NOT NULL,
	`reported_at` text NOT NULL,
	`received_at` text NOT NULL,
	`serving` text,
	`public_url` text,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `agent_job_results` (
	`job_id` text NOT NULL,
	`attempt` integer NOT NULL,
	`payload` text NOT NULL,
	`content_hash` text NOT NULL,
	`received_at` text NOT NULL,
	PRIMARY KEY(`job_id`, `attempt`),
	FOREIGN KEY (`job_id`) REFERENCES `agent_jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `agent_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`run_id` text NOT NULL,
	`action` text NOT NULL,
	`digest` text NOT NULL,
	`image` text,
	`plan_hash` text,
	`to_digest` text,
	`created_at` text NOT NULL,
	`deadline` text NOT NULL,
	`status` text NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`lease_until` text,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `deployments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_token_hash_unique` ON `agents` (`token_hash`);