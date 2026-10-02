import type { RouteSnapshot } from "../api/types";

export interface RouteMark {
  revision: number;
  targetId: string;
  kind: "onprem" | "cloud_run";
  deploymentId: string;
}

export interface RouteChange {
  from: RouteMark;
  to: RouteMark;
  // 같은 배포 안에서 On-Prem → Cloud Run 으로 옮겨 간 경우만 failover 로 판단
  failover: boolean;
}

export function markOf(route: RouteSnapshot | null): RouteMark | null {
  if (!route) return null;
  return {
    revision: route.revision,
    targetId: route.target.id,
    kind: route.target.kind,
    deploymentId: route.target.deploymentId,
  };
}

// 이력 API 가 없어서 화면이 기억한 직전 revision 과 비교. 처음 본 값은 변경으로 치지 않음
export function detectRouteChange(previous: RouteMark | null, current: RouteMark | null): RouteChange | null {
  if (!previous || !current || current.revision <= previous.revision) return null;
  return {
    from: previous,
    to: current,
    failover:
      previous.kind === "onprem" &&
      current.kind === "cloud_run" &&
      previous.deploymentId === current.deploymentId,
  };
}
