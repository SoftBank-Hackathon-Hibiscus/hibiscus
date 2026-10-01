import { relations } from 'drizzle-orm';
import {
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import type {
  AgentJobResultPayload,
  ServingContainer,
} from '../agent/types/agent.type.js';

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    githubId: text('github_id').notNull(),
    login: text('login').notNull(),
    name: text('name'),
    avatarUrl: text('avatar_url'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [uniqueIndex('users_github_id_unique').on(table.githubId)],
);

export const applications = sqliteTable(
  'applications',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    sourcePath: text('source_path').notNull(),
    imageRepo: text('image_repo').notNull(),
    containerPort: integer('container_port').notNull().default(8080),
    repo: text('repo'),
    defaultBranch: text('default_branch'),
    policyPath: text('policy_path'),
    testTemplate: text('test_template', {
      enum: ['allow', 'block-test-failed'],
    }).notNull(),
    requiresApproval: integer('requires_approval', {
      mode: 'boolean',
    }).notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [uniqueIndex('applications_slug_unique').on(table.slug)],
);

export const githubCredentials = sqliteTable('github_credentials', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  encryptedToken: text('encrypted_token').notNull(),
  expiresAt: integer('expires_at'),
  updatedAt: text('updated_at').notNull(),
});

export const githubApplicationLinks = sqliteTable('github_application_links', {
  applicationId: text('application_id')
    .primaryKey()
    .references(() => applications.id, { onDelete: 'cascade' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id),
  installationId: integer('installation_id').notNull(),
  repositoryId: integer('repository_id').notNull(),
  repositoryFullName: text('repository_full_name').notNull(),
  branch: text('branch').notNull(),
  autoDeploy: integer('auto_deploy', { mode: 'boolean' }).notNull(),
  active: integer('active', { mode: 'boolean' }).notNull(),
  createdAt: text('created_at').notNull(),
});

export const githubWebhookDeliveries = sqliteTable(
  'github_webhook_deliveries',
  {
    id: text('id').primaryKey(),
    event: text('event').notNull(),
    payloadHash: text('payload_hash').notNull(),
    status: text('status', { enum: ['processed', 'ignored'] }).notNull(),
    deploymentIds: text('deployment_ids', { mode: 'json' })
      .$type<string[]>()
      .notNull(),
    receivedAt: text('received_at').notNull(),
  },
);

export const healthCheckConfigs = sqliteTable('health_check_configs', {
  applicationId: text('application_id')
    .primaryKey()
    .references(() => applications.id, { onDelete: 'cascade' }),
  enabled: integer('enabled', { mode: 'boolean' }).notNull(),
  path: text('path').notNull(),
  method: text('method', { enum: ['GET', 'HEAD'] }).notNull(),
  intervalSeconds: integer('interval_seconds').notNull(),
  timeoutSeconds: integer('timeout_seconds').notNull(),
  successStatusMin: integer('success_status_min').notNull(),
  successStatusMax: integer('success_status_max').notNull(),
  successThreshold: integer('success_threshold').notNull(),
  failureThreshold: integer('failure_threshold').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const deployments = sqliteTable(
  'deployments',
  {
    id: text('id').primaryKey(),
    applicationId: text('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    trigger: text('trigger', { enum: ['manual', 'webhook'] }).notNull(),
    sourceRevision: text('source_revision').notNull(),
    sourceRevisionVerified: integer('source_revision_verified', {
      mode: 'boolean',
    }).notNull(),
    imageDigest: text('image_digest').notNull(),
    digestSource: text('digest_source', {
      enum: ['registry', 'placeholder'],
    }).notNull(),
    requester: text('requester').notNull(),
    approver: text('approver'),
    decision: text('decision', {
      enum: ['allow', 'needs_approval', 'block'],
    }),
    status: text('status', {
      enum: [
        'queued',
        'running',
        'awaiting_approval',
        'blocked',
        'failed',
        'succeeded',
      ],
    }).notNull(),
    currentStage: text('current_stage', {
      enum: ['test', 'policy', 'sign', 'deploy'],
    }),
    error: text('error'),
    workDir: text('work_dir').notNull(),
    executionMode: text('execution_mode', {
      enum: ['skeleton', 'cli'],
    }).notNull(),
    deploymentPerformed: integer('deployment_performed', {
      mode: 'boolean',
    }).notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('deployments_application_version_unique').on(
      table.applicationId,
      table.version,
    ),
  ],
);

export const agents = sqliteTable(
  'agents',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull(),
    status: text('status', {
      enum: ['registered', 'online', 'offline', 'revoked'],
    }).notNull(),
    lastSeenAt: text('last_seen_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('agents_name_unique').on(table.name),
    uniqueIndex('agents_token_hash_unique').on(table.tokenHash),
  ],
);

export const agentHeartbeats = sqliteTable('agent_heartbeats', {
  agentId: text('agent_id')
    .primaryKey()
    .references(() => agents.id, { onDelete: 'cascade' }),
  reportedAt: text('reported_at').notNull(),
  receivedAt: text('received_at').notNull(),
  serving: text('serving', { mode: 'json' }).$type<ServingContainer | null>(),
  publicUrl: text('public_url'),
});

export const agentJobs = sqliteTable('agent_jobs', {
  id: text('id').primaryKey(),
  agentId: text('agent_id')
    .notNull()
    .references(() => agents.id),
  runId: text('run_id')
    .notNull()
    .references(() => deployments.id),
  action: text('action', {
    enum: ['candidate', 'activate', 'rollback', 'discard'],
  }).notNull(),
  digest: text('digest').notNull(),
  image: text('image'),
  planHash: text('plan_hash'),
  toDigest: text('to_digest'),
  createdAt: text('created_at').notNull(),
  deadline: text('deadline').notNull(),
  status: text('status', {
    enum: ['queued', 'leased', 'succeeded', 'failed', 'expired'],
  }).notNull(),
  attempt: integer('attempt').notNull().default(0),
  leaseUntil: text('lease_until'),
});

export const agentJobResults = sqliteTable(
  'agent_job_results',
  {
    jobId: text('job_id')
      .notNull()
      .references(() => agentJobs.id),
    attempt: integer('attempt').notNull(),
    payload: text('payload', { mode: 'json' })
      .$type<AgentJobResultPayload>()
      .notNull(),
    contentHash: text('content_hash').notNull(),
    receivedAt: text('received_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.jobId, table.attempt] })],
);

export const applicationAgents = sqliteTable(
  'application_agents',
  {
    applicationId: text('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    createdAt: text('created_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.applicationId, table.agentId] })],
);

export const routingTargets = sqliteTable(
  'routing_targets',
  {
    id: text('id').primaryKey(),
    applicationId: text('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    deploymentId: text('deployment_id')
      .notNull()
      .references(() => deployments.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['onprem', 'cloud_run'] }).notNull(),
    agentId: text('agent_id').references(() => agents.id),
    localPort: integer('local_port'),
    url: text('url'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('routing_target_application_deployment_kind_agent_unique').on(
      table.applicationId,
      table.deploymentId,
      table.kind,
      table.agentId,
    ),
  ],
);

export const applicationRoutes = sqliteTable('application_routes', {
  applicationId: text('application_id')
    .primaryKey()
    .references(() => applications.id, { onDelete: 'cascade' }),
  targetId: text('target_id')
    .notNull()
    .references(() => routingTargets.id),
  revision: integer('revision').notNull(),
  changedBy: text('changed_by')
    .notNull()
    .references(() => users.id),
  reason: text('reason'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const routingChanges = sqliteTable('routing_changes', {
  id: text('id').primaryKey(),
  applicationId: text('application_id')
    .notNull()
    .references(() => applications.id, { onDelete: 'cascade' }),
  previousTargetId: text('previous_target_id').references(
    () => routingTargets.id,
  ),
  targetId: text('target_id')
    .notNull()
    .references(() => routingTargets.id),
  previousRevision: integer('previous_revision').notNull(),
  revision: integer('revision').notNull(),
  changedBy: text('changed_by')
    .notNull()
    .references(() => users.id),
  reason: text('reason'),
  createdAt: text('created_at').notNull(),
});

export const routingTargetHealth = sqliteTable('routing_target_health', {
  targetId: text('target_id')
    .primaryKey()
    .references(() => routingTargets.id, { onDelete: 'cascade' }),
  deploymentId: text('deployment_id')
    .notNull()
    .references(() => deployments.id, { onDelete: 'cascade' }),
  status: text('status', {
    enum: ['healthy', 'unhealthy', 'unknown'],
  }).notNull(),
  observedAt: text('observed_at').notNull(),
  expiresAt: text('expires_at').notNull(),
  reason: text('reason'),
  updatedAt: text('updated_at').notNull(),
});

export const stageExecutions = sqliteTable(
  'stage_executions',
  {
    id: text('id').primaryKey(),
    deploymentId: text('deployment_id')
      .notNull()
      .references(() => deployments.id, { onDelete: 'cascade' }),
    sequence: integer('sequence').notNull(),
    attempt: integer('attempt').notNull(),
    stage: text('stage', {
      enum: ['test', 'policy', 'sign', 'deploy'],
    }).notNull(),
    status: text('status', {
      enum: ['pending', 'running', 'succeeded', 'failed', 'skipped'],
    }).notNull(),
    exitCode: integer('exit_code'),
    startedAt: text('started_at').notNull(),
    finishedAt: text('finished_at'),
    artifacts: text('artifacts', { mode: 'json' })
      .$type<Record<string, string>>()
      .notNull(),
    summary: text('summary', { mode: 'json' }).$type<unknown>(),
    error: text('error'),
  },
  (table) => [
    uniqueIndex('deployment_stage_attempt_unique').on(
      table.deploymentId,
      table.stage,
      table.attempt,
    ),
  ],
);

export const deploymentArtifacts = sqliteTable(
  'deployment_artifacts',
  {
    id: text('id').primaryKey(),
    deploymentId: text('deployment_id')
      .notNull()
      .references(() => deployments.id, { onDelete: 'cascade' }),
    stageExecutionId: text('stage_execution_id')
      .notNull()
      .references(() => stageExecutions.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    relativePath: text('relative_path').notNull(),
    mediaType: text('media_type', {
      enum: ['application/json', 'text/plain'],
    }).notNull(),
    content: text('content').notNull(),
    contentHash: text('content_hash').notNull(),
    schemaName: text('schema_name'),
    validationError: text('validation_error'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('artifact_stage_path_unique').on(
      table.stageExecutionId,
      table.relativePath,
    ),
  ],
);

export const deploymentAuditLogs = sqliteTable('deployment_audit_logs', {
  id: text('id').primaryKey(),
  deploymentId: text('deployment_id')
    .notNull()
    .references(() => deployments.id, { onDelete: 'cascade' }),
  stageExecutionId: text('stage_execution_id')
    .notNull()
    .references(() => stageExecutions.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['deploy', 'rollback', 'sign'] }).notNull(),
  payload: text('payload', { mode: 'json' })
    .$type<Record<string, unknown>>()
    .notNull(),
  createdAt: text('created_at').notNull(),
});

export const policyResults = sqliteTable('policy_results', {
  deploymentId: text('deployment_id')
    .primaryKey()
    .references(() => deployments.id, { onDelete: 'cascade' }),
  decision: text('decision', {
    enum: ['allow', 'needs_approval', 'block'],
  }).notNull(),
  planHash: text('plan_hash'),
  targets: text('targets', { mode: 'json' }).$type<string[]>().notNull(),
  failoverAllowed: integer('failover_allowed', { mode: 'boolean' }).notNull(),
  requires: text('requires', { mode: 'json' }).$type<unknown[]>().notNull(),
  planPath: text('plan_path'),
  piiPath: text('pii_path'),
  planArtifactId: text('plan_artifact_id').references(
    () => deploymentArtifacts.id,
  ),
  piiArtifactId: text('pii_artifact_id').references(
    () => deploymentArtifacts.id,
  ),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const applicationsRelations = relations(
  applications,
  ({ one, many }) => ({
    healthCheck: one(healthCheckConfigs),
    deployments: many(deployments),
    agentLinks: many(applicationAgents),
    routingTargets: many(routingTargets),
    route: one(applicationRoutes),
  }),
);

export const healthCheckConfigsRelations = relations(
  healthCheckConfigs,
  ({ one }) => ({
    application: one(applications, {
      fields: [healthCheckConfigs.applicationId],
      references: [applications.id],
    }),
  }),
);

export const deploymentsRelations = relations(deployments, ({ one, many }) => ({
  requesterUser: one(users, {
    fields: [deployments.requester],
    references: [users.id],
    relationName: 'requestedDeployments',
  }),
  approverUser: one(users, {
    fields: [deployments.approver],
    references: [users.id],
    relationName: 'approvedDeployments',
  }),
  application: one(applications, {
    fields: [deployments.applicationId],
    references: [applications.id],
  }),
  stages: many(stageExecutions),
  artifacts: many(deploymentArtifacts),
  auditLogs: many(deploymentAuditLogs),
  policyResult: one(policyResults),
  routingTargets: many(routingTargets),
}));

export const agentsRelations = relations(agents, ({ many }) => ({
  applicationLinks: many(applicationAgents),
  jobs: many(agentJobs),
  routingTargets: many(routingTargets),
}));

export const routingTargetsRelations = relations(routingTargets, ({ one }) => ({
  application: one(applications, {
    fields: [routingTargets.applicationId],
    references: [applications.id],
  }),
  deployment: one(deployments, {
    fields: [routingTargets.deploymentId],
    references: [deployments.id],
  }),
  agent: one(agents, {
    fields: [routingTargets.agentId],
    references: [agents.id],
  }),
  health: one(routingTargetHealth),
}));

export const applicationRoutesRelations = relations(
  applicationRoutes,
  ({ one }) => ({
    application: one(applications, {
      fields: [applicationRoutes.applicationId],
      references: [applications.id],
    }),
    target: one(routingTargets, {
      fields: [applicationRoutes.targetId],
      references: [routingTargets.id],
    }),
  }),
);

export const routingTargetHealthRelations = relations(
  routingTargetHealth,
  ({ one }) => ({
    target: one(routingTargets, {
      fields: [routingTargetHealth.targetId],
      references: [routingTargets.id],
    }),
  }),
);

export const agentJobsRelations = relations(agentJobs, ({ one, many }) => ({
  agent: one(agents, { fields: [agentJobs.agentId], references: [agents.id] }),
  deployment: one(deployments, {
    fields: [agentJobs.runId],
    references: [deployments.id],
  }),
  results: many(agentJobResults),
}));
export const agentJobResultsRelations = relations(
  agentJobResults,
  ({ one }) => ({
    job: one(agentJobs, {
      fields: [agentJobResults.jobId],
      references: [agentJobs.id],
    }),
  }),
);

export const applicationAgentsRelations = relations(
  applicationAgents,
  ({ one }) => ({
    application: one(applications, {
      fields: [applicationAgents.applicationId],
      references: [applications.id],
    }),
    agent: one(agents, {
      fields: [applicationAgents.agentId],
      references: [agents.id],
    }),
  }),
);

export const stageExecutionsRelations = relations(
  stageExecutions,
  ({ one }) => ({
    deployment: one(deployments, {
      fields: [stageExecutions.deploymentId],
      references: [deployments.id],
    }),
  }),
);

export const policyResultsRelations = relations(policyResults, ({ one }) => ({
  deployment: one(deployments, {
    fields: [policyResults.deploymentId],
    references: [deployments.id],
  }),
}));

export const usersRelations = relations(users, ({ many }) => ({
  requestedDeployments: many(deployments, {
    relationName: 'requestedDeployments',
  }),
  approvedDeployments: many(deployments, {
    relationName: 'approvedDeployments',
  }),
}));

export const deploymentArtifactsRelations = relations(
  deploymentArtifacts,
  ({ one }) => ({
    deployment: one(deployments, {
      fields: [deploymentArtifacts.deploymentId],
      references: [deployments.id],
    }),
    stageExecution: one(stageExecutions, {
      fields: [deploymentArtifacts.stageExecutionId],
      references: [stageExecutions.id],
    }),
  }),
);
export const deploymentAuditLogsRelations = relations(
  deploymentAuditLogs,
  ({ one }) => ({
    deployment: one(deployments, {
      fields: [deploymentAuditLogs.deploymentId],
      references: [deployments.id],
    }),
    stageExecution: one(stageExecutions, {
      fields: [deploymentAuditLogs.stageExecutionId],
      references: [stageExecutions.id],
    }),
  }),
);

export type DeploymentArtifact = typeof deploymentArtifacts.$inferSelect;
export type DeploymentAuditLog = typeof deploymentAuditLogs.$inferSelect;
export type User = typeof users.$inferSelect;
export type Application = typeof applications.$inferSelect;
export type HealthCheckConfig = typeof healthCheckConfigs.$inferSelect;
export type Deployment = typeof deployments.$inferSelect;
export type Agent = typeof agents.$inferSelect;
export type AgentHeartbeat = typeof agentHeartbeats.$inferSelect;
export type AgentJob = typeof agentJobs.$inferSelect;
export type AgentJobResult = typeof agentJobResults.$inferSelect;
export type ApplicationAgent = typeof applicationAgents.$inferSelect;
export type RoutingTarget = typeof routingTargets.$inferSelect;
export type ApplicationRoute = typeof applicationRoutes.$inferSelect;
export type RoutingChange = typeof routingChanges.$inferSelect;
export type RoutingTargetHealth = typeof routingTargetHealth.$inferSelect;
export type StageExecution = typeof stageExecutions.$inferSelect;
export type PolicyResult = typeof policyResults.$inferSelect;
