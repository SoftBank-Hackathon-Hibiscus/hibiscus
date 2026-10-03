import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AuthConfig } from '../config/configs/auth.config.js';
import type { TokenResponseDto } from './dto/auth.dto.js';

@Injectable()
export class AuthRedirectService {
  constructor(private readonly config: ConfigService<AuthConfig, true>) {}

  url(tokens: TokenResponseDto): string | undefined {
    const frontend = this.config.get('auth.githubApp.frontendUrl', {
      infer: true,
    });
    if (!frontend) return undefined;
    const target = new URL(frontend);
    const parameters = new URLSearchParams({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
    });
    target.hash = `/auth/callback?${parameters.toString()}`;
    return target.toString();
  }
}
