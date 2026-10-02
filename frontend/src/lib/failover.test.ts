import { describe, expect, it } from "vitest";
import type { RouteSnapshot } from "../api/types";
import { detectRouteChange, markOf, type RouteMark } from "./failover";

const mark = (patch: Partial<RouteMark>): RouteMark => ({
  revision: 1,
  targetId: "t-onprem",
  kind: "onprem",
  deploymentId: "d1",
  ...patch,
});

describe("detectRouteChange", () => {
  it("처음 본 값은 변경으로 치지 않음", () => {
    expect(detectRouteChange(null, mark({}))).toBeNull();
  });

  it("revision 이 같으면 변경 없음", () => {
    expect(detectRouteChange(mark({}), mark({}))).toBeNull();
  });

  it("같은 배포에서 On-Prem → Cloud Run 이면 failover", () => {
    const change = detectRouteChange(mark({}), mark({ revision: 2, targetId: "t-cloud", kind: "cloud_run" }));
    expect(change?.failover).toBe(true);
    expect(change?.from.revision).toBe(1);
    expect(change?.to.revision).toBe(2);
  });

  it("새 배포로 전환된 것은 failover 가 아님", () => {
    const change = detectRouteChange(mark({}), mark({ revision: 2, targetId: "t2", deploymentId: "d2" }));
    expect(change).not.toBeNull();
    expect(change?.failover).toBe(false);
  });

  it("경로가 사라지면(null) 변경으로 치지 않음", () => {
    expect(detectRouteChange(mark({}), null)).toBeNull();
  });
});

describe("markOf", () => {
  it("404(null) 는 null", () => {
    expect(markOf(null)).toBeNull();
  });

  it("route 에서 revision·대상 종류·배포를 꺼냄", () => {
    const route = {
      applicationId: "a1",
      revision: 3,
      health: null,
      target: { id: "t1", kind: "cloud_run", deploymentId: "d9" },
    } as RouteSnapshot;
    expect(markOf(route)).toEqual({ revision: 3, targetId: "t1", kind: "cloud_run", deploymentId: "d9" });
  });
});
