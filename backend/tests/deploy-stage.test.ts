import { describe, expect, it } from "vitest";
import { outcomeFromCoordinator } from "../src/stages/deploy.js";

describe("outcomeFromCoordinator: 조율기 종료 코드 → 배포 단계 결과", () => {
  it("0 activated → succeeded, 배포함", () => {
    const o = outcomeFromCoordinator(0, { decision: "activated" }, {}, "");
    expect(o.status).toBe("succeeded");
    expect(o.runPatch?.deployment_performed).toBe(true);
  });
  it("3 held → failed, 기존 유지라 배포 안 함", () => {
    const o = outcomeFromCoordinator(3, { decision: "held" }, {}, "");
    expect(o.status).toBe("failed");
    expect(o.error).toContain("held");
    expect(o.runPatch?.deployment_performed).toBe(false);
  });
  it("4 rolled_back → failed, 전환했다가 되돌림", () => {
    const o = outcomeFromCoordinator(4, { decision: "rolled_back" }, {}, "");
    expect(o.status).toBe("failed");
    expect(o.error).toContain("rolled_back");
    expect(o.runPatch?.deployment_performed).toBe(true);
  });
  it("1 오류 → failed, stderr 끝부분을 오류에 담음", () => {
    const o = outcomeFromCoordinator(1, undefined, {}, "앞줄\n[coordinator] 배포 거부: dry-run 서명");
    expect(o.status).toBe("failed");
    expect(o.error).toContain("배포 거부");
    expect(o.runPatch?.deployment_performed).toBe(false);
  });
});
