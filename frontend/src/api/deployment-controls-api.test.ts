import { describe, expect, it, vi } from 'vitest';
import { RealDataSource } from './real';

describe('deployment control API', () => {
  it('posts cancel and rollback with encoded deployment identifiers', async () => {
    const fetchImpl = vi.fn(async (_path: string) => new Response(JSON.stringify({ id: 'deployment' }), { status: 201, headers: { 'Content-Type': 'application/json' } }));
    const source = new RealDataSource(fetchImpl);
    await source.cancelDeployment('a/b');
    await source.rollbackDeployment('old/version');
    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual(['/deployments/a%2Fb/cancel', '/deployments/old%2Fversion/rollback']);
  });
});
