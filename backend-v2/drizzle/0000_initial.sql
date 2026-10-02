CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`status` text NOT NULL,
	`last_seen_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_name_unique` ON `agents` (`name`);--> statement-breakpoint
CREATE TABLE `application_agents` (
	`application_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`application_id`, `agent_id`),
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `applications` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`source_path` text NOT NULL,
	`image_repo` text NOT NULL,
	`repo` text,
	`default_branch` text,
	`policy_path` text,
	`test_template` text NOT NULL,
	`requires_approval` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `applications_slug_unique` ON `applications` (`slug`);--> statement-breakpoint
CREATE TABLE `deployments` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`version` integer NOT NULL,
	`trigger` text NOT NULL,
	`source_revision` text NOT NULL,
	`source_revision_verified` integer NOT NULL,
	`image_digest` text NOT NULL,
	`digest_source` text NOT NULL,
	`requester` text NOT NULL,
	`approver` text,
	`decision` text,
	`status` text NOT NULL,
	`current_stage` text,
	`error` text,
	`work_dir` text NOT NULL,
	`execution_mode` text NOT NULL,
	`deployment_performed` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deployments_application_version_unique` ON `deployments` (`application_id`,`version`);--> statement-breakpoint
CREATE TABLE `health_check_configs` (
	`application_id` text PRIMARY KEY NOT NULL,
	`enabled` integer NOT NULL,
	`path` text NOT NULL,
	`method` text NOT NULL,
	`interval_seconds` integer NOT NULL,
	`timeout_seconds` integer NOT NULL,
	`success_status_min` integer NOT NULL,
	`success_status_max` integer NOT NULL,
	`success_threshold` integer NOT NULL,
	`failure_threshold` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `policy_results` (
	`deployment_id` text PRIMARY KEY NOT NULL,
	`decision` text NOT NULL,
	`plan_hash` text,
	`targets` text NOT NULL,
	`failover_allowed` integer NOT NULL,
	`requires` text NOT NULL,
	`plan_path` text,
	`pii_path` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`deployment_id`) REFERENCES `deployments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `stage_executions` (
	`id` text PRIMARY KEY NOT NULL,
	`deployment_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`attempt` integer NOT NULL,
	`stage` text NOT NULL,
	`status` text NOT NULL,
	`exit_code` integer,
	`started_at` text NOT NULL,
	`finished_at` text,
	`artifacts` text NOT NULL,
	`summary` text,
	`error` text,
	FOREIGN KEY (`deployment_id`) REFERENCES `deployments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deployment_stage_attempt_unique` ON `stage_executions` (`deployment_id`,`stage`,`attempt`);