// backend-v2 응답 형태. 출처는 각 타입 위에 적은 파일
// DB 행은 Drizzle select 결과 그대로라 camelCase, 계약 JSON(산출물 원문)은 snake_case

// backend-v2/src/database/schema.ts users, user/dto/user.dto.ts
export interface User {
  id: string;
  githubId: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

// auth/dto/auth.dto.ts TokenResponseDto (snake_case)
export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  refresh_expires_in: number;
  user: User;
}

// schema.ts applications
export interface Application {
  id: string;
  name: string;
  slug: string;
  publicHost: string | null;
  sourcePath: string;
  imageRepo: string;
  containerPort: number;
  repo: string | null;
  defaultBranch: string | null;
  policyPath: string | null;
  testTemplate: "allow" | "block-test-failed";
  requiresApproval: boolean;
  createdAt: string;
  updatedAt: string;
}

// schema.ts health_check_configs
export interface HealthCheckConfig {
  applicationId: string;
  enabled: boolean;
  path: string;
  versionPath: string | null;
  method: "GET" | "HEAD";
  intervalSeconds: number;
  timeoutSeconds: number;
  successStatusMin: number;
  successStatusMax: number;
  successThreshold: number;
  failureThreshold: number;
  createdAt: string;
  updatedAt: string;
}

export type AgentDbStatus = "registered" | "online" | "offline" | "revoked";

// application/application.repository.ts ApplicationView
// agents[].status 는 DB 값 그대로 (online/offline 재계산 안 함). 실제 상태는 /agents/:id/status
export interface ApplicationView {
  application: Application;
  healthCheck: HealthCheckConfig;
  agents: {
    id: string;
    name: string;
    status: AgentDbStatus;
    lastSeenAt: string | null;
    createdAt: string;
    updatedAt: string;
  }[];
}

export type DeploymentStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "blocked"
  | "failed"
  | "succeeded";
export type StageName = "test" | "policy" | "sign" | "deploy";
export type PolicyDecision = "allow" | "needs_approval" | "block";

// schema.ts deployments
export interface Deployment {
  id: string;
  applicationId: string;
  version: number;
  trigger: "manual" | "webhook";
  sourceRevision: string;
  sourceRevisionVerified: boolean;
  imageDigest: string;
  digestSource: "registry" | "placeholder";
  requester: string;
  approver: string | null;
  decision: PolicyDecision | null;
  status: DeploymentStatus;
  currentStage: StageName | null;
  error: string | null;
  workDir: string;
  executionMode: "skeleton" | "cli";
  deploymentPerformed: boolean;
  createdAt: string;
  updatedAt: string;
}

// schema.ts stage_executions. 재시도마다 attempt 가 늘어난 행이 하나씩 추가됨
export interface StageExecution {
  id: string;
  deploymentId: string;
  sequence: number;
  attempt: number;
  stage: StageName;
  status: "pending" | "running" | "succeeded" | "failed" | "skipped";
  exitCode: number | null;
  startedAt: string;
  finishedAt: string | null;
  artifacts: Record<string, string>;
  summary: unknown;
  error: string | null;
}

// schema.ts deployment_artifacts. content 는 원문 문자열
export interface DeploymentArtifact {
  id: string;
  deploymentId: string;
  stageExecutionId: string;
  name: string;
  relativePath: string;
  mediaType: "application/json" | "text/plain";
  content: string;
  contentHash: string;
  schemaName: string | null;
  validationError: string | null;
  createdAt: string;
}

// schema.ts deployment_audit_logs. payload 는 decisions.jsonl 한 줄
export interface DeploymentAuditLog {
  id: string;
  deploymentId: string;
  stageExecutionId: string;
  kind: "deploy" | "rollback" | "sign";
  payload: Record<string, unknown>;
  createdAt: string;
}

// schema.ts policy_results. requires 는 plan.requires 그대로
export interface PolicyResult {
  deploymentId: string;
  decision: PolicyDecision;
  planHash: string | null;
  targets: string[];
  failoverAllowed: boolean;
  requires: PlanRequire[];
  planPath: string | null;
  piiPath: string | null;
  planArtifactId: string | null;
  piiArtifactId: string | null;
  createdAt: string;
  updatedAt: string;
}

// deployment/deployment.repository.ts getView
export interface DeploymentView {
  deployment: Deployment;
  stages: StageExecution[];
  policyResult: PolicyResult | null;
  artifacts: DeploymentArtifact[];
  auditLogs: DeploymentAuditLog[];
}

