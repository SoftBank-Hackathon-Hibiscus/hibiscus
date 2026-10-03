// route 변화 감지. 이력 API 가 없어서 화면이 기억한 직전 route 와 비교한다.
// 규칙: 첫 관측은 변화 아님 / revision 이 같으면 변화 없음 / route 가 사라지면(404) 변화로 치지 않음 /
// 같은 deployment 안에서 onprem → cloud_run 으로 넘어간 것만 failover, 새 deployment 로의 전환은 일반 경로 변경.
import type { RouteSnapshot, TargetKind } from '../api/types';

export interface RouteMark {
  revision: number;
  targetId: string;
  kind: TargetKind;
  deploymentId: string;
}

export interface RouteChange {
  from: RouteMark;
  to: RouteMark;
  failover: boolean;
}

export function markOf(route: RouteSnapshot | null): RouteMark | null {
  if (!route) return null;
  return { revision: route.revision, targetId: route.target.id, kind: route.target.kind, deploymentId: route.target.deploymentId };
}

export function detectRouteChange(previous: RouteMark | null, current: RouteMark | null): RouteChange | null {
  if (!previous || !current) return null;
  if (current.revision === previous.revision) return null;
  if (current.revision < previous.revision) return null;
  return {
    from: previous,
    to: current,
    failover: previous.kind === 'onprem' && current.kind === 'cloud_run' && previous.deploymentId === current.deploymentId,
  };
}
