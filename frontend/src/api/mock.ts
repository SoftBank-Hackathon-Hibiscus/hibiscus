import { ApiError, type DataSource } from './client';
import type {
  AgentStatusResponse,
  ApplicationView,
  CreateDeploymentInput,
  CurrentUser,
  Deployment,
  DeploymentView,
  GithubApplicationCreated,
  GithubApplicationInput,
  GithubApplicationLink,
  GithubBranchesPage,
  GithubConnection,
  GithubInstallationsPage,
  GithubRepositoriesPage,
  RouteSnapshot,
  RoutingTargetView,
  Trigger,
} from './types';
import type { MockScenario } from '../mocks';
import { MOCK_BRANCHES, MOCK_GATEWAY_DOMAIN, MOCK_GITHUB_CONNECTION, MOCK_INSTALLATIONS, MOCK_REPOSITORIES } from '../mocks/github';

const LATENCY_MS = 120;

export const MOCK_USER: CurrentUser = {
  id: 'u-demo',
  githubId: 0,
  login: 'demo',
  name: 'Demo',
  avatarUrl: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

/** 이 브라우저 세션에서 mock 으로 등록한 앱. 실제 backend 로는 가지 않는다 */
interface CreatedApplication {
  view: ApplicationView;
  github: GithubApplicationLink;
  deployments: DeploymentView[];
}

/** backend 처럼 digest 가 없으면 placeholder (sha256 형태의 64자리 16진수) 를 만든다. 암호학적 해시는 아니다 */
function placeholderDigest(seed: string): string {
  let hex = '';
  let h = 2166136261;
  for (let i = 0; hex.length < 64; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i % seed.length), 16777619) >>> 0;
    hex += h.toString(16).padStart(8, '0');
  }
  return `sha256:${hex.slice(0, 64)}`;
}

/** mock 브랜치의 최신 커밋. backend requireBranch 가 돌려주는 것처럼 40자리 소문자 16진수 */
export function mockBranchHead(repoFullName: string, branch: string): string {
  return placeholderDigest(`branch:${repoFullName}@${branch}`).slice('sha256:'.length, 'sha256:'.length + 40);
}

function randomId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  return `mock-${Math.random().toString(16).slice(2)}-${Date.now().toString(16)}`;
}

/**
 * 시나리오 데이터를 실제 API 와 같은 형태로 돌려준다.
 * 프레임은 생성 시점부터 흐른 시간으로 고르고, 시나리오에 controls 가 있으면 매 요청 전에 advance 를 부른다.
 * 시계(now)는 테스트에서 바꿀 수 있다.
 */
export class MockDataSource implements DataSource {
  readonly kind = 'mock' as const;
  private readonly startedAt: number;
  private readonly created: CreatedApplication[] = [];

  constructor(
    readonly scenario: MockScenario,
    private readonly now: () => number = () => Date.now(),
    private readonly latencyMs: number = LATENCY_MS,
  ) {
    this.startedAt = now();
  }

  /** 실제 API 처럼 매번 새 객체를 돌려준다 (시나리오 상태를 제자리에서 바꿔도 화면이 변화를 알아채도록). */
  private delay<T>(value: T): Promise<T> {
    const copy = structuredClone(value);
    if (this.latencyMs === 0) return Promise.resolve(copy);
    return new Promise((resolve) => setTimeout(() => resolve(copy), this.latencyMs));
  }

  private fail(status: number, message: string): Promise<never> {
    const error = new ApiError(status, message);
    if (this.latencyMs === 0) return Promise.reject(error);
    return new Promise((_, reject) => setTimeout(() => reject(error), this.latencyMs));
  }

  private tick(): number {
    const now = this.now();
    this.scenario.controls?.advance?.(now);
    return now;
  }

  private frame() {
    const elapsed = (this.now() - this.startedAt) / 1000;
    const index = Math.min(Math.floor(elapsed / this.scenario.frameSeconds), this.scenario.frames.length - 1);
    return this.scenario.frames[Math.max(index, 0)]!();
  }

  private isScenarioApp(applicationId: string): boolean {
    return applicationId === this.scenario.application.application.id;
  }

  private createdApp(applicationId: string): CreatedApplication | undefined {
    return this.created.find((c) => c.view.application.id === applicationId);
  }

  frameCaption(): string {
    this.tick();
    return this.frame().caption;
  }

  /** 발표자 조작 목록 (mock 전용 UI 가 그린다) */
  actions() {
    return this.scenario.controls?.actions ?? [];
  }

