CREATE TABLE `deployment_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`deployment_id` text NOT NULL,
	`stage_execution_id` text NOT NULL,
	`name` text NOT NULL,
	`relative_path` text NOT NULL,
	`media_type` text NOT NULL,
	`content` text NOT NULL,
	`content_hash` text NOT NULL,
	`schema_name` text,
	`validation_error` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`deployment_id`) REFERENCES `deployments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`stage_execution_id`) REFERENCES `stage_executions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifact_stage_path_unique` ON `deployment_artifacts` (`stage_execution_id`,`relative_path`);--> statement-breakpoint
CREATE TABLE `deployment_audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`deployment_id` text NOT NULL,
	`stage_execution_id` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`deployment_id`) REFERENCES `deployments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`stage_execution_id`) REFERENCES `stage_executions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `policy_results` ADD `plan_artifact_id` text REFERENCES deployment_artifacts(id);--> statement-breakpoint
ALTER TABLE `policy_results` ADD `pii_artifact_id` text REFERENCES deployment_artifacts(id);