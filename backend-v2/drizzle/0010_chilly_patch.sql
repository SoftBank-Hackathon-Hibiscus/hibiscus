ALTER TABLE `routing_targets` ADD `gateway_port` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `routing_targets_gateway_port_unique` ON `routing_targets` (`gateway_port`);