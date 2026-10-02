// backend-v2 API 응답 타입. backend-v2/src/database/schema.ts 의 row 타입과
// controller 응답을 손으로 옮긴 것이다. 응답은 Drizzle row 그대로라 camelCase,
// Agent 상태 응답만 snake_case.

export type DeploymentStatus =
  | 'queued'
  | 'running'
  | 'awaiting_approval'
  | 'blocked'
  | 'failed'
  | 'succeeded';
export type Decision = 'allow' | 'needs_approval' | 'block';
export type StageName = 'test' | 'policy' | 'sign' | 'deploy';
export type StageStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped';
export type ExecutionMode = 'skeleton' | 'cli';
export type DigestSource = 'registry' | 'placeholder';
export type Trigger = 'manual' | 'webhook';
export type TargetKind = 'onprem' | 'cloud_run';
export type HealthStatus = 'healthy' | 'unhealthy' | 'unknown';
export type FailureKind = 'application' | 'network';
export type AgentStatus = 'registered' | 'online' | 'offline' | 'revoked';

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
  testTemplate: 'allow' | 'block-test-failed';
  requiresApproval: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface HealthCheckConfig {
  applicationId: string;
  enabled: boolean;
  path: string;
  versionPath: string | null;
  method: 'GET' | 'HEAD';
  intervalSeconds: number;
  timeoutSeconds: number;
  successStatusMin: number;
  successStatusMax: number;
  successThreshold: number;
  failureThreshold: number;
  createdAt: string;
  updatedAt: string;
}

export interface ApplicationAgentSummary {
  id: string;
  name: string;
  /** DB 저장값. online/offline 계산은 GET /agents/:id/status 를 쓴다 */
  status: AgentStatus;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** GET /applications/:id */
export interface ApplicationView {
  application: Application;
  healthCheck: HealthCheckConfig;
  agents: ApplicationAgentSummary[];
}

export interface Deployment {
  id: string;
  applicationId: string;
  version: number;
  trigger: Trigger;
  sourceRevision: string;
  /**
   * PR #33 + #29 의미: 생성 시 항상 false. registry parity 검증(빌드 manifest와
   * 테스트 결과의 run_id·commit·digest 교차 확인)이 끝나면 true. 테스트가 block이어도 true일 수 있다.
   */
  sourceRevisionVerified: boolean;
  imageDigest: string;
  digestSource: DigestSource;
  requester: string;
  approver: string | null;
  decision: Decision | null;
  status: DeploymentStatus;
  currentStage: StageName | null;
  error: string | null;
  workDir: string;
  executionMode: ExecutionMode;
  deploymentPerformed: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StageExecution {
  id: string;
  deploymentId: string;
  sequence: number;
  attempt: number;
  stage: StageName;
  status: StageStatus;
  exitCode: number | null;
  startedAt: string;
  finishedAt: string | null;
  /** 산출물 이름 → 산출물 id */
  artifacts: Record<string, string>;
  summary: unknown;
  error: string | null;
}

export interface DeploymentArtifact {
  id: string;
  deploymentId: string;
  stageExecutionId: string;
  /** 파일명에서 .json/.md/.txt 를 뗀 값: test_result, plan, pii, explain.ko, explain.ja, approval, sign_result, deploy_result, audit_log */
  name: string;
  relativePath: string;
  mediaType: 'application/json' | 'text/plain';
  content: string;
  contentHash: string;
  schemaName: string | null;
  validationError: string | null;
  createdAt: string;
}

export interface DeploymentAuditLog {
  id: string;
  deploymentId: string;
  stageExecutionId: string;
  kind: 'deploy' | 'rollback' | 'sign';
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface PolicyResult {
  deploymentId: string;
  decision: Decision;
  planHash: string | null;
  targets: string[];
  failoverAllowed: boolean;
  requires: unknown[];
  planPath: string | null;
  piiPath: string | null;
  planArtifactId: string | null;
  piiArtifactId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** GET /deployments/:id */
export interface DeploymentView {
  deployment: Deployment;
  stages: StageExecution[];
  policyResult: PolicyResult | null;
  artifacts: DeploymentArtifact[];
  auditLogs: DeploymentAuditLog[];
}

export interface RoutingTarget {
  id: string;
  applicationId: string;
  deploymentId: string;
  kind: TargetKind;
  agentId: string | null;
  localPort: number | null;
  gatewayPort: number | null;
  url: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RoutingTargetHealth {
  targetId: string;
  deploymentId: string;
  status: HealthStatus;
  observedAt: string;
  expiresAt: string;
  reason: string | null;
  failureKind: FailureKind | null;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  updatedAt: string;
}

/** GET /applications/:id/targets 의 원소 */
export interface RoutingTargetView {
  target: RoutingTarget;
  health: RoutingTargetHealth | null;
}

/** GET /applications/:id/routing. 첫 전환 전에는 404 */
export interface RouteSnapshot {
  applicationId: string;
  target: RoutingTarget;
  revision: number;
  health: RoutingTargetHealth | null;
}

export interface ServingContainer {
  run_id: string;
  digest: string;
  container: string;
}

/** GET /agents/:id/status */
export interface AgentStatusResponse {
  schema_version: 1;
  agent_id: string;
  status: AgentStatus;
  last_seen_at: string | null;
  updated_at: string | null;
  received_at: string | null;
  serving: ServingContainer | null;
  public_url: string | null;
}
