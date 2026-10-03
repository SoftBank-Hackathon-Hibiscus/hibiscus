import { useCallback, useEffect, useState } from 'react';
import { ApiError, type DataSource } from '../api/client';
import { readToken } from '../api/token';
import type { CurrentUser } from '../api/types';

export type ConnectionState =
  | { level: 'checking' }
  /** /healthz 응답 없음 */
  | { level: 'down'; detail: string }
  /** 백엔드는 살아 있으나 토큰 없음 또는 401 */
  | { level: 'login'; detail: string; tokenPresent: boolean }
  /** /users/me 성공 */
  | { level: 'ok'; user: CurrentUser };

/** real 모드 연결 상태. mock 으로 되돌리지 않고 실패를 그대로 보여준다. */
export function useConnection(source: DataSource, tokenVersion: number, intervalMs = 15000): { state: ConnectionState; recheck: () => void } {
  const [state, setState] = useState<ConnectionState>({ level: 'checking' });
  const [tick, setTick] = useState(0);
  const recheck = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    const probe = async () => {
      try {
        // 다른 서버가 8080 을 쓰고 있어도 초록으로 보이지 않게 body 까지 확인한다
        const health = await source.healthz();
        if (!health || health.ok !== true) throw new Error('GET /healthz did not return the backend-v2 shape ({ ok: true })');
      } catch (error) {
        if (!cancelled) setState({ level: 'down', detail: error instanceof Error ? error.message : String(error) });
        return;
      }
      if (!readToken()) {
        if (!cancelled) setState({ level: 'login', detail: 'no token', tokenPresent: false });
        return;
      }
      try {
        const user = await source.me();
        if (!cancelled) setState({ level: 'ok', user });
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 401) setState({ level: 'login', detail: 'token expired or invalid (401)', tokenPresent: true });
        else if (error instanceof ApiError && error.status === 403) setState({ level: 'login', detail: 'GitHub account is not in the allow list (403)', tokenPresent: true });
        else setState({ level: 'down', detail: error instanceof Error ? error.message : String(error) });
      }
    };
    void probe();
    const timer = setInterval(probe, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [source, tokenVersion, tick, intervalMs]);

  return { state, recheck };
}
