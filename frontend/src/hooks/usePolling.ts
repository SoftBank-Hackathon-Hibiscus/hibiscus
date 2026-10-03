import { useCallback, useEffect, useRef, useState } from 'react';

export interface PollState<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  lastUpdated: number | null;
  refresh: () => void;
}

/** 탭이 보이지 않으면 주기적 폴링을 건너뛴다. 첫 호출과 수동 refresh 는 항상 실행한다. */
export function shouldPoll(visibilityState: DocumentVisibilityState | string | undefined): boolean {
  return visibilityState !== 'hidden';
}

function currentVisibility(): string | undefined {
  return typeof document === 'undefined' ? undefined : document.visibilityState;
}

/**
 * fn 을 즉시 한 번 실행하고, intervalMs 가 숫자면 그 주기로 반복한다 (null 이면 반복 없음).
 * 이전 데이터는 에러가 나도 유지해서 화면이 비지 않게 한다.
 * 탭이 숨겨져 있으면 주기 실행을 건너뛰고, 다시 보이면 즉시 한 번 갱신한다. 화면 상태는 초기화하지 않는다.
 */
export function usePolling<T>(fn: () => Promise<T>, intervalMs: number | null, deps: unknown[]): PollState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (intervalMs === null || typeof document === 'undefined') return;
    const onVisibility = () => {
      if (shouldPoll(document.visibilityState)) setTick((t) => t + 1);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [intervalMs]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let first = true;
    const run = async () => {
      // 첫 실행(마운트·수동 refresh·탭 복귀)은 항상, 주기 실행은 탭이 보일 때만
      if (!first && !shouldPoll(currentVisibility())) {
        if (!cancelled && intervalMs !== null) timer = setTimeout(run, intervalMs);
        return;
      }
      first = false;
      try {
        const next = await fnRef.current();
        if (cancelled) return;
        setData(next);
        setError(null);
        setLastUpdated(Date.now());
      } catch (e) {
        if (cancelled) return;
        setError(e);
      } finally {
        if (!cancelled) {
          setLoading(false);
          if (intervalMs !== null) timer = setTimeout(run, intervalMs);
        }
      }
    };
    setLoading(true);
    void run();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, tick, ...deps]);

  return { data, error, loading, lastUpdated, refresh };
}
