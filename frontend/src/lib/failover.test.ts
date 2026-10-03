import { describe, expect, it } from 'vitest';
import type { RouteSnapshot } from '../api/types';
import { detectRouteChange, markOf, type RouteMark } from './failover';

const mark = (patch: Partial<RouteMark> = {}): RouteMark => ({ revision: 1, targetId: 't-onprem', kind: 'onprem', deploymentId: 'd1', ...patch });

describe('detectRouteChange', () => {
  it('첫 관측은 변화로 치지 않는다', () => {
    expect(detectRouteChange(null, mark())).toBeNull();
  });

  it('revision 이 같으면 변화 없음', () => {
    expect(detectRouteChange(mark(), mark())).toBeNull();
  });

  it('revision 이 줄어든 값은 변화로 치지 않는다', () => {
    expect(detectRouteChange(mark({ revision: 3 }), mark({ revision: 2 }))).toBeNull();
  });

  it('같은 deployment 에서 onprem → cloud_run 이면 failover', () => {
    const change = detectRouteChange(mark(), mark({ revision: 2, targetId: 't-cloud', kind: 'cloud_run' }));
    expect(change?.failover).toBe(true);
    expect(change?.from.revision).toBe(1);
    expect(change?.to.revision).toBe(2);
  });

  it('새 deployment 로 넘어간 것은 failover 가 아닌 일반 경로 변경', () => {
    const change = detectRouteChange(mark(), mark({ revision: 2, targetId: 't2', deploymentId: 'd2' }));
    expect(change).not.toBeNull();
    expect(change?.failover).toBe(false);
  });

  it('cloud_run → onprem 복귀는 failover 가 아니다', () => {
    const change = detectRouteChange(mark({ kind: 'cloud_run', targetId: 't-cloud' }), mark({ revision: 2 }));
    expect(change?.failover).toBe(false);
  });

  it('route 가 사라지면(404) 변화로 치지 않는다', () => {
    expect(detectRouteChange(mark(), null)).toBeNull();
  });
});

describe('markOf', () => {
  it('404(null) 는 null', () => {
    expect(markOf(null)).toBeNull();
  });

  it('route 에서 revision·대상·deployment 를 꺼낸다', () => {
    const route = { applicationId: 'a1', revision: 3, health: null, target: { id: 't1', kind: 'cloud_run', deploymentId: 'd9' } } as RouteSnapshot;
    expect(markOf(route)).toEqual({ revision: 3, targetId: 't1', kind: 'cloud_run', deploymentId: 'd9' });
  });
});
