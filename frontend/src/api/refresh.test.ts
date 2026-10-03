import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './client';
import { request } from './real';
import { refreshAccessToken, resetRefreshState } from './refresh';
import { readRefreshToken, readToken, writeToken, writeTokens } from './token';

type Handler = (input: string, init?: RequestInit) => Response | Promise<Response>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function fakeFetch(handler: Handler) {
  const calls: Array<{ url: string; auth: string | undefined; body: string | undefined }> = [];
  const impl = vi.fn(async (input: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: input, auth: headers.Authorization, body: typeof init?.body === 'string' ? init.body : undefined });
    return handler(input, init);
  });
  return { impl, calls };
}

beforeEach(() => {
  writeToken(null);
  resetRefreshState();
});

describe('refresh on 401', () => {
  it('refresh token 이 없으면 refresh 를 부르지 않고 401 을 그대로 던진다', async () => {
    writeToken('old');
    const { impl, calls } = fakeFetch(() => json(401, { message: 'Unauthorized' }));
    await expect(request('GET', '/users/me', undefined, impl)).rejects.toMatchObject({ status: 401 });
    expect(calls.map((c) => c.url)).toEqual(['/users/me']);
  });

  it('401 → refresh 성공 → 새 토큰으로 원래 요청을 한 번 재시도', async () => {
    writeTokens({ accessToken: 'old', refreshToken: 'ref' });
    const { impl, calls } = fakeFetch((url, init) => {
      if (url === '/auth/refresh') {
        expect(JSON.parse(init?.body as string)).toEqual({ refresh_token: 'ref' });
        return json(200, { access_token: 'new', refresh_token: 'ref2' });
      }
      const auth = (init?.headers as Record<string, string>).Authorization;
      return auth === 'Bearer new' ? json(200, { id: 'u1', login: 'me' }) : json(401, { message: 'expired' });
    });
    const me = await request<{ login: string }>('GET', '/users/me', undefined, impl);
    expect(me.login).toBe('me');
    expect(calls.map((c) => c.url)).toEqual(['/users/me', '/auth/refresh', '/users/me']);
    expect(calls[2]?.auth).toBe('Bearer new');
    expect(readToken()).toBe('new');
    expect(readRefreshToken()).toBe('ref2');
  });

  it('refresh 가 실패하면 재시도 없이 401 을 던지고 refresh token 을 지운다', async () => {
    writeTokens({ accessToken: 'old', refreshToken: 'ref' });
    const { impl, calls } = fakeFetch((url) => (url === '/auth/refresh' ? json(401, { message: 'bad refresh' }) : json(401, { message: 'expired' })));
    await expect(request('GET', '/users/me', undefined, impl)).rejects.toMatchObject({ status: 401 });
    expect(calls.map((c) => c.url)).toEqual(['/users/me', '/auth/refresh']);
    expect(readRefreshToken()).toBeNull();
    expect(readToken()).toBe('old');
  });

  it('refresh 는 성공했지만 재시도도 401 이면 더 재시도하지 않는다', async () => {
    writeTokens({ accessToken: 'old', refreshToken: 'ref' });
    const { impl, calls } = fakeFetch((url) => (url === '/auth/refresh' ? json(200, { access_token: 'new', refresh_token: 'ref2' }) : json(401, { message: 'still' })));
    await expect(request('GET', '/users/me', undefined, impl)).rejects.toBeInstanceOf(ApiError);
    expect(calls.map((c) => c.url)).toEqual(['/users/me', '/auth/refresh', '/users/me']);
  });

  it('동시에 여러 요청이 401 이어도 refresh 는 한 번만 부른다 (single-flight)', async () => {
    writeTokens({ accessToken: 'old', refreshToken: 'ref' });
    let refreshCalls = 0;
    const { impl } = fakeFetch(async (url, init) => {
      if (url === '/auth/refresh') {
        refreshCalls++;
        await new Promise((r) => setTimeout(r, 20));
        return json(200, { access_token: 'new', refresh_token: 'ref2' });
      }
      const auth = (init?.headers as Record<string, string>).Authorization;
      return auth === 'Bearer new' ? json(200, { ok: true }) : json(401, { message: 'expired' });
    });
    const results = await Promise.all([request('GET', '/a', undefined, impl), request('GET', '/b', undefined, impl), request('GET', '/c', undefined, impl)]);
    expect(results).toHaveLength(3);
    expect(refreshCalls).toBe(1);
  });

  it('refresh 응답에 access_token 이 없으면 실패로 본다', async () => {
    writeTokens({ accessToken: 'old', refreshToken: 'ref' });
    const { impl } = fakeFetch(() => json(200, { nope: true }));
    expect(await refreshAccessToken(impl)).toBe(false);
    expect(readRefreshToken()).toBeNull();
  });

  it('네트워크 오류면 refresh 실패이고 refresh token 은 유지한다', async () => {
    writeTokens({ accessToken: 'old', refreshToken: 'ref' });
    const impl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(await refreshAccessToken(impl)).toBe(false);
    expect(readRefreshToken()).toBe('ref');
  });
});