  runAction(id: string): void {
    const action = this.actions().find((a) => a.id === id);
    if (action) action.run(this.now());
  }

  async healthz() {
    return this.delay({ ok: true });
  }

  async me(): Promise<CurrentUser> {
    return this.delay(MOCK_USER);
  }

  async listApplications(): Promise<ApplicationView[]> {
    this.tick();
    return this.delay([this.scenario.application, ...this.created.map((c) => c.view)]);
  }

  async getApplication(applicationId: string): Promise<ApplicationView> {
    this.tick();
    if (this.isScenarioApp(applicationId)) return this.delay(this.scenario.application);
    const created = this.createdApp(applicationId);
    if (created) return this.delay(created.view);
    return this.fail(404, 'Application not found');
  }

  async listDeployments(applicationId: string): Promise<Deployment[]> {
    this.tick();
    const views = this.isScenarioApp(applicationId) ? this.scenario.deployments : this.createdApp(applicationId)?.deployments;
    if (!views) return this.fail(404, 'Application not found');
    return this.delay(views.map((v) => v.deployment).sort((a, b) => b.version - a.version));
  }

  async getDeployment(deploymentId: string): Promise<DeploymentView> {
    this.tick();
    const found = this.scenario.deployments.find((v) => v.deployment.id === deploymentId) ?? this.created.flatMap((c) => c.deployments).find((v) => v.deployment.id === deploymentId);
    if (!found) return this.fail(404, 'Deployment not found');
    return this.delay(found);
  }

  async approveDeployment(deploymentId: string): Promise<Deployment> {
    const now = this.tick();
    if (this.scenario.controls?.approve) return this.delay(this.scenario.controls.approve(deploymentId, now));
    const found = this.scenario.deployments.find((v) => v.deployment.id === deploymentId);
    if (!found) return this.fail(404, 'Deployment not found');
    if (found.deployment.status !== 'awaiting_approval') return this.fail(409, 'Deployment is not awaiting approval');
    if (found.deployment.requester === MOCK_USER.id) return this.fail(403, 'Requester cannot approve their own deployment');
    found.deployment.approver = MOCK_USER.id;
    found.deployment.status = 'running';
    found.deployment.updatedAt = new Date(now).toISOString();
    return this.delay(found.deployment);
  }

  async getRouting(applicationId: string): Promise<RouteSnapshot> {
    this.tick();
    if (!this.isScenarioApp(applicationId)) {
      // 새로 등록한 앱은 아직 첫 전환 전 → backend 와 같은 404
      return this.fail(404, this.createdApp(applicationId) ? 'Application route not found' : 'Application not found');
    }
    const { route } = this.frame();
    if (!route) return this.fail(404, 'Application route not found');
    return this.delay(route);
  }

  async getTargets(applicationId: string): Promise<RoutingTargetView[]> {
    this.tick();
    if (this.isScenarioApp(applicationId)) return this.delay(this.frame().targets);
    if (this.createdApp(applicationId)) return this.delay([]);
    return this.fail(404, 'Application not found');
  }

  async getAgentStatus(agentId: string): Promise<AgentStatusResponse> {
    this.tick();
    const status = this.frame().agents[agentId];
    if (!status) return this.fail(404, 'Agent not found');
    return this.delay(status);
  }

  // ---------------------------------------------------------------- GitHub 연동 (in-memory)

  async getGithubConnection(): Promise<GithubConnection> {
    return this.delay(MOCK_GITHUB_CONNECTION);
  }

  async listGithubInstallations(page = 1): Promise<GithubInstallationsPage> {
    return this.delay({ total_count: MOCK_INSTALLATIONS.length, page, installations: page === 1 ? MOCK_INSTALLATIONS : [] });
  }

  async listGithubRepositories(installationId: number, page = 1): Promise<GithubRepositoriesPage> {
    const repos = MOCK_REPOSITORIES[installationId];
    if (!repos) return this.fail(404, 'GitHub resource is not accessible');
    return this.delay({ total_count: repos.length, page, repositories: page === 1 ? repos : [] });
  }

  async listGithubBranches(installationId: number, repositoryId: number, page = 1): Promise<GithubBranchesPage> {
    const repo = MOCK_REPOSITORIES[installationId]?.find((r) => r.id === repositoryId);
    if (!repo) return this.fail(404, 'Repository is not accessible');
    return this.delay({ repository_id: repo.id, default_branch: repo.default_branch, page, branches: page === 1 ? (MOCK_BRANCHES[repo.id] ?? []) : [] });
  }

