import { beforeEach, describe, expect, it } from 'vitest';
import { clearRefreshToken, parsePastedToken, readRefreshToken, readToken, writeToken, writeTokens } from './token';

describe('parsePastedToken', () => {
  it('토큰 문자열만', () => {
    expect(parsePastedToken(' abc ')).toEqual({ ok: true, accessToken: 'abc', refreshToken: null });
  });

  it('Bearer 접두어를 뗀다', () => {
    expect(parsePastedToken('Bearer abc')).toEqual({ ok: true, accessToken: 'abc', refreshToken: null });
    expect(parsePastedToken('bearer   abc')).toEqual({ ok: true, accessToken: 'abc', refreshToken: null });
  });

  it('콜백 JSON 전체에서 access 와 refresh 를 꺼낸다', () => {
    const json = '{"access_token":"abc","refresh_token":"ref","token_type":"Bearer","expires_in":900,"user":{"id":"u1","login":"x"}}';
    expect(parsePastedToken(json)).toEqual({ ok: true, accessToken: 'abc', refreshToken: 'ref' });
  });

  it('refresh_token 이 없는 JSON 은 access 만', () => {
    expect(parsePastedToken('{"access_token":"abc"}')).toEqual({ ok: true, accessToken: 'abc', refreshToken: null });
  });

  it('깨진 JSON 객체는 저장하지 않는다', () => {
    expect(parsePastedToken('{nope')).toEqual({ ok: false, reason: 'invalid_json' });
  });

  it('access_token 이 없는 JSON 객체는 저장하지 않는다', () => {
    expect(parsePastedToken('{"refresh_token":"ref"}')).toEqual({ ok: false, reason: 'no_access_token' });
  });

  it('빈 값', () => {
    expect(parsePastedToken('')).toEqual({ ok: false, reason: 'empty' });
    expect(parsePastedToken('Bearer ')).toEqual({ ok: false, reason: 'empty' });
  });
});

describe('token storage (localStorage 없는 환경은 메모리)', () => {
  beforeEach(() => writeToken(null));

  it('writeTokens 는 access 와 refresh 를 함께 저장한다', () => {
    writeTokens({ accessToken: 'a', refreshToken: 'r' });
    expect(readToken()).toBe('a');
    expect(readRefreshToken()).toBe('r');
  });

  it('토큰을 지우면 refresh 도 같이 지워진다', () => {
    writeTokens({ accessToken: 'a', refreshToken: 'r' });
    writeToken(null);
    expect(readToken()).toBeNull();
    expect(readRefreshToken()).toBeNull();
  });

  it('access 만 바꾸면 refresh 는 유지된다', () => {
    writeTokens({ accessToken: 'a', refreshToken: 'r' });
    writeToken('b');
    expect(readToken()).toBe('b');
    expect(readRefreshToken()).toBe('r');
  });

  it('clearRefreshToken 은 refresh 만 지운다', () => {
    writeTokens({ accessToken: 'a', refreshToken: 'r' });
    clearRefreshToken();
    expect(readToken()).toBe('a');
    expect(readRefreshToken()).toBeNull();
  });
});
