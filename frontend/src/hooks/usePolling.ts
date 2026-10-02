import { useCallback, useEffect, useRef, useState } from 'react';

export interface PollState<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  lastUpdated: number | null;
  refresh: () => void;
}

/**
 * fn 을 즉시 한 번 실행하고, intervalMs 가 숫자면 그 주기로 반복한다 (null 이면 반복 없음).
 * 이전 데이터는 에러가 나도 유지해서 화면이 비지 않게 한다.
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
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
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
