CREATE TABLE `application_runtime_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`deployment_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`timestamp` text NOT NULL,
	`stream` text NOT NULL,
	`level` text NOT NULL,
	`message` text NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`deployment_id`) REFERENCES `deployments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `runtime_logs_deployment_time` ON `application_runtime_logs` (`deployment_id`,`timestamp`);