// schema.ts routing_targets
export interface RoutingTarget {
  id: string;
  applicationId: string;
  deploymentId: string;
  kind: "onprem" | "cloud_run";
  agentId: string | null;
  localPort: number | null;
  gatewayPort: number | null;
  url: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

// schema.ts routing_target_health. 만료되면 서버가 status 를 unknown 으로 바꿔서 줌
export interface RoutingTargetHealth {
  targetId: string;
  deploymentId: string;
  status: "healthy" | "unhealthy" | "unknown";
  observedAt: string;
  expiresAt: string;
  reason: string | null;
  failureKind: "application" | "network" | null;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  updatedAt: string;
}

// routing/types/routing.type.ts
export interface RoutingTargetView {
  target: RoutingTarget;
  health: RoutingTargetHealth | null;
}

export interface RouteSnapshot {
  applicationId: string;
  target: RoutingTarget;
  revision: number;
  health: RoutingTargetHealth | null;
}

// agent/agent.service.ts status(). 이 응답만 snake_case
export interface ServingContainer {
  run_id: string;
  digest: string;
  container: string;
}

export interface AgentStatus {
  schema_version: 1;
  agent_id: string;
  status: AgentDbStatus;
  last_seen_at: string | null;
  updated_at: string | null;
  received_at: string | null;
  serving: ServingContainer | null;
  public_url: string | null;
}

// ---- 산출물 원문 (계약 JSON) ----

// contracts/TestResult.schema.json
export interface TestCondition {
  name: "none" | "restart" | "replace";
  total: number;
  matched: number;
  failed: boolean;
  mismatches: {
    index: number;
    request: string;
    related_fact?: string;
    related_storage?: string;
    related_kind?: string;
  }[];
}

export interface TestResult {
  run_id: string;
  app: string;
  digest: string;
  source_revision?: string;
  passed: boolean;
  match: { total: number; matched: number };
  failures?: unknown[];
  facts?: {
    db?: string;
    writes_local_file?: string[];
    conditions?: TestCondition[];
  };
}

// contracts/Plan.schema.json
export interface PlanRequire {
  id: string;
  hint?: string;
  hint_i18n?: { ja: string };
  rule_id: string;
  allowed_targets: string[];
}

export interface PlanRule {
  id: string;
  result: "matched" | "not_matched" | "matched_after_block";
  reason?: string;
  reason_i18n?: { ja: string };
}

export interface Plan {
  run_id: string;
  app: string;
  digest: string;
  source_revision?: string;
  decision: PolicyDecision;
  targets: string[];
  failover_allowed: boolean;
  requires?: PlanRequire[];
  rules: PlanRule[];
  plan_hash: string;
}

// contracts/SignResult.schema.json
export interface SignResult {
  run_id: string;
  digest: string;
  source_revision?: string;
  plan_hash: string;
  targets: string[];
  failover_allowed: boolean;
  requester: string;
  approver: string;
  signature_ref: string;
  signed_at: string;
}

// contracts/SignLog.schema.json (auditLogs kind=sign 의 payload)
export interface SignLog {
  kind: "sign";
  time: string;
  run_id: string;
  digest: string;
  source_revision?: string;
  plan_hash: string;
  result: "signed" | "refused";
  requester: string;
  approver: string | null;
  reason:
    | "policy_block"
    | "no_targets"
    | "approval_missing"
    | "approval_mismatch"
    | "requester_mismatch"
    | "self_approval"
    | "sign_failed"
    | null;
  signature_ref: string | null;
}

// deployment/types/deploy-result.type.ts (공통 계약 아직 없음)
export type DeployTarget = "cloud_run" | "onprem";
export type DeployDecision = "activated" | "held" | "rolled_back" | "error";

export interface DeployTargetStep {
  target: DeployTarget;
  phase: "candidate" | "activate" | "discard" | "rollback";
  result: "ok" | "error" | "skipped";
  revision?: string;
  candidate_url?: string;
  previous?: string | null;
  serving?: string | null;
  job_id?: string;
  container?: string;
  reason?: string;
  error?: string;
}

export interface DeployRouting {
  result: "ok" | "error" | "skipped";
  target_id?: string;
  kind?: DeployTarget;
  revision?: number;
  standby_target_id?: string;
  standby_enabled?: boolean;
  reason?: string;
  error?: string;
}

export interface DeployResult {
  run_id: string;
  digest: string;
  image: string | null;
  decision: DeployDecision;
  signature: { verified: boolean; ref: string; key: string; tlog?: "verified" | "ignored" } | null;
  targets_planned: string[];
  failover_allowed: boolean | null;
  targets: DeployTargetStep[];
  checks: {
    target: DeployTarget;
    mode: "candidate" | "live";
    pass: boolean;
    url?: string;
    checker: string;
    checks: unknown[];
  }[];
  routing: DeployRouting;
  started_at: string;
  finished_at?: string;
  error?: string;
}
