import { ApiError, type DataSource } from './client';
import { readToken } from './token';
import type {
  AgentStatusResponse,
  ApplicationView,
  CurrentUser,
  Deployment,
  DeploymentView,
  RouteSnapshot,
  RoutingTargetView,
} from './types';

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = readToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw new ApiError(0, `백엔드에 연결할 수 없습니다 (${(error as Error).message})`);
  }
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const payload = (await response.json()) as { message?: unknown };
      if (typeof payload.message === 'string') message = payload.message;
      else if (Array.isArray(payload.message)) message = payload.message.join(', ');
    } catch {
      // 본문이 JSON이 아니면 상태 줄만 쓴다
    }
    throw new ApiError(response.status, message);
  }
  return (await response.json()) as T;
}

/** Vite 프록시를 통해 같은 origin 으로 backend-v2 를 호출한다. */
export class RealDataSource implements DataSource {
  readonly kind = 'real' as const;

  healthz() {
    return request<{ ok: boolean }>('GET', '/healthz');
  }

  me() {
    return request<CurrentUser>('GET', '/users/me');
  }

  listApplications() {
    return request<ApplicationView[]>('GET', '/applications');
  }

  getApplication(applicationId: string) {
    return request<ApplicationView>('GET', `/applications/${encodeURIComponent(applicationId)}`);
  }

  listDeployments(applicationId: string) {
    return request<Deployment[]>('GET', `/applications/${encodeURIComponent(applicationId)}/deployments`);
  }

  getDeployment(deploymentId: string) {
    return request<DeploymentView>('GET', `/deployments/${encodeURIComponent(deploymentId)}`);
  }

  approveDeployment(deploymentId: string) {
    return request<Deployment>('POST', `/deployments/${encodeURIComponent(deploymentId)}/approve`, {});
  }

  getRouting(applicationId: string) {
    return request<RouteSnapshot>('GET', `/applications/${encodeURIComponent(applicationId)}/routing`);
  }

  getTargets(applicationId: string) {
    return request<RoutingTargetView[]>('GET', `/applications/${encodeURIComponent(applicationId)}/targets`);
  }

  getAgentStatus(agentId: string) {
    return request<AgentStatusResponse>('GET', `/agents/${encodeURIComponent(agentId)}/status`);
  }
}
