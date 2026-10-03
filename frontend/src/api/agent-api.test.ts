import { describe, expect, it, vi } from 'vitest';
import { RealDataSource } from './real';

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('Agent management API', () => {
  it('목록과 상태는 관리 API 경로를 호출한다', async () => {
    const fetchImpl = vi.fn(async (path: string) => json(path === '/agents' ? [] : { agent_id: 'agent-1', status: 'online' }));
    const source = new RealDataSource(fetchImpl);

    await source.listAgents();
    await source.getAgentStatus('agent-1');

    expect(fetchImpl.mock.calls.map(([path]) => path)).toEqual(['/agents', '/agents/agent-1/status']);
  });

  it('등록, Token 재발급, SSH 등록, 폐기는 정확한 method와 body를 사용한다', async () => {
    const calls: Array<{ path: string; method: string; body?: string }> = [];
    const fetchImpl = vi.fn(async (path: string, init?: RequestInit) => {
      calls.push({ path, method: String(init?.method), body: typeof init?.body === 'string' ? init.body : undefined });
      return json({});
    });
    const source = new RealDataSource(fetchImpl);

    await source.createAgent('office-mac-mini');
    await source.rotateAgentToken('agent-1');
    await source.createAgentSshEnrollment('agent-1');
    await source.revokeAgentToken('agent-1');

    expect(calls).toEqual([
      { path: '/agents', method: 'POST', body: JSON.stringify({ name: 'office-mac-mini' }) },
      { path: '/agents/agent-1/token/rotate', method: 'POST', body: JSON.stringify({}) },
      { path: '/agents/agent-1/ssh/enrollment', method: 'POST', body: JSON.stringify({}) },
      { path: '/agents/agent-1/token', method: 'DELETE', body: undefined },
    ]);
  });
});
