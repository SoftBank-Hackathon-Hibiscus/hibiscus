import type { Request } from 'express';
import type { User } from '../../database/schema.js';

export const PUBLIC_ROUTE = 'auth.public';
export const OAUTH_COOKIE = 'hibiscus_oauth';
export const OAUTH_COOKIE_PATH = '/auth/github';
export const OAUTH_TTL_SECONDS = 600;

export interface AuthenticatedRequest extends Request {
  user: User;
}

export type GithubTokenResponse =
  | {
      access_token: string;
      token_type: string;
      expires_in?: number;
      refresh_token?: string;
      refresh_token_expires_in?: number;
    }
  | { error: string; error_description?: string };

export interface OAuthStateClaims {
  kind: 'oauth-state';
  state: string;
  verifier: string;
  exp: number;
}

export interface TokenClaims {
  sub: string;
  kind: 'access' | 'refresh';
  exp: number;
}
