import { writeTokens } from './token';

const CALLBACK_PREFIX = '#/auth/callback?';

export function readAuthCallback(hash: string): { accessToken: string; refreshToken: string } | undefined {
  if (!hash.startsWith(CALLBACK_PREFIX)) return undefined;
  const parameters = new URLSearchParams(hash.slice(CALLBACK_PREFIX.length));
  const accessToken = parameters.get('access_token')?.trim();
  const refreshToken = parameters.get('refresh_token')?.trim();
  if (!accessToken || !refreshToken) return undefined;
  return { accessToken, refreshToken };
}

/** React 실행 전에 토큰을 저장하고 민감한 Fragment를 현재 History에서 제거한다. */
export function consumeAuthCallback(): boolean {
  const tokens = readAuthCallback(window.location.hash);
  if (!tokens) return false;
  writeTokens(tokens);
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/connect`);
  return true;
}
