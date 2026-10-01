import {
  BadGatewayException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { AuthConfig } from '../config/configs/auth.config.js';
import { DatabaseService } from '../database/database.service.js';
import { githubCredentials } from '../database/schema.js';
import type { GithubProviderToken } from './types/github.type.js';

@Injectable()
export class GithubConnectionService {
  private readonly refreshing = new Map<string, Promise<string>>();
  constructor(
    private readonly database: DatabaseService,
    private readonly config: ConfigService<AuthConfig, true>,
  ) {}

  save(userId: string, token: GithubProviderToken) {
    const iv = randomBytes(12);
    const key = Buffer.from(
      this.config.get('auth.githubApp.tokenEncryptionKey', { infer: true }),
      'hex',
    );
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(userId));
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(token), 'utf8'),
      cipher.final(),
    ]);
    const value = {
      userId,
      encryptedToken: [iv, cipher.getAuthTag(), encrypted]
        .map((part) => part.toString('base64url'))
        .join('.'),
      expiresAt: token.expires_in ? Date.now() + token.expires_in * 1000 : null,
      updatedAt: new Date().toISOString(),
    };
    this.database.db
      .insert(githubCredentials)
      .values(value)
      .onConflictDoUpdate({ target: githubCredentials.userId, set: value })
      .run();
  }

  connected(userId: string) {
    return !!this.database.db
      .select({ id: githubCredentials.userId })
      .from(githubCredentials)
      .where(eq(githubCredentials.userId, userId))
      .get();
  }

  async accessToken(userId: string): Promise<string> {
    const row = this.database.db
      .select()
      .from(githubCredentials)
      .where(eq(githubCredentials.userId, userId))
      .get();
    if (!row)
      throw new UnauthorizedException('GitHub account must be reconnected');
    let token: GithubProviderToken;
    try {
      const [iv, tag, encrypted] = row.encryptedToken
        .split('.')
        .map((part) => Buffer.from(part, 'base64url'));
      const key = Buffer.from(
        this.config.get('auth.githubApp.tokenEncryptionKey', { infer: true }),
        'hex',
      );
      const decipher = createDecipheriv('aes-256-gcm', key, iv!);
      decipher.setAAD(Buffer.from(userId));
      decipher.setAuthTag(tag!);
      token = JSON.parse(
        Buffer.concat([decipher.update(encrypted!), decipher.final()]).toString(
          'utf8',
        ),
      ) as GithubProviderToken;
    } catch {
      throw new UnauthorizedException(
        'Cannot read GitHub credentials; log in again',
      );
    }
    if (!row.expiresAt || row.expiresAt > Date.now() + 60000)
      return token.access_token;
    if (!token.refresh_token)
      throw new UnauthorizedException(
        'GitHub connection expired; log in again',
      );
    const pending = this.refreshing.get(userId);
    if (pending) return pending;
    const promise = this.refresh(userId, token.refresh_token).finally(() =>
      this.refreshing.delete(userId),
    );
    this.refreshing.set(userId, promise);
    return promise;
  }

  private async refresh(userId: string, refreshToken: string) {
    const github = this.config.get('auth.githubApp', { infer: true });
    try {
      const response = await fetch(
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
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
          }),
          signal: AbortSignal.timeout(10000),
        },
      );
      if (!response.ok) throw new BadGatewayException('GitHub token refresh failed');
      const token = (await response.json()) as GithubProviderToken & {
        error?: string;
      };
      if (token.error || !token.access_token)
        throw new UnauthorizedException('GitHub authorization is required');
      this.save(userId, token);
      return token.access_token;
    } catch (error) {
      if (
        error instanceof UnauthorizedException ||
        error instanceof BadGatewayException
      )
        throw error;
      throw new BadGatewayException('Cannot connect to GitHub');
    }
  }
}
