import { describe, expect, it } from 'vitest';
import { DEFAULT_BACKEND_URL, isLocalBackend, normalizeBackendUrl, oauthStartUrl } from './backendUrl';

describe('backendUrl', () => {
  it('값이 없으면 로컬 기본값', () => {
    expect(normalizeBackendUrl(undefined)).toBe(DEFAULT_BACKEND_URL);
    expect(normalizeBackendUrl('')).toBe(DEFAULT_BACKEND_URL);
    expect(normalizeBackendUrl('   ')).toBe(DEFAULT_BACKEND_URL);
  });
  it('끝 슬래시와 공백을 정리한다', () => {
    expect(normalizeBackendUrl(' https://api.hibiscus.lth.so/ ')).toBe('https://api.hibiscus.lth.so');
    expect(normalizeBackendUrl('http://127.0.0.1:8080//')).toBe('http://127.0.0.1:8080');
  });
  it('OAuth 시작 주소는 backend 호스트의 redirect endpoint', () => {
    expect(oauthStartUrl('https://api.hibiscus.lth.so')).toBe('https://api.hibiscus.lth.so/auth/github/redirect');
    expect(oauthStartUrl('http://127.0.0.1:8080/')).toBe('http://127.0.0.1:8080/auth/github/redirect');
  });
  it('로컬 backend 판정은 vite.config 와 같은 규칙', () => {
    expect(isLocalBackend('http://127.0.0.1:8080')).toBe(true);
    expect(isLocalBackend('http://localhost:8080')).toBe(true);
    expect(isLocalBackend('https://api.hibiscus.lth.so')).toBe(false);
    expect(isLocalBackend('http://localhost.example.com')).toBe(false);
  });
});
