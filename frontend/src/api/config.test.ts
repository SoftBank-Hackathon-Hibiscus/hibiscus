import { describe, expect, it } from 'vitest';
import { configToSearch, readConfig } from './index';

describe('readConfig', () => {
  it('mode 가 없으면 real', () => {
    expect(readConfig('')).toEqual({ mode: 'real', scenario: 1 });
    expect(readConfig('?foo=bar')).toEqual({ mode: 'real', scenario: 1 });
    expect(readConfig('?mode=real')).toEqual({ mode: 'real', scenario: 1 });
  });
  it('mode=mock 과 scenario 를 명시하면 데모 (기존 북마크 유지)', () => {
    expect(readConfig('?mode=mock&scenario=4')).toEqual({ mode: 'mock', scenario: 4 });
    expect(readConfig('?mode=mock')).toEqual({ mode: 'mock', scenario: 1 });
    expect(readConfig('?mode=mock&scenario=9')).toEqual({ mode: 'mock', scenario: 1 });
  });
  it('real 은 query 없이, mock 은 mode/scenario 명시', () => {
    expect(configToSearch({ mode: 'real', scenario: 1 })).toBe('');
    expect(configToSearch({ mode: 'mock', scenario: 3 })).toBe('?mode=mock&scenario=3');
  });
});
