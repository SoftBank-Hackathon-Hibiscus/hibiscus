import { ApiError, type DataSource } from './client';
import type {
  AgentRegistration,
  AgentSshEnrollment,
  AgentStatusResponse,
  AgentTunnelStatus,
  AgentSummary,
  AgentTokenRotation,
  ApplicationView,
  UpdateApplicationSettingsInput,
  TrafficSnapshot,
  RuntimeLogsResponse,
  RuntimeLogsQuery,
  RoutingChange,
  CreateDeploymentInput,
  CurrentUser,
  Deployment,
  DeploymentView,
  GithubApplicationCreated,
  GithubApplicationInput,
  GithubApplicationLink,
  GithubBranchesPage,
  GithubConnection,
  GithubCommitsPage,
  GithubInstallationsPage,
  GithubRepositoriesPage,
  HealthCheckConfig,
  RouteSnapshot,
  RoutingTargetView,
  Trigger,
  UpdateHealthCheckInput,
  UpdateApplicationEnvironmentInput,
  UpdateApplicationEnvironmentResponse,
} from './types';
import { normalizeEnvironment, validateEnvironment } from '../lib/forms';
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
  private scenarioCancelled = false;
  private readonly created: CreatedApplication[] = [];
  private readonly agents: AgentSummary[];

  constructor(
    readonly scenario: MockScenario,
    private readonly now: () => number = () => Date.now(),
    private readonly latencyMs: number = LATENCY_MS,
  ) {
    this.startedAt = now();
    this.agents = scenario.application.agents.map((agent) => ({
      ...structuredClone(agent),
      sshEnrolledAt: agent.status === 'registered' ? null : agent.updatedAt,
    }));
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
    if (!this.scenarioCancelled) this.scenario.controls?.advance?.(now);
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

  async updateHealthCheck(applicationId: string, input: UpdateHealthCheckInput): Promise<HealthCheckConfig> {
    this.tick();
    const view = this.isScenarioApp(applicationId) ? this.scenario.application : this.createdApp(applicationId)?.view;
    if (!view) return this.fail(404, 'Application not found');
    const updated: HealthCheckConfig = {
      ...view.healthCheck,
      enabled: input.enabled,
      path: input.path,
      versionPath: input.version_path,
      method: input.method,
      intervalSeconds: input.interval_seconds,
      timeoutSeconds: input.timeout_seconds,
      successStatusMin: input.success_status_min,
      successStatusMax: input.success_status_max,
      successThreshold: input.success_threshold,
      failureThreshold: input.failure_threshold,
      updatedAt: new Date(this.now()).toISOString(),
    };
    view.healthCheck = updated;
    return this.delay(updated);
  }

  async updateApplicationEnvironment(applicationId: string, input: UpdateApplicationEnvironmentInput): Promise<UpdateApplicationEnvironmentResponse> {
    return this.replaceEnvironmentAndDeploy(applicationId, input, 'runtime');
  }

  async updateApplicationTestEnvironment(applicationId: string, input: UpdateApplicationEnvironmentInput): Promise<UpdateApplicationEnvironmentResponse> {
    return this.replaceEnvironmentAndDeploy(applicationId, input, 'test');
  }

  async updateApplicationSettings(id:string,input:UpdateApplicationSettingsInput):Promise<ApplicationView> {
    const view=this.isScenarioApp(id)?this.scenario.application:this.createdApp(id)?.view;
    if(!view)throw new ApiError(404,'Application not found');
    for(const [rows,names] of [[input.environment,view.environment??[]],[input.test_environment,view.testEnvironment??[]]] as const){
      if(new Set(rows.map(r=>r.name)).size!==rows.length)throw new ApiError(400,'Duplicate environment names');
      if(rows.some(r=>r.value===undefined&&!names.includes(r.name)))throw new ApiError(400,'New variable requires a value');
    }
    const h=input.health_check;
    view.healthCheck={...view.healthCheck,enabled:h.enabled,path:h.path,versionPath:h.version_path,method:h.method,intervalSeconds:h.interval_seconds,timeoutSeconds:h.timeout_seconds,successStatusMin:h.success_status_min,successStatusMax:h.success_status_max,successThreshold:h.success_threshold,failureThreshold:h.failure_threshold,updatedAt:new Date(this.now()).toISOString()};
    view.environment=input.environment.map(r=>r.name).sort();view.testEnvironment=input.test_environment.map(r=>r.name).sort();
    return this.delay(view);
  }
  async getTraffic(id:string,seconds:number):Promise<TrafficSnapshot> {
    await this.getApplication(id);
    return this.delay({startedAt:new Date(this.startedAt).toISOString(),windowSeconds:seconds,observedSeconds:seconds,requests:0,requestsPerSecond:0,errors:0,errorRate:0,p95Ms:null,targets:[],buckets:Array.from({length:30},(_,i)=>({timestamp:new Date(this.now()-(30-i)*seconds/30*1000).toISOString(),requests:0,errors:0,requestsPerSecond:0}))});
  }
  async getApplicationLogs(id:string,query:RuntimeLogsQuery):Promise<RuntimeLogsResponse>{await this.getApplication(id);return this.delay({entries:[],truncated:false,fetchedAt:new Date(this.now()).toISOString(),source:query.target,unavailable:'데모 시나리오에는 앱 실행 로그가 없습니다.'});}
  async getRoutingHistory(id:string):Promise<RoutingChange[]>{await this.getApplication(id);return this.delay([]);}

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
    if (this.scenario.deployments.find((v) => v.deployment.id === deploymentId)?.deployment.status === 'cancelled') return this.fail(409, 'Deployment is not awaiting approval');
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

  async cancelDeployment(deploymentId: string): Promise<Deployment> {
    this.tick();
    const deployment = this.scenario.deployments.find((v) => v.deployment.id === deploymentId)?.deployment ?? this.created.flatMap((c) => c.deployments).find((v) => v.deployment.id === deploymentId)?.deployment;
    if (!deployment) return this.fail(404, 'Deployment not found');
    if (deployment.status === 'cancelled') return this.delay(deployment);
    if (!['queued', 'awaiting_approval', 'running'].includes(deployment.status) || deployment.currentStage === 'deploy') {
      return this.fail(409, 'Deployment cannot be cancelled after deploy starts or after completion');
    }
    if (this.isScenarioApp(deployment.applicationId)) this.scenarioCancelled = true;
    deployment.status = 'cancelled';
    deployment.updatedAt = new Date(this.now()).toISOString();
    return this.delay(deployment);
  }

  async rollbackDeployment(deploymentId: string): Promise<Deployment> {
    const { deployment } = await this.getDeployment(deploymentId);
    if (deployment.status !== 'succeeded' || !deployment.deploymentPerformed) return this.fail(409, 'Rollback requires a successfully deployed version');
    const route = await this.getRouting(deployment.applicationId);
    const views = this.isScenarioApp(deployment.applicationId) ? this.scenario.deployments : this.createdApp(deployment.applicationId)?.deployments;
    const active = views?.find((view) => view.deployment.id === route.target.deploymentId)?.deployment;
    if (!active || active.version <= deployment.version) return this.fail(409, 'Rollback target must be older than the active deployment');
    if (views!.some((view) => ['queued', 'running', 'awaiting_approval'].includes(view.deployment.status))) return this.fail(409, 'Cancel or finish pending deployments before rollback');
    return this.delay(this.pushDeployment(views!, deployment.applicationId, { source_revision: deployment.sourceRevision }, 'rollback', this.now()));
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

  async unassignApplicationAgent(id:string,agentId:string) {const app=await this.getApplication(id);app.agents=app.agents.filter(a=>a.id!==agentId);return app;}
  async assignApplicationAgent(id: string, agentId: string) {
    const app = await this.getApplication(id);
    const agent = this.agents.find(a => a.id === agentId);
    if (!agent || agent.status === 'revoked') throw new ApiError(404, 'Agent not found');
    if (!app.agents.some(a => a.id === agentId)) app.agents.push(agent);
    return app;
  }
  async changeRouting(_id: string, _targetId: string, _revision: number): Promise<RouteSnapshot> {
    throw new ApiError(409, '실제 대상 전환은 실제 콘솔에서 실행하세요.');
  }
  async getTargets(applicationId: string): Promise<RoutingTargetView[]> {
    this.tick();
    if (this.isScenarioApp(applicationId)) return this.delay(this.frame().targets);
    if (this.createdApp(applicationId)) return this.delay([]);
    return this.fail(404, 'Application not found');
  }

  async getAgentTunnel(_id:string):Promise<AgentTunnelStatus> {throw new ApiError(503,'실제 SSH 상태는 실제 콘솔에서 확인하세요.');}
  async getAgentStatus(agentId: string): Promise<AgentStatusResponse> {
    this.tick();
    const status = this.frame().agents[agentId];
    if (!status) {
      const agent = this.agents.find((item) => item.id === agentId);
      if (!agent) return this.fail(404, 'Agent not found');
      return this.delay({
        schema_version: 1,
        agent_id: agent.id,
        status: agent.status,
        last_seen_at: agent.lastSeenAt,
        updated_at: agent.lastSeenAt,
        received_at: agent.lastSeenAt,
        serving: null,
        public_url: null,
      });
    }
    return this.delay(status);
  }

  async listAgents(): Promise<AgentSummary[]> {
    return this.delay(this.agents);
  }

  async createAgent(name: string): Promise<AgentRegistration> {
    const timestamp = new Date(this.now()).toISOString();
    const agent: AgentSummary = {
      id: randomId(),
      name,
      status: 'registered',
      lastSeenAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      sshEnrolledAt: null,
    };
    this.agents.push(agent);
    return this.delay({
      agent,
      token: `mock-agent-token-${agent.id}`,
      agent_id: agent.id,
      ssh_enrollment_token: `mock-ssh-enrollment-${agent.id}`,
      expires_at: new Date(this.now() + 600_000).toISOString(),
      ssh: { host: 'gateway.example.test', port: 2222, user: 'hibiscus-agent', host_key_sha256: 'SHA256:mock' },
    });
  }

  async rotateAgentToken(agentId: string): Promise<AgentTokenRotation> {
    const agent = this.agents.find((item) => item.id === agentId);
    if (!agent) return this.fail(404, 'Agent not found');
    agent.status = 'registered';
    agent.lastSeenAt = null;
    agent.updatedAt = new Date(this.now()).toISOString();
    return this.delay({ agent, token: `mock-rotated-token-${agent.id}` });
  }

  async revokeAgentToken(agentId: string): Promise<AgentSummary> {
    const agent = this.agents.find((item) => item.id === agentId);
    if (!agent) return this.fail(404, 'Agent not found');
    agent.status = 'revoked';
    agent.updatedAt = new Date(this.now()).toISOString();
    return this.delay(agent);
  }

  async createAgentSshEnrollment(agentId: string): Promise<AgentSshEnrollment> {
    const agent = this.agents.find((item) => item.id === agentId);
    if (!agent) return this.fail(404, 'Agent not found');
    return this.delay({
      agent_id: agent.id,
      ssh_enrollment_token: `mock-ssh-enrollment-${agent.id}`,
      expires_at: new Date(this.now() + 600_000).toISOString(),
      ssh: { host: 'gateway.example.test', port: 2222, user: 'hibiscus-agent', host_key_sha256: 'SHA256:mock' },
    });
  }

  // ---------------------------------------------------------------- GitHub 연동 (in-memory)

  async listApplicationCommits(id: string, page=1, _revision?: string): Promise<GithubCommitsPage> {
    const app = await this.getApplication(id);
    return {branch:app.application.defaultBranch??'main',page,hasMore:false,commits:[]};
  }
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
      environment: (input.environment ?? []).map(({ name }) => name).sort(),
      testEnvironment: (input.test_environment ?? []).map(({ name }) => name).sort(),
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

  private async replaceEnvironmentAndDeploy(applicationId: string, input: UpdateApplicationEnvironmentInput, kind: 'runtime' | 'test'): Promise<UpdateApplicationEnvironmentResponse> {
    const now = this.tick();
    if (validateEnvironment(input.environment) !== null) return this.fail(400, 'Invalid environment variables');
    const view = this.isScenarioApp(applicationId) ? this.scenario.application : this.createdApp(applicationId)?.view;
    const deployments = this.isScenarioApp(applicationId) ? this.scenario.deployments : this.createdApp(applicationId)?.deployments;
    if (!view || !deployments) return this.fail(404, 'Application not found');
    const latest = [...deployments].sort((left, right) => right.deployment.version - left.deployment.version)[0]?.deployment;
    if (!latest) return this.fail(409, 'Application has no deployment source to redeploy');
    const environment = normalizeEnvironment(input.environment).map(({ name }) => name).sort();
    if (kind === 'runtime') view.environment = environment;
    else view.testEnvironment = environment;
    const deployment = this.pushDeployment(deployments, applicationId, { source_revision: latest.sourceRevision }, 'manual', now);
    return this.delay({ environment, deployment });
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
