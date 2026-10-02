const STORAGE_KEY = 'hibiscus.accessToken';

export function readToken(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function writeToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(STORAGE_KEY, token.trim());
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // localStorage 를 쓸 수 없으면 세션 동안만 메모리에 두는 대신 조용히 무시한다
  }
}
