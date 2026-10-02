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
        if (!health || health.ok !== true) throw new Error('GET /healthz 응답이 backend-v2 형식({ ok: true })이 아님');
      } catch (error) {
        if (!cancelled) setState({ level: 'down', detail: error instanceof Error ? error.message : String(error) });
        return;
      }
      if (!readToken()) {
        if (!cancelled) setState({ level: 'login', detail: '토큰이 없음', tokenPresent: false });
        return;
      }
      try {
        const user = await source.me();
        if (!cancelled) setState({ level: 'ok', user });
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 401) setState({ level: 'login', detail: '토큰이 만료되었거나 유효하지 않음', tokenPresent: true });
        else if (error instanceof ApiError && error.status === 403) setState({ level: 'login', detail: '이 GitHub 계정은 허용 목록에 없음 (403)', tokenPresent: true });
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