  /** backend GithubService.createApplication 과 같은 순서로 검사한다: 저장소 접근 → 브랜치 존재 → slug/public host 중복 */
  async createGithubApplication(input: GithubApplicationInput): Promise<GithubApplicationCreated> {
    const repo = MOCK_REPOSITORIES[input.installation_id]?.find((r) => r.id === input.repository_id);
    if (!repo) return this.fail(404, 'Repository is not accessible');
    if (!(MOCK_BRANCHES[repo.id] ?? []).some((b) => b.name === input.branch)) return this.fail(404, 'GitHub resource is not accessible');
    const publicHost = `${input.slug}.${MOCK_GATEWAY_DOMAIN}`;
    const all = [this.scenario.application, ...this.created.map((c) => c.view)];
    if (all.some((v) => v.application.publicHost === publicHost)) return this.fail(409, 'Application public host already exists');
    if (all.some((v) => v.application.slug === input.slug)) return this.fail(409, 'Application slug already exists');

    const id = randomId();
    const timestamp = new Date(this.now()).toISOString();
    const view: ApplicationView = {
      application: {
        id,
        name: input.name,
        slug: input.slug,
        publicHost,
        sourcePath: `https://github.com/${repo.full_name}.git`,
        imageRepo: input.image_repo,
        containerPort: input.container_port ?? 8080,
        repo: repo.full_name,
        defaultBranch: input.branch,
        policyPath: input.policy_path ?? null,
        testTemplate: input.test_template ?? 'allow',
        requiresApproval: input.requires_approval ?? false,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      // HealthCheckDto 기본값
      healthCheck: {
        applicationId: id,
        enabled: true,
        path: '/health',
        versionPath: null,
        method: 'GET',
        intervalSeconds: 5,
        timeoutSeconds: 2,
        successStatusMin: 200,
        successStatusMax: 399,
        successThreshold: 1,
        failureThreshold: 3,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      agents: [],
    };
    const github: GithubApplicationLink = {
      applicationId: id,
      userId: MOCK_USER.id,
      installationId: input.installation_id,
      repositoryId: repo.id,
      repositoryFullName: repo.full_name,
      branch: input.branch,
      autoDeploy: input.auto_deploy ?? true,
      active: true,
      createdAt: timestamp,
    };
    const created: CreatedApplication = { view, github, deployments: [] };
    this.created.push(created);
    // backend 처럼 auto_deploy 와 상관없이 선택한 브랜치의 최신 커밋으로 최초 배포를 만든다
    const initial = this.pushDeployment(created.deployments, id, { source_revision: mockBranchHead(repo.full_name, input.branch) }, 'registration', this.now());
    return this.delay({ ...view, github, initial_deployment: initial });
  }

  // ---------------------------------------------------------------- 새 배포 (in-memory, 자동 진행 없음)

  /** DeploymentService.create 처럼 queued 배포 하나를 만든다. mock 에서는 worker 가 없으므로 그대로 머문다. */
  async createDeployment(applicationId: string, input: CreateDeploymentInput): Promise<Deployment> {
    const now = this.tick();
    const views = this.isScenarioApp(applicationId) ? this.scenario.deployments : this.createdApp(applicationId)?.deployments;
    if (!views) return this.fail(404, 'Application not found');
    return this.delay(this.pushDeployment(views, applicationId, input, 'manual', now));
  }

  private pushDeployment(views: DeploymentView[], applicationId: string, input: CreateDeploymentInput, trigger: Trigger, now: number): Deployment {
    const id = randomId();
    const timestamp = new Date(now).toISOString();
    const deployment: Deployment = {
      id,
      applicationId,
      version: views.reduce((max, v) => Math.max(max, v.deployment.version), 0) + 1,
      trigger,
      sourceRevision: input.source_revision,
      sourceRevisionVerified: false,
      imageDigest: input.image_digest ?? placeholderDigest(`placeholder:${id}`),
      digestSource: input.image_digest ? 'registry' : 'placeholder',
      requester: MOCK_USER.id,
      approver: null,
      decision: null,
      status: 'queued',
      currentStage: null,
      error: null,
      workDir: '',
      executionMode: 'cli',
      deploymentPerformed: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    views.push({ deployment, stages: [], policyResult: null, artifacts: [], auditLogs: [] });
    return deployment;
  }
}
