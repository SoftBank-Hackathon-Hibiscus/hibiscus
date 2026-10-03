UPDATE routing_targets
SET enabled = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE enabled = 1 AND EXISTS (
  SELECT 1 FROM application_routes ar
  JOIN routing_targets active ON active.id = ar.target_id
  JOIN deployments current_deploy ON current_deploy.id = active.deployment_id
  JOIN deployments old_deploy ON old_deploy.id = routing_targets.deployment_id
  WHERE ar.application_id = routing_targets.application_id
    AND old_deploy.version < current_deploy.version
);
