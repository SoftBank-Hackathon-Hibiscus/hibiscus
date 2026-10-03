import { describe, expect, it, vi } from 'vitest';
import type { UpdateHealthCheckInput } from './types';
import { RealDataSource } from './real';

describe('Health Check API', () => {
  it('설정을 PATCH 요청으로 저장한다', async () => {
    const calls: Array<{ path: string; method: string; body?: string }> = [];
    const fetchImpl = vi.fn(async (path: string, init?: RequestInit) => {
      calls.push({ path, method: String(init?.method), body: typeof init?.body === 'string' ? init.body : undefined });
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const source = new RealDataSource(fetchImpl);
    const input: UpdateHealthCheckInput = {
      enabled: true,
      path: '/ready',
      version_path: '/version',
      method: 'HEAD',
      interval_seconds: 10,
      timeout_seconds: 3,
      success_status_min: 200,
      success_status_max: 399,
      success_threshold: 2,
      failure_threshold: 4,
    };

    await source.updateHealthCheck('app/1', input);

    expect(calls).toEqual([
      {
        path: '/applications/app%2F1/health-check',
        method: 'PATCH',
        body: JSON.stringify(input),
      },
    ]);
  });
});
