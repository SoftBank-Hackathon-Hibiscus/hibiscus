import { describe, expect, it } from 'vitest';
import { shouldPoll } from './usePolling';

describe('shouldPoll', () => {
  it('탭이 보이면 폴링한다', () => {
    expect(shouldPoll('visible')).toBe(true);
  });

  it('탭이 숨겨져 있으면 주기 폴링을 건너뛴다', () => {
    expect(shouldPoll('hidden')).toBe(false);
  });

  it('document 가 없는 환경(테스트·SSR)에서는 폴링한다', () => {
    expect(shouldPoll(undefined)).toBe(true);
  });
});
