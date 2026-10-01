import {
  BadGatewayException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import type { AuthConfig } from '../config/configs/auth.config.js';
import type { User } from '../database/schema.js';
import { UserService } from '../user/user.service.js';
import { GithubConnectionService } from '../github/github-connection.service.js';
import type { GithubProfile } from '../user/interfaces/github-profile.interface.js';
import type { GithubCallbackDto } from './dto/auth.dto.js';
import { OAUTH_COOKIE, OAUTH_TTL_SECONDS } from './types/auth.type.js';
import type {
  GithubTokenResponse,
  OAuthStateClaims,
  TokenClaims,
} from './types/auth.type.js';

@Injectable()
export class AuthService {
  constructor(
    private readonly config: ConfigService<AuthConfig, true>,
    private readonly jwt: JwtService,
    private readonly users: UserService,
    private readonly githubConnection: GithubConnectionService,
  ) {}

  get cookieSecure(): boolean {
    return (
      new URL(this.config.get('auth.githubApp.callbackUrl', { infer: true }))
        .protocol === 'https:'
    );
  }

  async startGithub() {
    const github = this.config.get('auth.githubApp', { infer: true });
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const cookie = await this.jwt.signAsync(
      { kind: 'oauth-state', state, verifier },
      {
        secret: this.config.get('auth.jwt.refreshSecret', { infer: true }),
        algorithm: 'HS256',
        issuer: this.config.get('auth.jwt.issuer', { infer: true }),
        audience: 'hibiscus-oauth-state',
        expiresIn: OAUTH_TTL_SECONDS,
      },
    );
    const url = new URL('https://github.com/login/oauth/authorize');
    url.search = new URLSearchParams({
      client_id: github.clientId,
      redirect_uri: github.callbackUrl,
      state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    }).toString();
    return { authorization_url: url.toString(), cookie };
  }

  async callback(input: GithubCallbackDto, cookieHeader?: string) {
    const github = this.config.get('auth.githubApp', { infer: true });
    const cookie = cookieHeader
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${OAUTH_COOKIE}=`))
      ?.slice(OAUTH_COOKIE.length + 1);
    let state: OAuthStateClaims;
    try {
      state = await this.jwt.verifyAsync<OAuthStateClaims>(cookie ?? '', {
        secret: this.config.get('auth.jwt.refreshSecret', { infer: true }),
        algorithms: ['HS256'],
        issuer: this.config.get('auth.jwt.issuer', { infer: true }),
        audience: 'hibiscus-oauth-state',
      });
      if (state.kind !== 'oauth-state')
        throw new Error('Invalid OAuth state purpose');
      const expected = Buffer.from(state.state);
      const received = Buffer.from(input.state);
      if (
        expected.length !== received.length ||
        !timingSafeEqual(expected, received)
      )
        throw new Error('OAuth state mismatch');
    } catch {
      throw new UnauthorizedException('OAuth state is missing or invalid');
    }

    const token = await this.githubJson<GithubTokenResponse>(
      'https://github.com/login/oauth/access_token',
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          client_id: github.clientId,
          client_secret: github.clientSecret,
          redirect_uri: github.callbackUrl,
          code: input.code,
          code_verifier: state.verifier,
        }),
      },
    );
    if ('error' in token)
      throw new UnauthorizedException(
        'GitHub authorization code exchange failed',
      );
    const profile = await this.githubJson<GithubProfile>(
      'https://api.github.com/user',
      {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token.access_token}`,
          'User-Agent': 'hibiscus-backend',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    );
    const user = this.users.upsertGithub(profile);
    this.githubConnection.save(user.id, token);
    return this.issueTokens(user);
  }

  async issueTokens(user: User) {
    const settings = this.config.get('auth.jwt', { infer: true });
    const sign = (
      kind: 'access' | 'refresh',
      secret: string,
      expiresIn: number,
    ) =>
      this.jwt.signAsync(
        { sub: user.id, kind },
        {
          secret,
          algorithm: 'HS256',
          issuer: settings.issuer,
          audience: `hibiscus-${kind}`,
          jwtid: randomUUID(),
          expiresIn,
        },
      );
    const [accessToken, refreshToken] = await Promise.all([
      sign('access', settings.accessSecret, settings.accessTtlSeconds),
      sign('refresh', settings.refreshSecret, settings.refreshTtlSeconds),
    ]);
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: settings.accessTtlSeconds,
      refresh_expires_in: settings.refreshTtlSeconds,
      user,
    };
  }

  async refresh(token: string) {
    return this.issueTokens(await this.verifyToken(token, 'refresh'));
  }

  async verifyToken(token: string, kind: 'access' | 'refresh'): Promise<User> {
    try {
      const settings = this.config.get('auth.jwt', { infer: true });
      const claims = await this.jwt.verifyAsync<TokenClaims>(token, {
        secret:
          kind === 'access' ? settings.accessSecret : settings.refreshSecret,
        algorithms: ['HS256'],
        issuer: settings.issuer,
        audience: `hibiscus-${kind}`,
      });
      if (claims.kind !== kind) throw new Error('Invalid token claims');
      const user = this.users.find(claims.sub);
      if (!user) throw new Error('User not found');
      return user;
    } catch {
      throw new UnauthorizedException('Token is missing, expired, or invalid');
    }
  }

  private async githubJson<T>(url: string, init: RequestInit): Promise<T> {
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403)
          throw new UnauthorizedException('GitHub authentication rejected');
        throw new BadGatewayException('GitHub request failed');
      }
      return (await response.json()) as T;
    } catch (error) {
      if (
        error instanceof UnauthorizedException ||
        error instanceof BadGatewayException
      )
        throw error;
      throw new BadGatewayException('Unable to connect to GitHub');
    }
  }
}
