import { ApiError, type DataSource } from './client';
import { refreshAccessToken, type FetchLike } from './refresh';
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

async function send(fetchImpl: FetchLike, method: 'GET' | 'POST', path: string, body: unknown): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = readToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  try {
    return await fetchImpl(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (error) {
    throw new ApiError(0, `백엔드에 연결할 수 없습니다 (${(error as Error).message})`);
  }
}

async function toError(response: Response): Promise<ApiError> {
  let message = `${response.status} ${response.statusText}`;
  try {
    const payload = (await response.json()) as { message?: unknown };
    if (typeof payload.message === 'string') message = payload.message;
    else if (Array.isArray(payload.message)) message = payload.message.join(', ');
  } catch {
    // 본문이 JSON이 아니면 상태 줄만 쓴다
  }
  return new ApiError(response.status, message);
}

/**
 * 같은 origin 으로 요청한다 (Vite 프록시가 backend-v2 로 전달).
 * 401 이면 refresh token 이 있을 때 한 번만 갱신하고 원래 요청을 한 번만 재시도한다. 그래도 401 이면 그대로 던진다.
 */
export async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown, fetchImpl: FetchLike = fetch): Promise<T> {
  let response = await send(fetchImpl, method, path, body);
  if (response.status === 401 && (await refreshAccessToken(fetchImpl))) {
    response = await send(fetchImpl, method, path, body);
  }
  if (!response.ok) throw await toError(response);
  return (await response.json()) as T;
}

/** Vite 프록시를 통해 같은 origin 으로 backend-v2 를 호출한다. */
export class RealDataSource implements DataSource {
  readonly kind = 'real' as const;

  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  private get<T>(path: string) {
    return request<T>('GET', path, undefined, this.fetchImpl);
  }

  healthz() {
    return this.get<{ ok: boolean }>('/healthz');
  }

  me() {
    return this.get<CurrentUser>('/users/me');
  }

  listApplications() {
    return this.get<ApplicationView[]>('/applications');
  }

  getApplication(applicationId: string) {
    return this.get<ApplicationView>(`/applications/${encodeURIComponent(applicationId)}`);
  }

  listDeployments(applicationId: string) {
    return this.get<Deployment[]>(`/applications/${encodeURIComponent(applicationId)}/deployments`);
  }

  getDeployment(deploymentId: string) {
    return this.get<DeploymentView>(`/deployments/${encodeURIComponent(deploymentId)}`);
  }

  approveDeployment(deploymentId: string) {
    return request<Deployment>('POST', `/deployments/${encodeURIComponent(deploymentId)}/approve`, {}, this.fetchImpl);
  }

  getRouting(applicationId: string) {
    return this.get<RouteSnapshot>(`/applications/${encodeURIComponent(applicationId)}/routing`);
  }

  getTargets(applicationId: string) {
    return this.get<RoutingTargetView[]>(`/applications/${encodeURIComponent(applicationId)}/targets`);
  }

  getAgentStatus(agentId: string) {
    return this.get<AgentStatusResponse>(`/agents/${encodeURIComponent(agentId)}/status`);
  }
}
