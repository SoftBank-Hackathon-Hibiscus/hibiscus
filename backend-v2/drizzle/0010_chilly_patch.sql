ALTER TABLE `routing_targets` ADD `gateway_port` integer;--> statement-breakpoint
WITH `ranked_onprem_targets` AS (
	SELECT
		`id`,
		ROW_NUMBER() OVER (ORDER BY `created_at`, `id`) AS `port_offset`
	FROM `routing_targets`
	WHERE `kind` = 'onprem'
)
UPDATE `routing_targets`
SET `gateway_port` = 19999 + (
	SELECT `port_offset`
	FROM `ranked_onprem_targets`
	WHERE `ranked_onprem_targets`.`id` = `routing_targets`.`id`
)
WHERE `kind` = 'onprem';--> statement-breakpoint
CREATE UNIQUE INDEX `routing_targets_gateway_port_unique` ON `routing_targets` (`gateway_port`);
