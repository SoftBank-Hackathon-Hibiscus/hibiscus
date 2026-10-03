// 브라우저가 직접 열어야 하는 backend 주소 (OAuth 시작). API 호출은 여전히 같은 origin 의 Vite 프록시를 쓴다.
// OAuth state 쿠키는 backend 호스트에 붙으므로, 로그인 시작은 프록시(5173)가 아니라 backend 주소에서 해야 콜백이 401 이 아니다.

export const DEFAULT_BACKEND_URL = 'http://127.0.0.1:8080';

/** 빈 값·공백·끝 슬래시를 정리한다. 값이 없으면 로컬 기본값. */
export function normalizeBackendUrl(raw: string | undefined | null): string {
  const value = (raw ?? '').trim().replace(/\/+$/, '');
  return value || DEFAULT_BACKEND_URL;
}

/** .env.local 의 VITE_BACKEND_URL (vite.config 의 프록시 대상과 같은 값). */
export function backendBaseUrl(): string {
  return normalizeBackendUrl(import.meta.env.VITE_BACKEND_URL as string | undefined);
}

/** OAuth state Cookie를 Backend 호스트에 설정한 뒤 GitHub로 이동한다. */
export function oauthStartUrl(base: string = backendBaseUrl()): string {
  return `${normalizeBackendUrl(base)}/auth/github/redirect`;
}

export function isLocalBackend(base: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(base);
}
