import { describe, expect, it } from 'vitest';
import { readAuthCallback } from './auth-callback';

describe('readAuthCallback', () => {
  it('reads access and refresh tokens from the callback fragment', () => {
    expect(readAuthCallback('#/auth/callback?access_token=access.jwt&refresh_token=refresh.jwt')).toEqual({ accessToken: 'access.jwt', refreshToken: 'refresh.jwt' });
  });

  it('ignores unrelated or incomplete fragments', () => {
    expect(readAuthCallback('#/connect')).toBeUndefined();
    expect(readAuthCallback('#/auth/callback?access_token=access.jwt')).toBeUndefined();
  });
});
