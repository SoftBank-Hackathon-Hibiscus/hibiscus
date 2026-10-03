import { useEffect, useRef, useState } from 'react';

/**
 * 로딩 표시가 한 번 보이면 최소 ms 동안은 유지한다 (꽃 로더 한 사이클이 끝까지 보이게).
 * 응답이 ms 보다 오래 걸리면 응답 즉시 끝나고, ms=0 이면(reduced-motion) 대기 없이 바로 끝난다.
 * 호출하는 쪽이 "데이터 없음" 조건을 함께 넘기므로 폴링·새로고침에는 적용되지 않는다.
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
