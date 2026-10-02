import type {
  AgentStatusResponse,
  ApplicationView,
  Deployment,
  DeploymentView,
  RouteSnapshot,
  RoutingTargetView,
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
  getApplication(applicationId: string): Promise<ApplicationView>;
  listDeployments(applicationId: string): Promise<Deployment[]>;
  getDeployment(deploymentId: string): Promise<DeploymentView>;
  approveDeployment(deploymentId: string): Promise<Deployment>;
  /** 첫 전환 전이면 ApiError(404) */
  getRouting(applicationId: string): Promise<RouteSnapshot>;
  getTargets(applicationId: string): Promise<RoutingTargetView[]>;
  getAgentStatus(agentId: string): Promise<AgentStatusResponse>;
}
