import { useCallback, useEffect, useRef, useState } from "react";

export interface Polled<T> {
  data: T | undefined;
  error: Error | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

// interval 이 null 이면 한 번만 호출. 탭이 숨겨져 있거나 이전 요청이 안 끝났으면 건너뜀
export function usePolling<T>(load: () => Promise<T>, interval: number | null, key: string): Polled<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  loadRef.current = load;
  const generation = useRef(0);
  const inflight = useRef(false);

  const refresh = useCallback(async () => {
    const current = generation.current;
    inflight.current = true;
    try {
      const value = await loadRef.current();
      if (current !== generation.current) return;
      setData(value);
      setError(null);
    } catch (issue) {
      if (current !== generation.current) return;
      setError(issue instanceof Error ? issue : new Error(String(issue)));
    } finally {
      inflight.current = false;
      if (current === generation.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    generation.current += 1;
    setData(undefined);
    setError(null);
    setLoading(true);
    void refresh();
  }, [key, refresh]);

  useEffect(() => {
    if (interval === null) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "hidden" || inflight.current) return;
      void refresh();
    }, interval);
    return () => clearInterval(timer);
  }, [interval, key, refresh]);

  return { data, error, loading, refresh };
}
