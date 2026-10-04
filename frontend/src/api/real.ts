import { ApiError, type DataSource } from './client';
import { refreshAccessToken, type FetchLike } from './refresh';
import { readToken } from './token';
import type {
  AgentStatusResponse,
  AgentTunnelStatus,
  AgentRegistration,
  AgentSshEnrollment,
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
  GithubBranchesPage,
  GithubConnection,
  GithubCommitsPage,
  GithubInstallationsPage,
  GithubRepositoriesPage,
  HealthCheckConfig,
  RouteSnapshot,
  RoutingTargetView,
  UpdateHealthCheckInput,
  UpdateApplicationEnvironmentInput,
  UpdateApplicationEnvironmentResponse,
} from './types';

/** GitHub 목록은 한 페이지에 최대 100개(backend GithubPageDto 의 per_page 상한) */
export const GITHUB_PAGE_SIZE = 100;

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

async function send(fetchImpl: FetchLike, method: HttpMethod, path: string, body: unknown): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = readToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  try {
    return await fetchImpl(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (error) {
    throw new ApiError(0, `backend unreachable: ${(error as Error).message}`);
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
export async function request<T>(method: HttpMethod, path: string, body?: unknown, fetchImpl: FetchLike = fetch): Promise<T> {
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

  private post<T>(path: string, body: unknown) {
    return request<T>('POST', path, body, this.fetchImpl);
  }

  private patch<T>(path: string, body: unknown) {
    return request<T>('PATCH', path, body, this.fetchImpl);
  }

  private delete<T>(path: string) {
    return request<T>('DELETE', path, undefined, this.fetchImpl);
  }

  private put<T>(path: string, body: unknown) {
    return request<T>('PUT', path, body, this.fetchImpl);
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

  updateHealthCheck(applicationId: string, input: UpdateHealthCheckInput) {
    return this.patch<HealthCheckConfig>(`/applications/${encodeURIComponent(applicationId)}/health-check`, input);
  }

  updateApplicationEnvironment(applicationId: string, input: UpdateApplicationEnvironmentInput) {
    return this.put<UpdateApplicationEnvironmentResponse>(`/applications/${encodeURIComponent(applicationId)}/environment`, input);
  }

  updateApplicationTestEnvironment(applicationId: string, input: UpdateApplicationEnvironmentInput) {
    return this.put<UpdateApplicationEnvironmentResponse>(`/applications/${encodeURIComponent(applicationId)}/test-environment`, input);
  }

  updateApplicationSettings(id: string, input: UpdateApplicationSettingsInput) {
    return this.patch<ApplicationView>(`/applications/${encodeURIComponent(id)}/settings`, input);
  }
  getTraffic(id: string, seconds: number) {
    return this.get<TrafficSnapshot>(`/applications/${encodeURIComponent(id)}/traffic?seconds=${seconds}`);
  }
  getApplicationLogs(id: string, query: RuntimeLogsQuery) {
    const params = new URLSearchParams(Object.entries(query).filter(([,value])=>value!==undefined).map(([key,value])=>[key,String(value)]));
    return this.get<RuntimeLogsResponse>(`/applications/${encodeURIComponent(id)}/logs?${params}`);
  }
  getRoutingHistory(id: string) { return this.get<RoutingChange[]>(`/applications/${encodeURIComponent(id)}/routing/history`); }
  listDeployments(applicationId: string) {
    return this.get<Deployment[]>(`/applications/${encodeURIComponent(applicationId)}/deployments`);
  }

  getDeployment(deploymentId: string) {
    return this.get<DeploymentView>(`/deployments/${encodeURIComponent(deploymentId)}`);
  }

  approveDeployment(deploymentId: string) {
    return this.post<Deployment>(`/deployments/${encodeURIComponent(deploymentId)}/approve`, {});
  }

  cancelDeployment(deploymentId: string) {
    return this.post<Deployment>(`/deployments/${encodeURIComponent(deploymentId)}/cancel`, {});
  }

  rollbackDeployment(deploymentId: string) {
    return this.post<Deployment>(`/deployments/${encodeURIComponent(deploymentId)}/rollback`, {});
  }

  getRouting(applicationId: string) {
    return this.get<RouteSnapshot>(`/applications/${encodeURIComponent(applicationId)}/routing`);
  }

  unassignApplicationAgent(id:string, agentId:string) {return this.delete(`/applications/${encodeURIComponent(id)}/agents/${encodeURIComponent(agentId)}`);}
  assignApplicationAgent(id: string, agentId: string) {
    return this.post(`/applications/${encodeURIComponent(id)}/agents/${encodeURIComponent(agentId)}`, {});
  }
  changeRouting(id: string, targetId: string, revision: number) {
    return this.patch<RouteSnapshot>(`/applications/${encodeURIComponent(id)}/routing`, {target_id: targetId, expected_revision: revision, reason: 'Console manual switch'});
  }
  getTargets(applicationId: string) {
    return this.get<RoutingTargetView[]>(`/applications/${encodeURIComponent(applicationId)}/targets`);
  }

  getAgentTunnel(id:string) {return this.get<AgentTunnelStatus>(`/agents/${encodeURIComponent(id)}/tunnel`);}
  getAgentStatus(agentId: string) {
    return this.get<AgentStatusResponse>(`/agents/${encodeURIComponent(agentId)}/status`);
  }

  listAgents() {
    return this.get<AgentSummary[]>('/agents');
  }

  createAgent(name: string) {
    return this.post<AgentRegistration>('/agents', { name });
  }

  rotateAgentToken(agentId: string) {
    return this.post<AgentTokenRotation>(`/agents/${encodeURIComponent(agentId)}/token/rotate`, {});
  }

  revokeAgentToken(agentId: string) {
    return this.delete<AgentSummary>(`/agents/${encodeURIComponent(agentId)}/token`);
  }

  createAgentSshEnrollment(agentId: string) {
    return this.post<AgentSshEnrollment>(`/agents/${encodeURIComponent(agentId)}/ssh/enrollment`, {});
  }

  listApplicationCommits(id: string, page=1, revision?: string) {
    return this.get<GithubCommitsPage>(`/github/applications/${encodeURIComponent(id)}/commits?page=${page}${revision ? `&revision=${encodeURIComponent(revision)}` : ''}`);
  }
  getGithubConnection() {
    return this.get<GithubConnection>('/github/connection');
  }

  listGithubInstallations(page = 1) {
    return this.get<GithubInstallationsPage>(`/github/installations?page=${page}&per_page=${GITHUB_PAGE_SIZE}`);
  }

  listGithubRepositories(installationId: number, page = 1) {
    return this.get<GithubRepositoriesPage>(`/github/repositories?installation_id=${installationId}&page=${page}&per_page=${GITHUB_PAGE_SIZE}`);
  }

  listGithubBranches(installationId: number, repositoryId: number, page = 1) {
    return this.get<GithubBranchesPage>(`/github/repositories/${repositoryId}/branches?installation_id=${installationId}&page=${page}&per_page=${GITHUB_PAGE_SIZE}`);
  }

  createGithubApplication(input: GithubApplicationInput) {
    // backend 는 whitelist + forbidNonWhitelisted 라 DTO 에 없는 키를 보내면 400. input 은 DTO 키만 담는다 (lib/forms.ts).
    return this.post<GithubApplicationCreated>('/github/applications', input);
  }

  createDeployment(applicationId: string, input: CreateDeploymentInput) {
    return this.post<Deployment>(`/applications/${encodeURIComponent(applicationId)}/deployments`, input);
  }
}
