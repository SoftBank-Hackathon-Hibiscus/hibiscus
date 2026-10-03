// JS 로 거는 짧은 애니메이션. CSS 애니메이션은 styles.css 의 prefers-reduced-motion 이 막지만 이쪽은 직접 확인한다.

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/** 꽃 로더 한 사이클이 보이는 최소 시간. 화면의 최초 데이터 로딩에만 쓴다 (폴링·새로고침에는 쓰지 않음) */
export const LOADER_MIN_MS = 900;

/** 최초 로딩에서 로더를 유지할 시간. reduced-motion 이면 0 (응답 즉시 표시) */
export function loaderHoldMs(): number {
  return prefersReducedMotion() ? 0 : LOADER_MIN_MS;
}

/** 언어를 바꾸면 글자가 한 번에 바뀌면서 줄 길이도 달라진다. 그 순간을 살짝 흐렸다가 되돌려 덜 튀게 한다. */
export function fadeTextSwap(targets: Array<Element | null | undefined>): void {
  if (prefersReducedMotion()) return;
  for (const el of targets) {
    el?.animate([{ opacity: 0.25, filter: 'blur(3px)' }, { opacity: 1, filter: 'blur(0)' }], {
      duration: 320,
      easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)',
    });
  }
}
