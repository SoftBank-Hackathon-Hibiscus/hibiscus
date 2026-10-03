/// <reference types="vitest/config" />
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// 백엔드(backend-v2)는 CORS를 켜지 않으므로 개발 서버가 같은 origin에서 프록시한다.
// 백엔드 주소는 .env.local 의 VITE_BACKEND_URL 로 바꾼다 (기본 http://127.0.0.1:8080).
const proxiedPrefixes = [
  '/auth',
  '/applications',
  '/deployments',
  '/agents',
  '/users',
  '/healthz',
];

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target = env.VITE_BACKEND_URL || 'http://127.0.0.1:8080';
  // 팀 VM 처럼 다른 호스트로 보낼 때는 Host 헤더를 대상 주소로 바꿔야 그쪽 리버스 프록시가 받는다.
  // 로컬(127.0.0.1/localhost)은 그대로 둔다 (Gateway 미들웨어가 Host 로 앱을 찾는데, 로컬 Host 는 어떤 앱과도 겹치지 않는다).
  const local = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(target);
  const proxy = Object.fromEntries(
    proxiedPrefixes.map((prefix) => [
      prefix,
      { target, changeOrigin: !local, secure: true },
    ]),
  );
  return {
    plugins: [react()],
    server: { port: 5173, proxy },
    preview: { port: 4173, proxy },
    test: { environment: 'node', include: ['src/**/*.test.ts'] },
  };
});
