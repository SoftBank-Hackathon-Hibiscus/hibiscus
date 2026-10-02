import { ApiError, type DataSource } from './client';
import type {
  AgentStatusResponse,
  ApplicationView,
  CurrentUser,
  Deployment,
  DeploymentView,
  RouteSnapshot,
  RoutingTargetView,
} from './types';
import type { MockScenario } from '../mocks';

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

/**
 * 시나리오 데이터를 실제 API 와 같은 형태로 돌려준다.
 * 프레임은 생성 시점부터 흐른 시간으로 고르고, 시나리오에 controls 가 있으면 매 요청 전에 advance 를 부른다.
 * 시계(now)는 테스트에서 바꿀 수 있다.
 */
export class MockDataSource implements DataSource {
  readonly kind = 'mock' as const;
  private readonly startedAt: number;

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
    return this.delay([this.scenario.application]);
  }

  async getApplication(applicationId: string): Promise<ApplicationView> {
    this.tick();
    if (applicationId !== this.scenario.application.application.id) throw new ApiError(404, 'Application not found');
    return this.delay(this.scenario.application);
  }

  async listDeployments(applicationId: string): Promise<Deployment[]> {
    this.tick();
    if (applicationId !== this.scenario.application.application.id) throw new ApiError(404, 'Application not found');
    return this.delay(
      this.scenario.deployments
        .map((v) => v.deployment)
        .sort((a, b) => b.version - a.version),
    );
  }

  async getDeployment(deploymentId: string): Promise<DeploymentView> {
    this.tick();
    const found = this.scenario.deployments.find((v) => v.deployment.id === deploymentId);
    if (!found) throw new ApiError(404, 'Deployment not found');
    return this.delay(found);
  }

  async approveDeployment(deploymentId: string): Promise<Deployment> {
    const now = this.tick();
    if (this.scenario.controls?.approve) return this.delay(this.scenario.controls.approve(deploymentId, now));
    const found = this.scenario.deployments.find((v) => v.deployment.id === deploymentId);
    if (!found) throw new ApiError(404, 'Deployment not found');
    if (found.deployment.status !== 'awaiting_approval') throw new ApiError(409, 'Deployment is not awaiting approval');
    if (found.deployment.requester === MOCK_USER.id) throw new ApiError(403, 'Requester cannot approve their own deployment');
    found.deployment.approver = MOCK_USER.id;
    found.deployment.status = 'running';
    found.deployment.updatedAt = new Date(now).toISOString();
    return this.delay(found.deployment);
  }

  async getRouting(applicationId: string): Promise<RouteSnapshot> {
    this.tick();
    if (applicationId !== this.scenario.application.application.id) throw new ApiError(404, 'Application not found');
    const { route } = this.frame();
    if (!route) throw new ApiError(404, 'Application route not found');
    return this.delay(route);
  }

  async getTargets(applicationId: string): Promise<RoutingTargetView[]> {
    this.tick();
    if (applicationId !== this.scenario.application.application.id) throw new ApiError(404, 'Application not found');
    return this.delay(this.frame().targets);
  }

  async getAgentStatus(agentId: string): Promise<AgentStatusResponse> {
    this.tick();
    const status = this.frame().agents[agentId];
    if (!status) throw new ApiError(404, 'Agent not found');
    return this.delay(status);
  }
}
