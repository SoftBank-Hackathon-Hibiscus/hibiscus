import { describe, expect, it } from 'vitest';
import { readRefreshToken, readToken, writeTokens } from '../api/token';
import { AFTER_SIGN_IN_PATH, AFTER_SIGN_OUT_PATH, finishSignIn, signOut } from './session';
import { HOME_PATH } from './router';

describe('session', () => {
  it('로그인 성공 후에는 홈(#/)으로 간다', () => {
    const visited: string[] = [];
    finishSignIn((path) => visited.push(path));
    expect(visited).toEqual([HOME_PATH]);
    expect(AFTER_SIGN_IN_PATH).toBe('/');
  });

  it('로그아웃은 access/refresh 토큰을 지우고 홈(#/)으로 간다', () => {
    writeTokens({ accessToken: 'access-1', refreshToken: 'refresh-1' });
    expect(readToken()).toBe('access-1');
    const visited: string[] = [];
    signOut((path) => visited.push(path));
    expect(readToken()).toBeNull();
    expect(readRefreshToken()).toBeNull();
    expect(visited).toEqual([HOME_PATH]);
    expect(AFTER_SIGN_OUT_PATH).toBe('/');
  });
});
