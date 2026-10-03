import type { ConfigService } from '@nestjs/config';
import type { AuthConfig } from '../../config/configs/auth.config.js';
import { AuthRedirectService } from '../auth-redirect.service.js';
import type { TokenResponseDto } from '../dto/auth.dto.js';

describe('AuthRedirectService', () => {
  const tokens = {
    access_token: 'access.jwt',
    refresh_token: 'refresh.jwt',
  } as TokenResponseDto;

  it('keeps the JSON callback when a frontend URL is not configured', () => {
    expect(service('').url(tokens)).toBeUndefined();
  });

  it('puts tokens in a frontend fragment instead of a query string', () => {
    const redirect = new URL(
      service('https://hibiscus.example/app').url(tokens)!,
    );
    expect(redirect.origin + redirect.pathname).toBe(
      'https://hibiscus.example/app',
    );
    expect(redirect.search).toBe('');
    expect(redirect.hash).toBe(
      '#/auth/callback?access_token=access.jwt&refresh_token=refresh.jwt',
    );
  });

  function service(frontendUrl: string): AuthRedirectService {
    return new AuthRedirectService({
      get: () => frontendUrl,
    } as unknown as ConfigService<AuthConfig, true>);
  }
});
