import { authEnvironmentSchema } from '../configs/auth.config.js';

describe('auth environment validation', () => {
  const configured = {
    GITHUB_APP_CLIENT_ID: 'Iv1.test-client',
    GITHUB_APP_CLIENT_SECRET: 'test-client-secret',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    JWT_REFRESH_SECRET: 'b'.repeat(32),
  };

  it('accepts configured credentials and applies defaults', () => {
    expect(authEnvironmentSchema.parse(configured)).toMatchObject({
      ...configured,
      GITHUB_APP_CALLBACK_URL: 'http://localhost:8080/auth/github/callback',
      JWT_ACCESS_TTL_SECONDS: 900,
      JWT_REFRESH_TTL_SECONDS: 604800,
    });
  });

  it.each(['GITHUB_APP_CLIENT_ID', 'GITHUB_APP_CLIENT_SECRET'] as const)(
    'rejects missing or blank %s at startup',
    (key) => {
      for (const value of [undefined, '', '   ']) {
        const result = authEnvironmentSchema.safeParse({
          ...configured,
          [key]: value,
        });
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues[0]?.path).toEqual([key]);
          expect(result.error.issues[0]?.message).not.toMatch(/[가-힣]/);
        }
      }
    },
  );

  it('returns an English error for identical signing keys', () => {
    const result = authEnvironmentSchema.safeParse({
      ...configured,
      JWT_REFRESH_SECRET: configured.JWT_ACCESS_SECRET,
    });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues[0]?.message).toBe(
        'Access and refresh signing keys must differ',
      );
  });
});
