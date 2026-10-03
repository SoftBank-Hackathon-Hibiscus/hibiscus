// 토큰 보관. localStorage 가 막힌 환경에서도 화면은 떠야 해서 메모리 값으로 대체한다.
// refresh token 은 access token 과 같이 저장되고, 토큰을 지우면(로그아웃) 함께 지워진다.

const ACCESS_KEY = 'hibiscus.accessToken';
const REFRESH_KEY = 'hibiscus.refreshToken';

let memoryAccess: string | null = null;
let memoryRefresh: string | null = null;

function readItem(key: string, fallback: string | null): string | null {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeItem(key: string, value: string | null): void {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // localStorage 를 쓸 수 없으면 메모리 값만 유지
  }
}

export function readToken(): string | null {
  return readItem(ACCESS_KEY, memoryAccess);
}

export function readRefreshToken(): string | null {
  return readItem(REFRESH_KEY, memoryRefresh);
}

/** access 만 바꾼다. refresh 는 그대로 둔다 (refresh 갱신 응답은 writeTokens 로). */
export function writeToken(token: string | null): void {
  memoryAccess = token ? token.trim() : null;
  writeItem(ACCESS_KEY, memoryAccess);
  if (!token) {
    memoryRefresh = null;
    writeItem(REFRESH_KEY, null);
  }
}

export function writeTokens(tokens: { accessToken: string; refreshToken: string | null }): void {
  memoryAccess = tokens.accessToken.trim();
  memoryRefresh = tokens.refreshToken ? tokens.refreshToken.trim() : null;
  writeItem(ACCESS_KEY, memoryAccess);
  writeItem(REFRESH_KEY, memoryRefresh);
}

export function clearRefreshToken(): void {
  memoryRefresh = null;
  writeItem(REFRESH_KEY, null);
}

export type ParsedTokens = { ok: true; accessToken: string; refreshToken: string | null } | { ok: false; reason: 'empty' | 'invalid_json' | 'no_access_token' };

/**
 * 붙여넣은 값에서 토큰을 꺼낸다.
 * - `abc` → access 만
 * - `Bearer abc` → 접두어를 뗀 access
 * - 콜백 JSON 전체 `{"access_token":"abc","refresh_token":"ref",...}` → access + refresh
 * JSON 객체처럼 보이는데 깨졌거나 access_token 이 없으면 저장하지 않는다.
 */
export function parsePastedToken(input: string): ParsedTokens {
  const text = input.trim();
  if (!text) return { ok: false, reason: 'empty' };
  if (text.startsWith('{')) {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return { ok: false, reason: 'invalid_json' };
    }
    if (!body || typeof body !== 'object') return { ok: false, reason: 'invalid_json' };
    const record = body as { access_token?: unknown; refresh_token?: unknown };
    if (typeof record.access_token !== 'string' || !record.access_token.trim()) return { ok: false, reason: 'no_access_token' };
    return {
      ok: true,
      accessToken: record.access_token.trim(),
      refreshToken: typeof record.refresh_token === 'string' && record.refresh_token.trim() ? record.refresh_token.trim() : null,
    };
  }
  const access = text.replace(/^Bearer\b\s*/i, '').trim();
  if (!access) return { ok: false, reason: 'empty' };
  return { ok: true, accessToken: access, refreshToken: null };
}
