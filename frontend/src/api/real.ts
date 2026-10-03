import { ApiError, type DataSource } from './client';
import { refreshAccessToken, type FetchLike } from './refresh';
import { readToken } from './token';
import type {
  AgentStatusResponse,
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
  RouteSnapshot,
  RoutingTargetView,
} from './types';

/** GitHub 목록은 한 페이지에 최대 100개(backend GithubPageDto 의 per_page 상한) */
export const GITHUB_PAGE_SIZE = 100;

async function send(fetchImpl: FetchLike, method: 'GET' | 'POST', path: string, body: unknown): Promise<Response> {
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

  private post<T>(path: string, body: unknown) {
    return request<T>('POST', path, body, this.fetchImpl);
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
    return this.post<Deployment>(`/deployments/${encodeURIComponent(deploymentId)}/approve`, {});
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
