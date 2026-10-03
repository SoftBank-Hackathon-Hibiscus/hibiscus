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
/** schema.ts deployments.trigger. registration = POST /github/applications 가 만드는 최초 배포 */
export type Trigger = 'manual' | 'webhook' | 'registration';
export type TargetKind = 'onprem' | 'cloud_run';
export type HealthStatus = 'healthy' | 'unhealthy' | 'unknown';
export type FailureKind = 'application' | 'network';
export type AgentStatus = 'registered' | 'online' | 'offline' | 'revoked';

/** GET /users/me */
export interface CurrentUser {
  id: string;
  githubId: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

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

/** PATCH /applications/:id/health-check */
export interface UpdateHealthCheckInput {
  enabled: boolean;
  path: string;
  version_path: string | null;
  method: 'GET' | 'HEAD';
  interval_seconds: number;
  timeout_seconds: number;
  success_status_min: number;
  success_status_max: number;
  success_threshold: number;
  failure_threshold: number;
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

/** GET /agents 의 원소 */
export interface AgentSummary extends ApplicationAgentSummary {
  sshEnrolledAt: string | null;
}

export interface AgentSshConnection {
  host: string;
  port: number;
  user: string;
  host_key_sha256: string;
}

/** POST /agents 응답. token 값은 이 응답에서만 확인할 수 있다. */
export interface AgentRegistration {
  agent: AgentSummary;
  token: string;
  agent_id: string;
  ssh_enrollment_token: string;
  expires_at: string;
  ssh: AgentSshConnection;
}

/** POST /agents/:id/token/rotate 응답 */
export interface AgentTokenRotation {
  agent: AgentSummary;
  token: string;
}

/** POST /agents/:id/ssh/enrollment 응답 */
export interface AgentSshEnrollment {
  agent_id: string;
  ssh_enrollment_token: string;
  expires_at: string;
  ssh: AgentSshConnection;
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

// ---------------------------------------------------------------- GitHub 연동 (backend-v2 github.controller, origin/main)

/** GET /github/connection */
export interface GithubConnection {
  connected: boolean;
  /** GitHub App slug 가 설정돼 있을 때만. 없으면 null */
  installation_url: string | null;
}

export interface GithubInstallation {
  id: number;
  /** 설치된 계정/조직 login */
  account: string;
}

/** GET /github/installations */
export interface GithubInstallationsPage {
  total_count: number;
  page: number;
  installations: GithubInstallation[];
}

export interface GithubRepository {
  id: number;
  full_name: string;
  default_branch: string;
  private: boolean;
}

/** GET /github/repositories?installation_id= */
export interface GithubRepositoriesPage {
  total_count: number;
  page: number;
  repositories: GithubRepository[];
}

/** GET /github/repositories/:repositoryId/branches?installation_id= (total_count 없음) */
export interface GithubBranchesPage {
  repository_id: number;
  default_branch: string;
  page: number;
  branches: Array<{ name: string }>;
}

/**
 * POST /github/applications 요청 본문 = GithubApplicationDto (CreateApplicationDto 확장).
 * backend 가 채우는 값은 보내지 않는다: source_path(기본 'github' → https://github.com/{repo}.git), repo, default_branch, public_host.
 * health_check 는 DTO 기본값(/health, GET, 5s/2s, 200–399, 1/3)을 쓰므로 생략한다.
 */
export interface GithubApplicationInput {
  name: string;
  slug: string;
  image_repo: string;
  container_port?: number;
  policy_path?: string;
  test_template?: 'allow' | 'block-test-failed';
  requires_approval?: boolean;
  installation_id: number;
  repository_id: number;
  branch: string;
  auto_deploy?: boolean;
}

/** github_application_links 행 */
export interface GithubApplicationLink {
  applicationId: string;
  userId: string;
  installationId: number;
  repositoryId: number;
  repositoryFullName: string;
  branch: string;
  autoDeploy: boolean;
  active: boolean;
  createdAt: string;
}

/**
 * POST /github/applications 응답: ApplicationView + github 링크 + 최초 배포.
 * backend 는 같은 트랜잭션에서 선택한 브랜치의 최신 커밋(40자리 SHA)으로 trigger='registration' 배포를 만든다.
 * auto_deploy 와 상관없이 항상 만든다. #40 이전 backend 는 이 필드가 없으므로 optional 로 둔다.
 */
export type GithubApplicationCreated = ApplicationView & { github: GithubApplicationLink; initial_deployment?: Deployment };

/** POST /applications/:id/deployments 요청 본문 = CreateDeploymentDto (deployment.dto.ts) */
export interface CreateDeploymentInput {
  /** /^[0-9a-f]{7,40}$/ */
  source_revision: string;
  /** /^sha256:[0-9a-f]{64}$/ . 없으면 backend 가 placeholder digest 를 만든다 */
  image_digest?: string;
}
