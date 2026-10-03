import { useEffect, useRef, useState } from 'react';

/**
 * 로딩 표시가 한 번 보이면 최소 ms 동안은 유지한다.
 * mock 응답은 120ms 라 그대로 두면 로더가 깜빡이고 사라진다. real API 에는 ms=0 으로 써서 응답을 지연시키지 않는다.
 */
export function useMinVisible(active: boolean, ms: number): boolean {
  const [holding, setHolding] = useState(active);
  const shownAt = useRef<number | null>(active ? Date.now() : null);

  useEffect(() => {
    if (active) {
      if (shownAt.current === null) shownAt.current = Date.now();
      setHolding(true);
      return;
    }
    if (shownAt.current === null || ms <= 0) {
      shownAt.current = null;
      setHolding(false);
      return;
    }
    const release = () => {
      shownAt.current = null;
      setHolding(false);
    };
    const left = shownAt.current + ms - Date.now();
    if (left <= 0) {
      release();
      return;
    }
    const timer = setTimeout(release, left);
    return () => clearTimeout(timer);
  }, [active, ms]);

  return active || holding;
}
