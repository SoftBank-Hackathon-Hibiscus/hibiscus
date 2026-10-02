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
  const proxy = Object.fromEntries(
    proxiedPrefixes.map((prefix) => [
      prefix,
      { target, changeOrigin: false, secure: false },
    ]),
  );
  return {
    plugins: [react()],
    server: { port: 5173, proxy },
    preview: { port: 4173, proxy },
  };
});
