import type {
  AgentStatusResponse,
  AgentRegistration,
  AgentSshEnrollment,
  AgentSummary,
  AgentTokenRotation,
  ApplicationView,
  CreateDeploymentInput,
  CurrentUser,
  Deployment,
  DeploymentView,
  GithubApplicationCreated,
  GithubApplicationInput,
  GithubBranchesPage,
  GithubConnection,
  GithubInstallationsPage,
  GithubRepositoriesPage,
  HealthCheckConfig,
  RouteSnapshot,
  RoutingTargetView,
  UpdateHealthCheckInput,
} from './types';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }
}

/** 화면이 보는 유일한 데이터 입구. mock/real 구현이 같은 타입을 돌려준다. */
export interface DataSource {
  readonly kind: 'mock' | 'real';
  /** GET /healthz (인증 없음). 연결 확인용 */
  healthz(): Promise<{ ok: boolean }>;
  /** GET /users/me. 토큰 확인용 */
  me(): Promise<CurrentUser>;
  listApplications(): Promise<ApplicationView[]>;
  getApplication(applicationId: string): Promise<ApplicationView>;
  updateHealthCheck(applicationId: string, input: UpdateHealthCheckInput): Promise<HealthCheckConfig>;
  listDeployments(applicationId: string): Promise<Deployment[]>;
  getDeployment(deploymentId: string): Promise<DeploymentView>;
  approveDeployment(deploymentId: string): Promise<Deployment>;
  /** 첫 전환 전이면 ApiError(404) */
  getRouting(applicationId: string): Promise<RouteSnapshot>;
  getTargets(applicationId: string): Promise<RoutingTargetView[]>;
  getAgentStatus(agentId: string): Promise<AgentStatusResponse>;
  listAgents(): Promise<AgentSummary[]>;
  createAgent(name: string): Promise<AgentRegistration>;
  rotateAgentToken(agentId: string): Promise<AgentTokenRotation>;
  revokeAgentToken(agentId: string): Promise<AgentSummary>;
  createAgentSshEnrollment(agentId: string): Promise<AgentSshEnrollment>;

  // ---- GitHub 연동 (backend-v2 github.controller, origin/main 기준)
  /** GET /github/connection */
  getGithubConnection(): Promise<GithubConnection>;
  /** GET /github/installations */
  listGithubInstallations(page?: number): Promise<GithubInstallationsPage>;
  /** GET /github/repositories?installation_id= */
  listGithubRepositories(installationId: number, page?: number): Promise<GithubRepositoriesPage>;
  /** GET /github/repositories/:repositoryId/branches?installation_id= */
  listGithubBranches(installationId: number, repositoryId: number, page?: number): Promise<GithubBranchesPage>;
  /** POST /github/applications. real 에서는 실제 애플리케이션이 만들어진다 */
  createGithubApplication(input: GithubApplicationInput): Promise<GithubApplicationCreated>;

  /**
   * POST /applications/:id/deployments. 새 배포는 queued 로 만들어지고 backend worker 가
   * 테스트 → 정책 → 서명 → 배포를 실제로 돌린다 (real 에서는 팀 공용 환경에 영향)
   */
  createDeployment(applicationId: string, input: CreateDeploymentInput): Promise<Deployment>;
}
