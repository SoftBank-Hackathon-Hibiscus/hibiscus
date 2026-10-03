import { describe, expect, it } from 'vitest';
import { LOADER_MIN_MS, loaderHoldMs, prefersReducedMotion } from './motion';

describe('motion', () => {
  it('window 가 없으면 reduced-motion 아님, 로더는 한 사이클(900ms) 유지', () => {
    expect(prefersReducedMotion()).toBe(false);
    expect(LOADER_MIN_MS).toBe(900);
    expect(loaderHoldMs()).toBe(900);
  });
  it('reduced-motion 이면 로더를 기다리지 않는다', () => {
    const g = globalThis as { window?: unknown };
    g.window = { matchMedia: () => ({ matches: true }) };
    try {
      expect(prefersReducedMotion()).toBe(true);
      expect(loaderHoldMs()).toBe(0);
    } finally {
      delete g.window;
    }
  });
});
