import { loadTokens, saveTokens } from "./session";
import type {
  AgentStatus,
  ApplicationView,
  Deployment,
  DeploymentView,
  RouteSnapshot,
  RoutingTargetView,
  TokenResponse,
  User,
} from "./types";

// 화면이 쓰는 API. 실제 백엔드와 mock 이 같은 모양을 구현
export interface Api {
  me(): Promise<User>;
  listApplications(): Promise<ApplicationView[]>;
  getApplication(id: string): Promise<ApplicationView>;
  listDeployments(applicationId: string): Promise<Deployment[]>;
  getDeployment(id: string): Promise<DeploymentView>;
  approve(id: string): Promise<Deployment>;
  // 첫 전환 전에는 404 → null
  getRouting(applicationId: string): Promise<RouteSnapshot | null>;
  listTargets(applicationId: string): Promise<RoutingTargetView[]>;
  agentStatus(agentId: string): Promise<AgentStatus>;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const BASE = "/api";

let refreshing: Promise<boolean> | null = null;

// POST /auth/refresh { refresh_token } → TokenResponse. 동시에 여러 요청이 401 이어도 한 번만 호출
async function refreshTokens(): Promise<boolean> {
  const tokens = loadTokens();
  if (!tokens?.refreshToken) return false;
  refreshing ??= (async () => {
    try {
      const response = await fetch(`${BASE}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: tokens.refreshToken }),
      });
      if (!response.ok) return false;
      const body = (await response.json()) as TokenResponse;
      saveTokens({ accessToken: body.access_token, refreshToken: body.refresh_token });
      return true;
    } catch {
      return false;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

async function request<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
  const tokens = loadTokens();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (tokens) headers.Authorization = `Bearer ${tokens.accessToken}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "백엔드에 연결할 수 없음");
  }
  if (response.status === 401 && !retried && (await refreshTokens())) {
    return request<T>(method, path, body, true);
  }
  if (!response.ok) {
    // Vite 프록시가 백엔드에 못 붙으면 502
    let message =
      response.status === 502 || response.status === 504
        ? "백엔드에 연결할 수 없음 (VITE_API_TARGET 확인)"
        : `${response.status} ${response.statusText}`;
    try {
      const data = (await response.json()) as { message?: unknown };
      if (typeof data.message === "string") message = data.message;
      else if (Array.isArray(data.message)) message = data.message.join(", ");
    } catch {
      // 본문 없음
    }
    throw new ApiError(response.status, message);
  }
  return (await response.json()) as T;
}

const enc = encodeURIComponent;

export const httpApi: Api = {
  me: () => request("GET", "/users/me"),
  listApplications: () => request("GET", "/applications"),
  getApplication: (id) => request("GET", `/applications/${enc(id)}`),
  listDeployments: (id) => request("GET", `/applications/${enc(id)}/deployments`),
  getDeployment: (id) => request("GET", `/deployments/${enc(id)}`),
  // 본문은 빈 객체. approver 는 서버가 토큰에서 정함
  approve: (id) => request("POST", `/deployments/${enc(id)}/approve`, {}),
  getRouting: async (id) => {
    try {
      return await request<RouteSnapshot>("GET", `/applications/${enc(id)}/routing`);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
  listTargets: (id) => request("GET", `/applications/${enc(id)}/targets`),
  agentStatus: (id) => request("GET", `/agents/${enc(id)}/status`),
};
