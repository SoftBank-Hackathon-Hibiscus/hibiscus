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

function delay<T>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), LATENCY_MS));
}

/** 시나리오 데이터를 실제 API 와 같은 형태로 돌려준다. 프레임은 생성 시점부터 흐른 시간으로 고른다. */
export class MockDataSource implements DataSource {
  readonly kind = 'mock' as const;
  private readonly startedAt = Date.now();

  constructor(readonly scenario: MockScenario) {}

  private frame() {
    const elapsed = (Date.now() - this.startedAt) / 1000;
    const index = Math.min(Math.floor(elapsed / this.scenario.frameSeconds), this.scenario.frames.length - 1);
    return this.scenario.frames[Math.max(index, 0)]!();
  }

  frameCaption(): string {
    return this.frame().caption;
  }

  async healthz() {
    return delay({ ok: true });
  }

  async me(): Promise<CurrentUser> {
    const now = new Date().toISOString();
    return delay({ id: 'u-demo', githubId: 0, login: 'demo', name: 'Demo', avatarUrl: null, createdAt: now, updatedAt: now });
  }

  async listApplications(): Promise<ApplicationView[]> {
    return delay([this.scenario.application]);
  }

  async getApplication(applicationId: string): Promise<ApplicationView> {
    if (applicationId !== this.scenario.application.application.id) throw new ApiError(404, 'Application not found');
    return delay(this.scenario.application);
  }

  async listDeployments(applicationId: string): Promise<Deployment[]> {
    if (applicationId !== this.scenario.application.application.id) throw new ApiError(404, 'Application not found');
    return delay(
      this.scenario.deployments
        .map((v) => v.deployment)
        .sort((a, b) => b.version - a.version),
    );
  }

  async getDeployment(deploymentId: string): Promise<DeploymentView> {
    const found = this.scenario.deployments.find((v) => v.deployment.id === deploymentId);
    if (!found) throw new ApiError(404, 'Deployment not found');
    return delay(found);
  }

  async approveDeployment(deploymentId: string): Promise<Deployment> {
    const found = this.scenario.deployments.find((v) => v.deployment.id === deploymentId);
    if (!found) throw new ApiError(404, 'Deployment not found');
    if (found.deployment.status !== 'awaiting_approval') throw new ApiError(409, 'Deployment is not awaiting approval');
    found.deployment.status = 'running';
    found.deployment.approver = 'u-approver-mock';
    found.deployment.updatedAt = new Date().toISOString();
    return delay(found.deployment);
  }

  async getRouting(applicationId: string): Promise<RouteSnapshot> {
    if (applicationId !== this.scenario.application.application.id) throw new ApiError(404, 'Application not found');
    const { route } = this.frame();
    if (!route) throw new ApiError(404, 'Application route not found');
    return delay(route);
  }

  async getTargets(applicationId: string): Promise<RoutingTargetView[]> {
    if (applicationId !== this.scenario.application.application.id) throw new ApiError(404, 'Application not found');
    return delay(this.frame().targets);
  }

  async getAgentStatus(agentId: string): Promise<AgentStatusResponse> {
    const status = this.frame().agents[agentId];
    if (!status) throw new ApiError(404, 'Agent not found');
    return delay(status);
  }
}
