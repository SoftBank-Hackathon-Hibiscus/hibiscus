// 401 → POST /auth/refresh 를 딱 한 번. 여러 요청이 동시에 401 이어도 refresh 는 한 번만 부른다 (single-flight).
// refresh token 이 없으면 아무것도 하지 않고 false. refresh 가 실패하면 refresh token 을 지워 다음 401 은 바로 "로그인 필요"가 된다.
// mock 으로 되돌아가는 분기는 없다.
import { clearRefreshToken, readRefreshToken, writeTokens } from './token';

export interface RefreshResponse {
  access_token: string;
  refresh_token: string;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

let inflight: Promise<boolean> | null = null;

export function refreshAccessToken(fetchImpl: FetchLike = fetch): Promise<boolean> {
  const refreshToken = readRefreshToken();
  if (!refreshToken) return Promise.resolve(false);
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const response = await fetchImpl('/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
      if (!response.ok) {
        clearRefreshToken();
        return false;
      }
      const body = (await response.json()) as Partial<RefreshResponse>;
      if (typeof body.access_token !== 'string') {
        clearRefreshToken();
        return false;
      }
      writeTokens({ accessToken: body.access_token, refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : refreshToken });
      return true;
    } catch {
      return false;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** 테스트용. 진행 중인 refresh 상태를 초기화한다. */
export function resetRefreshState(): void {
  inflight = null;
}
